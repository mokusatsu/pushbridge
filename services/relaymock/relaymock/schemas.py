from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, Union

from pydantic import (
    AnyUrl,
    BaseModel,
    ConfigDict,
    Field,
    GetJsonSchemaHandler,
    HttpUrl,
    RootModel,
    model_validator,
)
from pydantic.json_schema import JsonSchemaValue
from pydantic_core import CoreSchema


DeviceKind = Literal["browser_extension", "pwa", "web", "test"]
PushType = Literal["note", "link", "file"]
FileState = Literal["pending", "uploaded", "ready", "expired", "deleted"]
FileDeleteReason = Literal["retention_expired", "storage_pressure", "user_deleted"]
PushStatus = Literal["active", "dismissed", "deleted", "expired"]
UriReference = Annotated[
    str,
    Field(min_length=1, json_schema_extra={"format": "uri-reference"}),
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ApiErrorDetail(StrictModel):
    code: str
    message: str
    request_id: str | None = None


class ApiError(StrictModel):
    detail: ApiErrorDetail


class DeviceOut(StrictModel):
    id: str
    user_id: str
    kind: str
    name: str
    public_key: str | None
    created_at: datetime
    last_seen_at: datetime
    revoked_at: datetime | None
    is_current: bool = False


class UserOut(StrictModel):
    id: str
    handle: str
    created_at: datetime


class BootstrapIn(StrictModel):
    handle: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    device_name: str = Field(min_length=1, max_length=100)
    device_kind: DeviceKind = "web"
    public_key: str | None = Field(default=None, max_length=8192)
    turnstile_token: str | None = Field(default=None, max_length=2048)


class BootstrapOut(StrictModel):
    user: UserOut
    device: DeviceOut
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_at: datetime


class LinkDeviceIn(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    kind: DeviceKind
    public_key: str | None = Field(default=None, max_length=8192)


class LinkDeviceOut(StrictModel):
    device: DeviceOut
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_at: datetime


class DevicePatch(StrictModel):
    name: str = Field(min_length=1, max_length=100)


class AllOtherDevicesTarget(StrictModel):
    kind: Literal["all_other_devices"]
    device_id: None = None


class AllDevicesTarget(StrictModel):
    kind: Literal["all_devices"]
    device_id: None = None


class DeviceTarget(StrictModel):
    kind: Literal["device"]
    device_id: str = Field(min_length=1)


_TargetVariant = Annotated[
    Union[AllOtherDevicesTarget, AllDevicesTarget, DeviceTarget],
    Field(discriminator="kind"),
]


class PushTarget(RootModel[_TargetVariant]):
    """Named discriminated union used by both requests and responses."""

    @property
    def kind(self) -> Literal["all_other_devices", "all_devices", "device"]:
        return self.root.kind

    @property
    def device_id(self) -> str | None:
        return self.root.device_id

    @classmethod
    def all_other_devices(cls) -> "PushTarget":
        return cls(root=AllOtherDevicesTarget(kind="all_other_devices"))


class NotePayloadV1(StrictModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "anyOf": [
                {"required": ["title"]},
                {"required": ["body"]},
            ]
        },
    )

    title: str = Field(default_factory=lambda: None, max_length=500)  # type: ignore[arg-type]
    body: str = Field(default_factory=lambda: None, max_length=100_000)  # type: ignore[arg-type]

    @model_validator(mode="after")
    def require_title_or_body(self) -> "NotePayloadV1":
        if self.title is None and self.body is None:
            raise ValueError("note payload requires title or body")
        return self


class LinkPayloadV1(StrictModel):
    url: AnyUrl
    title: str = Field(default_factory=lambda: None, max_length=500)  # type: ignore[arg-type]
    body: str = Field(default_factory=lambda: None, max_length=100_000)  # type: ignore[arg-type]


class FileDescriptorV1(StrictModel):
    name: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=200)
    size: int = Field(ge=0)
    sha256: str | None = Field(default=None, pattern=r"^[A-Fa-f0-9]{64}$")
    expires_at: datetime | None = None


