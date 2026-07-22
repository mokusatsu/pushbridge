import type { Runtime } from "./types";

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `rly_${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

export function createRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    now: overrides.now ?? (() => Date.now()),
    id: overrides.id ?? ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`),
    token: overrides.token ?? randomToken,
  };
}

export function iso(epoch: number | null | undefined): string | null {
  return epoch == null ? null : new Date(Number(epoch)).toISOString();
}
