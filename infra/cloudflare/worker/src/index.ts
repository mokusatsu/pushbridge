import { cleanupExpiredMetadata } from "./cleanup";
import { createRouter } from "./router";
import { createRuntime } from "./runtime";
import type { Env, Runtime } from "./types";
export { UserHub } from "./user-hub";

export function createWorker(overrides: Partial<Runtime> = {}): ExportedHandler<Env> {
  const runtime = createRuntime(overrides);
  const route = createRouter(runtime);
  return {
    fetch(request, env) {
      return route(request, env);
    },
    scheduled(_controller, env, ctx) {
      ctx.waitUntil(cleanupExpiredMetadata(env, runtime));
    },
    queue(batch) {
      for (const message of batch.messages) message.ack();
    },
  };
}

export default createWorker();