class FilePayloadV1(StrictModel):
    title: str = Field(default_factory=lambda: None, max_length=500)  # type: ignore[arg-type]
    body: str = Field(default_factory=lambda: None, max_length=100_000)  # type: ignore[arg-type]
    file: FileDescriptorV1


PayloadV1 = NotePayloadV1 | LinkPayloadV1 | FilePayloadV1


class _PushCreateCommon(StrictModel):
    target: PushTarget = Field(default_factory=PushTarget.all_other_devices)
    payload_version: Literal[1] = 1
    client_guid: str | None = Field(default=None, min_length=1, max_length=200)
    expires_in: int | None = Field(default=None, ge=1, le=365 * 24 * 60 * 60)


class NotePlainPushCreate(_PushCreateCommon):
    type: Literal["note"]
    file_id: None = None
    payload: NotePayloadV1
    ciphertext: None = None
    nonce: None = None


class NoteEncryptedPushCreate(_PushCreateCommon):
    type: Literal["note"]
    file_id: None = None
    payload: None = None
    ciphertext: str = Field(min_length=1, max_length=2_000_000)
    nonce: str = Field(min_length=1, max_length=1024)


class LinkPlainPushCreate(_PushCreateCommon):
    type: Literal["link"]
    file_id: None = None
    payload: LinkPayloadV1
    ciphertext: None = None
    nonce: None = None


class LinkEncryptedPushCreate(_PushCreateCommon):
    type: Literal["link"]
    file_id: None = None
    payload: None = None
    ciphertext: str = Field(min_length=1, max_length=2_000_000)
    nonce: str = Field(min_length=1, max_length=1024)


class FilePlainPushCreate(_PushCreateCommon):
    type: Literal["file"]
    file_id: str = Field(min_length=1, max_length=200)
    payload: FilePayloadV1
    ciphertext: None = None
    nonce: None = None


class FileEncryptedPushCreate(_PushCreateCommon):
    type: Literal["file"]
    file_id: str = Field(min_length=1, max_length=200)
    payload: None = None
    ciphertext: str = Field(min_length=1, max_length=2_000_000)
    nonce: str = Field(min_length=1, max_length=1024)


_PushCreateVariant = Union[
    NotePlainPushCreate,
    NoteEncryptedPushCreate,
    LinkPlainPushCreate,
    LinkEncryptedPushCreate,
    FilePlainPushCreate,
    FileEncryptedPushCreate,
]


class PushCreate(RootModel[_PushCreateVariant]):
    """Six mutually exclusive request shapes represented as OpenAPI ``oneOf``."""

    @classmethod
    def __get_pydantic_json_schema__(
        cls, core_schema: CoreSchema, handler: GetJsonSchemaHandler
    ) -> JsonSchemaValue:
        schema = handler(core_schema)
        if "anyOf" in schema:
            schema["oneOf"] = schema.pop("anyOf")
        return schema

    @property
    def target(self) -> PushTarget:
        return self.root.target

    @property
    def type(self) -> PushType:
        return self.root.type

    @property
    def file_id(self) -> str | None:
        return self.root.file_id

    @property
    def payload_version(self) -> int:
        return self.root.payload_version

    @property
    def payload(self) -> PayloadV1 | None:
        return self.root.payload

    @property
    def ciphertext(self) -> str | None:
        return self.root.ciphertext

    @property
    def nonce(self) -> str | None:
        return self.root.nonce

    @property
    def client_guid(self) -> str | None:
        return self.root.client_guid

    @property
    def expires_in(self) -> int | None:
        return self.root.expires_in


class PushPatch(StrictModel):
    dismissed: bool | None = None
    pinned: bool | None = None

    @model_validator(mode="after")
    def require_change(self) -> "PushPatch":
        if self.dismissed is None and self.pinned is None:
            raise ValueError("at least one field must be supplied")
        return self


class FileRef(StrictModel):
    id: str
    state: FileState
    size: int = Field(ge=0)
    expires_at: datetime
    deleted_at: datetime | None = None
    delete_reason: FileDeleteReason | None = None
    alias_expires_at: datetime | None = None


