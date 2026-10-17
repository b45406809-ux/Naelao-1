import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import { app } from "./index.js";

const secret = "channel-source-validator-test-secret";
const env = { PLATFORM_SECRET: secret } as never;

async function validate(source: string, language = "typescript", token = true) {
  const internalToken = token
    ? await mintInternalToken(secret, "tenant-a")
    : "invalid";
  return app.request(
    "/internal/channel-extensions/validate-handler",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-internal-token": internalToken,
      },
      body: JSON.stringify({ source, language }),
    },
    env
  );
}

describe("channel package source validation", () => {
  it("compiles a handler with the required run export", async () => {
    const response = await validate(
      "export async function run() { return null; }"
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      valid: true,
      bytes: expect.any(Number),
    });
  });

  it("rejects missing run exports and ambient imports", async () => {
    const missingRun = await validate("export function helper() { return 1; }");
    expect(missingRun.status).toBe(400);
    expect(await missingRun.json()).toMatchObject({
      error_code: "channel_handler_source_invalid",
    });
    const importSource = await validate(
      'import fs from "node:fs"; export function run() { return fs; }'
    );
    expect(importSource.status).toBe(400);
    expect(await importSource.json()).toMatchObject({
      error_code: "channel_handler_source_invalid",
    });
  });

  it("requires an internal tenant token", async () => {
    const response = await validate(
      "export function run() {}",
      "typescript",
      false
    );
    expect(response.status).toBe(403);
  });
});
