import { describe, expect, it } from "vitest";
import { directR2Enabled, presignR2 } from "../src/r2-presign";
import type { Env } from "../src/types";

const configured = {
  R2_DIRECT_UPLOAD: "true",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET_NAME: "pushbridge-dev-files",
  R2_S3_ACCESS_KEY_ID: "R2TESTACCESSKEY123456",
  R2_S3_SECRET_ACCESS_KEY: "r2-test-secret-access-key-0123456789abcdef",
} as Env;

describe("R2 SigV4 presigning", () => {
  it("matches an independently generated fixed PUT vector", async () => {
    const result = await presignR2(configured, {
      method: "PUT",
      key: "ttl/30d/usr test/fil+one/object.bin",
      expiresSeconds: 120,
      now: Date.parse("2026-07-24T00:00:00Z"),
      headers: {
        "content-type": "application/octet-stream",
        "if-none-match": "*",
      },
    });
    const url = new URL(result.url);
    expect(url.origin).toBe("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/pushbridge-dev-files/ttl/30d/usr%20test/fil%2Bone/object.bin");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("R2TESTACCESSKEY123456/20260724/auto/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260724T000000Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host;if-none-match");
    expect(url.searchParams.get("X-Amz-Signature")).toBe("a665d9d843e522431a4d08a6ded4e3c9407b99148523b713ff477121f3efc7ab");
    expect(result.headers).toEqual({
      "content-type": "application/octet-stream",
      "if-none-match": "*",
    });
    expect(result.url).not.toContain(configured.R2_S3_SECRET_ACCESS_KEY!);
    expect(result.expiresAt).toBe(Date.parse("2026-07-24T00:02:00Z"));
  });

  it("requires complete configuration", () => {
    expect(directR2Enabled(configured)).toBe(true);
    expect(directR2Enabled({ ...configured, R2_S3_SECRET_ACCESS_KEY: undefined })).toBe(false);
  });
});