class PushOut(StrictModel):
    id: str
    user_id: str
    source_device_id: str
    target: PushTarget
    type: PushType
    file_id: str | None
    file_ref: FileRef | None
    payload_version: int
    payload: PayloadV1 | None
    ciphertext: str | None
    nonce: str | None
    client_guid: str
    pinned: bool
    status: PushStatus
    created_at: datetime
    modified_at: datetime
    expires_at: datetime | None
    expired_at: datetime | None
    dismissed_at: datetime | None
    deleted_at: datetime | None
    is_for_current_device: bool


class PushListOut(StrictModel):
    items: list[PushOut]
    next_cursor: str | None
    has_more: bool


class FileInitIn(StrictModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(
        default="application/octet-stream", min_length=1, max_length=200
    )
    size: int = Field(ge=0)
    sha256: str | None = Field(default=None, pattern=r"^[A-Fa-f0-9]{64}$")
    expires_in: int | None = Field(default=None, ge=1, le=30 * 24 * 60 * 60)


class FileOut(StrictModel):
    id: str
    original_name: str
    content_type: str
    expected_size: int
    actual_size: int | None
    expected_sha256: str | None
    actual_sha256: str | None
    state: FileState
    created_at: datetime
    completed_at: datetime | None
    expires_at: datetime
    deleted_at: datetime | None
    delete_reason: FileDeleteReason | None = None
    alias_expires_at: datetime | None = None


class FileInitOut(StrictModel):
    file: FileOut
    upload_url: UriReference
    upload_method: Literal["PUT"] = "PUT"
    upload_expires_at: datetime
    upload_headers: dict[str, str]


class DownloadTicketOut(StrictModel):
    file_id: str
    download_url: UriReference
    expires_at: datetime


class SubscriptionIn(StrictModel):
    endpoint: HttpUrl
    p256dh: str = Field(min_length=1, max_length=4096)
    auth: str = Field(min_length=1, max_length=4096)
    storage_namespace: str | None = Field(default=None, min_length=1, max_length=200)
    local_cache_max_bytes: int | None = Field(default=None, ge=0)


class SubscriptionOut(StrictModel):
    id: str
    device_id: str
    endpoint: str = Field(json_schema_extra={"format": "uri"})
    created_at: datetime
    revoked_at: datetime | None


class WebPushConfigOut(StrictModel):
    subscription_registration: bool
    delivery: bool
    vapid_public_key: str


class CapabilityFeatures(StrictModel):
    realtime: bool
    web_push_delivery: bool
    web_push_subscription_registration: bool
    e2ee: bool
    direct_upload: bool
    device_registration: bool


class CapabilityLimits(StrictModel):
    max_file_bytes: int = Field(ge=0)
    max_push_payload_bytes: int = Field(ge=0)
    file_ttl_seconds: list[int]
    default_push_ttl_seconds: int = Field(ge=1)
    default_file_ttl_seconds: int = Field(ge=1)
    file_alias_ttl_seconds: int = Field(ge=1)
    max_devices: int = Field(ge=1)


class CapabilityTransports(StrictModel):
    realtime: list[Literal["poll", "websocket"]]
    upload: list[Literal["server-ticket", "presigned-url"]]


class SystemCapabilitiesOut(StrictModel):
    api_version: str
    environment_id: str
    features: CapabilityFeatures
    limits: CapabilityLimits
    transports: CapabilityTransports
    recommended_poll_interval_seconds: int = Field(ge=1)


class StorageUsageOut(StrictModel):
    used_bytes: int = Field(ge=0)
    reserved_bytes: int = Field(ge=0)
    quota_bytes: int = Field(gt=0)
    reclaimable_bytes: int = Field(ge=0)
    pressure: Literal["normal", "notice", "constrained", "emergency"]
    policy_id: str
    default_retention_days: int = Field(ge=1)
    early_eviction_possible: bool


class StatsOut(StrictModel):
    users: int
    devices: int
    active_sessions: int
    pushes: int
    files: int
    stored_bytes: int
    subscriptions: int
