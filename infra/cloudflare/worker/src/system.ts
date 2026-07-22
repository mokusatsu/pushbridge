import type { Env } from "./types";
import { webPushDeliveryConfigured } from "./web-push";

export function retention(env: Env): Record<string, number> {
  try {
    return JSON.parse(env.FILE_RETENTION_POLICY ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

export function capabilities(env: Env): Record<string, unknown> {
  const policy = retention(env);
  const defaultSeconds = Number(policy.default ?? policy.default_seconds ?? policy.default_days * 86400) || 2_592_000;
  return {
    api_version: "0.2.0-worker-poc",
    environment_id: env.APP_ENVIRONMENT ?? "cloudflare-worker",
    features: {
      realtime: false,
      web_push_delivery: webPushDeliveryConfigured(env),
      web_push_subscription_registration: Boolean(env.VAPID_PUBLIC_KEY && env.WEB_PUSH_DATA_KEY),
      e2ee: false,
      direct_upload: false,
      device_registration: true,
    },
    limits: {
      max_file_bytes: 26_214_400,
      max_push_payload_bytes: 2_000_000,
      file_ttl_seconds: [86_400, 604_800, 2_592_000],
      default_push_ttl_seconds: 2_592_000,
      default_file_ttl_seconds: defaultSeconds,
      file_alias_ttl_seconds: Number(policy.alias_days) * 86400 || 15_552_000,
      max_devices: 10,
    },
    transports: { realtime: ["poll"], upload: ["server-ticket"] },
    recommended_poll_interval_seconds: 30,
  };
}
