import { json } from "./response";

export function webPushConfig(requestId: string): Response {
  return json({ subscription_registration: false, delivery: false, vapid_public_key: "" }, { headers: { "x-request-id": requestId } });
}

// Subscription persistence and VAPID delivery are implemented in Phase 3.
export async function handleSubscriptionRoute(): Promise<Response | null> {
  return null;
}
