import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type NotificationsEnv } from "./index.js";
function env(): NotificationsEnv {
  return { ENVIRONMENT: "test", RESEND_API_KEY: "resend", RESEND_API_URL: "https://api.resend.test", WEBHOOK_SIGNING_SECRET: "secret",
    TELEGRAM_BOT_TOKEN: "telegram-test", WHATSAPP_ACCESS_TOKEN: "phone-id:meta-test",
    PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ config_json: "{}" }) }) }) } as unknown as D1Database,
  };
}
describe("interactive mobile approval delivery", () => {
  afterEach(() => vi.unstubAllGlobals());
  for (const channel of ["telegram", "whatsapp"]) it(`sends provider-format review buttons for ${channel}`, async () => {
    const outbound = vi.fn(async () => Response.json({ ok: true })); vi.stubGlobal("fetch", outbound);
    const res = await worker.fetch!(new Request("https://notifications/internal/notify", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" }, body: JSON.stringify({ channel, space_id: "space", to: "1", body: "Urgent approval", actions: [{ id: "review:approval-1", label: "Review approval" }] }) }), env(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const payload = JSON.parse((outbound.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    if (channel === "telegram") expect(payload.reply_markup.inline_keyboard).toEqual([[{ text: "Review approval", callback_data: "review:approval-1" }]]);
    else expect(payload).toMatchObject({ type: "interactive", interactive: { type: "button", action: { buttons: [{ reply: { id: "review:approval-1" } }] } } });
  });
  it("reports provider rejection instead of claiming delivery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Rejected", { status: 400 })));
    const res = await worker.fetch!(new Request("https://notifications/internal/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "whatsapp", space_id: "space", to: "1", message: "Escalation" }) }), env(), {} as ExecutionContext);
    expect(res.status).toBe(502); expect(await res.json()).toMatchObject({ delivered: false });
  });
});
