import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWhatsApp, type ProductEndUserRoutesEnv } from "./product-end-user-routes.js";

function env(): ProductEndUserRoutesEnv {
  return {
    PLATFORM_SECRET: "secret",
    PLATFORM_DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => ({ config_json: '{"compliance":{"airGappedOnly":true}}' })),
        })),
      })),
    } as unknown as D1Database,
    PRODUCT_USER_DO: {} as DurableObjectNamespace,
    SPACE_TYPE_REGISTRY_DO: {} as DurableObjectNamespace,
    NAELAO_CONFIG_KV: {} as KVNamespace,
  };
}

describe("product WhatsApp air-gap boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not contact Twilio or Meta for an air-gapped product", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const delivered = await sendWhatsApp(env(), "product-space", "+27821234567", "code");
    expect(delivered).toBe(false);
    expect(outbound).not.toHaveBeenCalled();
  });
});
