from __future__ import annotations

from copy import deepcopy
from typing import Any

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi

from .api_contract import REQUEST_ID_HEADER


_ERROR_DESCRIPTIONS: dict[str, str] = {
    "BadRequest": "The request cursor or other syntax is invalid.",
    "Unauthorized": "Missing, expired, or revoked device token.",
    "Forbidden": "Ticket or administrative credential is invalid.",
    "NotFound": "Resource does not exist or belongs to another user.",
    "Conflict": "Current resource state prevents the operation.",
    "Gone": "File or ticket has expired.",
    "PayloadTooLarge": "File or payload exceeds the configured limit.",
    "UnprocessableContent": "Uploaded bytes fail size, digest, or state verification.",
    "InternalError": "The local mock encountered an unexpected error.",
    "InsufficientStorage": "Storage pressure prevents accepting the upload.",
}


def _api_error_schemas() -> dict[str, Any]:
    return {
        "ApiErrorDetail": {
            "type": "object",
            "additionalProperties": False,
            "required": ["code", "message"],
            "properties": {
                "code": {
                    "type": "string",
                    "examples": ["file_not_ready", "idempotency_conflict"],
                },
                "message": {"type": "string"},
                "request_id": {"type": ["string", "null"]},
            },
        },
        "ApiError": {
            "type": "object",
            "additionalProperties": False,
            "required": ["detail"],
            "properties": {
                "detail": {"$ref": "#/components/schemas/ApiErrorDetail"}
            },
        },
    }


def _common_error_responses() -> dict[str, Any]:
    responses: dict[str, Any] = {}
    for name, description in _ERROR_DESCRIPTIONS.items():
        responses[name] = {
            "description": description,
            "headers": {
                "X-Request-ID": {"$ref": "#/components/headers/XRequestID"}
            },
            "content": {
                "application/json": {
                    "schema": {"$ref": "#/components/schemas/ApiError"}
                }
            },
        }
    return responses


def _add_request_id_to_inline_responses(schema: dict[str, Any]) -> None:
    for path_item in schema.get("paths", {}).values():
        for method, operation in path_item.items():
            if method.lower() not in {
                "get",
                "put",
                "post",
                "delete",
                "patch",
                "options",
                "head",
                "trace",
            }:
                continue
            for response in operation.get("responses", {}).values():
                if "$ref" in response:
                    reference = response["$ref"]
                    response.clear()
                    response["$ref"] = reference
                    continue
                headers = response.setdefault("headers", {})
                headers.setdefault(
                    "X-Request-ID",
                    {"$ref": "#/components/headers/XRequestID"},
                )


def _require_admin_headers(schema: dict[str, Any]) -> None:
    for path in ("/v1/mock/cleanup", "/v1/mock/reset", "/v1/mock/stats"):
        path_item = schema.get("paths", {}).get(path, {})
        for operation in path_item.values():
            if not isinstance(operation, dict):
                continue
            for parameter in operation.get("parameters", []):
                if (
                    parameter.get("in") == "header"
                    and parameter.get("name", "").lower() == "x-mock-admin"
                ):
                    parameter["required"] = True
                    parameter["schema"] = {
                        "type": "string",
                        "minLength": 1,
                    }


def install_custom_openapi(app: FastAPI) -> None:
    def custom_openapi() -> dict[str, Any]:
        if app.openapi_schema:
            return app.openapi_schema

        schema = get_openapi(
            title=app.title,
            version=app.version,
            openapi_version=app.openapi_version,
            summary=app.summary,
            description=app.description,
            routes=app.routes,
            webhooks=app.webhooks.routes,
            tags=app.openapi_tags,
            servers=app.servers,
            terms_of_service=app.terms_of_service,
            contact=app.contact,
            license_info=app.license_info,
            separate_input_output_schemas=app.separate_input_output_schemas,
            external_docs=getattr(app, "external_docs", None),
        )
        components = schema.setdefault("components", {})
        schemas = components.setdefault("schemas", {})
        schemas.update(_api_error_schemas())
        headers = components.setdefault("headers", {})
        headers["XRequestID"] = deepcopy(REQUEST_ID_HEADER)
        responses = components.setdefault("responses", {})
        responses.update(_common_error_responses())

        _add_request_id_to_inline_responses(schema)
        _require_admin_headers(schema)
        app.openapi_schema = schema
        return app.openapi_schema

    app.openapi = custom_openapi  # type: ignore[method-assign]
