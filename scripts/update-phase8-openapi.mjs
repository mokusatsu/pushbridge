import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "contract/openapi.json",
  "services/relaymock/openapi.json",
  "apps/web-pwa/openapi/relaymock.openapi.json",
];

function requestIdHeader() {
  return { "X-Request-ID": { $ref: "#/components/headers/XRequestID" } };
}

for (const relative of targets) {
  const filename = path.join(root, relative);
  const document = JSON.parse(fs.readFileSync(filename, "utf8"));
  document.components.schemas.RealtimeTicketOut = {
    properties: {
      ticket: { type: "string", minLength: 1, title: "Ticket" },
      url: { type: "string", minLength: 1, format: "uri-reference", title: "Url" },
      expires_at: { type: "string", format: "date-time", title: "Expires At" },
    },
    additionalProperties: false,
    type: "object",
    required: ["ticket", "url", "expires_at"],
    title: "RealtimeTicketOut",
  };
  document.components.responses.NotImplemented = {
    description: "The selected runtime does not provide this capability.",
    headers: requestIdHeader(),
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ApiError" },
      },
    },
  };
  document.paths["/v1/realtime-ticket"] = {
    post: {
      tags: ["realtime"],
      summary: "Issue a one-time WebSocket ticket when realtime is available",
      operationId: "create_realtime_ticket_v1_realtime_ticket_post",
      security: [{ DeviceBearer: [] }, { BrowserCookie: [] }],
      responses: {
        201: {
          description: "One-time ticket issued.",
          headers: requestIdHeader(),
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RealtimeTicketOut" },
            },
          },
        },
        401: { $ref: "#/components/responses/Unauthorized" },
        501: { $ref: "#/components/responses/NotImplemented" },
      },
    },
  };
  fs.writeFileSync(filename, `${JSON.stringify(document, null, 2)}\n`);
}

console.log("updated Phase 8 realtime OpenAPI contract and consumer copies");
