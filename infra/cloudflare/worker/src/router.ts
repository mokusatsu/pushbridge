import { authenticate, bootstrap } from "./auth";
import { currentDevice, linkDevice, listDevices, mutateDevice } from "./devices";
import { handlePublicDeliveryRoute, listFileDeliveries } from "./deliveries";
import { handleFileRoute, handlePublicFileRoute, storageUsage } from "./files";
import { createPush, getPush, listPushes, mutatePush } from "./pushes";
import { getRequestId, json, problem } from "./response";
import { handleSubscriptionRoute, webPushConfig } from "./subscriptions";
import { capabilities, retention } from "./system";
import type { Env, Runtime } from "./types";

export function createRouter(runtime: Runtime): (request: Request, env: Env) => Promise<Response> {
  return async (request, env) => {
    const url = new URL(request.url);
    const requestId = getRequestId(request);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true, service: env.APP_NAME, environment: env.APP_ENVIRONMENT, requestId });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok", service: env.APP_NAME ?? "pushbridge", environment: env.APP_ENVIRONMENT ?? "unknown", request_id: requestId });
      }
      if (request.method === "GET" && url.pathname === "/api/bootstrap/status") {
        return json({
          ok: true,
          requestId,
          bootstrap: false,
          dev_bootstrap_enabled: env.ENABLE_DEV_BOOTSTRAP === "true" && env.APP_ENVIRONMENT !== "production",
          message: "Cloudflare application API is active.",
          bindings: { d1: Boolean(env.DB), r2: Boolean(env.FILES), durableObject: Boolean(env.USER_HUB), queue: Boolean(env.DELIVERY_QUEUE) },
          policy: { fileRetention: retention(env) },
        });
      }

      const path = url.pathname.replace(/^\/api\/v1/, "/v1");
      const publicFileResponse = await handlePublicFileRoute(request, env, requestId, url.pathname, runtime);
      if (publicFileResponse) return publicFileResponse;
      const publicDeliveryResponse = await handlePublicDeliveryRoute(request, env, requestId, path, runtime);
      if (publicDeliveryResponse) return publicDeliveryResponse;
      if (request.method === "GET" && path === "/v1/system/capabilities") return json(capabilities(env), { headers: { "x-request-id": requestId } });
      if (request.method === "GET" && path === "/v1/web-push-config") return webPushConfig(env, requestId);
      if (request.method === "POST" && path === "/v1/auth/bootstrap") return bootstrap(request, env, requestId, runtime);
      if (!path.startsWith("/v1/")) return problem(404, "not_found", "Endpoint not found.", requestId);

      const auth = await authenticate(request, env, requestId, runtime);
      if (request.method === "GET" && path === "/v1/devices") return json(await listDevices(env, auth), { headers: { "x-request-id": requestId } });
      if (request.method === "GET" && path === "/v1/devices/me") return json(await currentDevice(env, auth), { headers: { "x-request-id": requestId } });
      if (request.method === "POST" && path === "/v1/devices/link") return linkDevice(request, env, auth, requestId, runtime);
      const deviceMatch = path.match(/^\/v1\/devices\/([^/]+)$/);
      if (deviceMatch && (request.method === "PATCH" || request.method === "DELETE")) {
        return mutateDevice(request, env, auth, requestId, decodeURIComponent(deviceMatch[1]), runtime);
      }

      if (request.method === "POST" && path === "/v1/pushes") return createPush(request, env, auth, requestId, runtime);
      if (request.method === "GET" && path === "/v1/pushes") return json(await listPushes(url, env, auth, requestId), { headers: { "x-request-id": requestId } });
      const pushMatch = path.match(/^\/v1\/pushes\/([^/]+)$/);
      if (pushMatch && request.method === "GET") return getPush(env, auth, requestId, decodeURIComponent(pushMatch[1]));
      if (pushMatch && (request.method === "PATCH" || request.method === "DELETE")) {
        return mutatePush(request, env, auth, requestId, decodeURIComponent(pushMatch[1]), runtime);
      }

      if (request.method === "GET" && path === "/v1/storage/usage") return json(await storageUsage(env, auth), { headers: { "x-request-id": requestId } });
      const deliveryListMatch = path.match(/^\/v1\/files\/([^/]+)\/deliveries$/);
      if (deliveryListMatch && request.method === "GET") return listFileDeliveries(env, auth, requestId, decodeURIComponent(deliveryListMatch[1]));
      const fileResponse = await handleFileRoute(request, env, auth, requestId, path, runtime);
      if (fileResponse) return fileResponse;
      const subscriptionResponse = await handleSubscriptionRoute(request, env, auth, requestId, path, runtime);
      if (subscriptionResponse) return subscriptionResponse;
      return problem(501, "not_implemented", "This application endpoint is not implemented.", requestId);
    } catch (error) {
      if (error instanceof Response) return error;
      console.error("request failed", { requestId, error: error instanceof Error ? error.name : "unknown" });
      return problem(500, "internal_error", "The Worker encountered an internal error.", requestId);
    }
  };
}
