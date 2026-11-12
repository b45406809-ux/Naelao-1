import { describe, expect, it } from "vitest";
import worker from "./index.js";

function env(environment: string, allowDevCheckouts?: string) {
  const db = {
    prepare() {
      return {
        bind() { return this; },
        async first() { return null; },
      };
    },
  };
  return {
    ENVIRONMENT: environment,
    ...(allowDevCheckouts === undefined ? {} : { ALLOW_DEV_CHECKOUTS: allowDevCheckouts }),
    PLATFORM_SECRET: "test-secret",
    PLATFORM_DB: db,
  } as never;
}

async function checkout(environment: string, allowDevCheckouts?: string) {
  return worker.fetch(new Request("https://billing.test/billing/checkout", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant-a",
      "x-naelao-user-id": "owner-a",
      "x-naelao-role": "owner",
    },
    body: JSON.stringify({ plan: "growth", success_url: "https://app.example.test/success" }),
  }), env(environment, allowDevCheckouts), {} as never);
}

describe("platform checkout fallback", () => {
  it("returns a simulated URL only for explicit local development opt-in", async () => {
    const response = await checkout("development", "true");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      checkout_url: "https://checkout.naelao.com/dev/platform-plan/growth",
      dev: true,
    });
  });

  it.each(["staging", "production"])("fails closed in %s when providers are unavailable", async (environment) => {
    const response = await checkout(environment, "true");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "checkout_provider_unavailable" });
  });

  it("fails closed in development unless the explicit switch is enabled", async () => {
    const response = await checkout("development", "false");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "checkout_provider_unavailable" });
  });
});
