import { json } from "./response";
import type { Env } from "./types";

export class UserHub {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    void this.state;
    void this.env;
  }

  async fetch(): Promise<Response> {
    return json({ error: "not_implemented" }, { status: 501 });
  }
}
