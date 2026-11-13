import { describe, expect, it, vi } from "vitest";
import { revokeExtensionProviderAccess } from "./provider-revocation.js";

describe("extension provider revocation outcomes", () => {
  it("does not call providers when egress or a credential is unavailable", async () => {
    const fetcher = vi.fn();
    await expect(revokeExtensionProviderAccess({ provider: "slack", token: "token", egressDenied: true, fetcher }))
      .resolves.toEqual({ status: "pending", errorCode: "provider_egress_denied" });
    await expect(revokeExtensionProviderAccess({ provider: "slack", token: null, egressDenied: false, fetcher }))
      .resolves.toEqual({ status: "pending", errorCode: "provider_credential_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires a positive Slack response and treats an already revoked token as complete", async () => {
    const accepted = vi.fn(async () => Response.json({ ok: true }));
    await expect(revokeExtensionProviderAccess({ provider: "slack", token: "secret", egressDenied: false, fetcher: accepted }))
      .resolves.toEqual({ status: "complete", actionCode: "slack_token_revoked" });
    expect(accepted).toHaveBeenCalledWith("https://slack.com/api/auth.revoke", expect.objectContaining({ method: "POST" }));
    await expect(revokeExtensionProviderAccess({ provider: "slack", token: "secret", egressDenied: false,
      fetcher: vi.fn(async () => Response.json({ ok: false, error: "token_revoked" })) }))
      .resolves.toEqual({ status: "complete", actionCode: "slack_token_revoked" });
    await expect(revokeExtensionProviderAccess({ provider: "slack", token: "secret", egressDenied: false,
      fetcher: vi.fn(async () => Response.json({ ok: false, error: "ratelimited" })) })).resolves.toEqual({ status: "pending", errorCode: "provider_revoke_not_confirmed" });
  });

  it("records provider-specific limits instead of claiming token revocation for Telegram or WhatsApp", async () => {
    const telegram = vi.fn(async () => Response.json({ ok: true, result: true }));
    await expect(revokeExtensionProviderAccess({ provider: "telegram", token: "bot-token", egressDenied: false, fetcher: telegram }))
      .resolves.toEqual({ status: "not_supported", actionCode: "telegram_webhook_deleted", errorCode: "telegram_token_revocation_manual" });
    expect(telegram.mock.calls[0]?.[0]).toContain("/botbot-token/deleteWebhook");
    const whatsapp = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(revokeExtensionProviderAccess({ provider: "whatsapp", token: "secret", egressDenied: false,
      whatsappBusinessAccountId: "waba-1", whatsappApiVersion: "v99.0", fetcher: whatsapp }))
      .resolves.toEqual({ status: "not_supported", actionCode: "whatsapp_subscription_removed", errorCode: "whatsapp_token_revocation_manual" });
    expect(whatsapp.mock.calls[0]?.[0]).toContain("/v99.0/waba-1/subscribed_apps");
    const shared = vi.fn();
    await expect(revokeExtensionProviderAccess({ provider: "whatsapp", token: "secret", egressDenied: false,
      whatsappAccountStillUsed: true, fetcher: shared })).resolves.toEqual({ status: "complete", actionCode: "shared_whatsapp_subscription_retained" });
    await expect(revokeExtensionProviderAccess({ provider: "telegram", token: "bot-token", egressDenied: false,
      telegramBotStillUsed: true, fetcher: shared })).resolves.toEqual({ status: "complete", actionCode: "shared_telegram_webhook_retained" });
    expect(shared).not.toHaveBeenCalled();
  });

  it("marks network ambiguity and unsupported provider effects without claiming completion", async () => {
    await expect(revokeExtensionProviderAccess({ provider: "telegram", token: "token", egressDenied: false,
      fetcher: vi.fn(async () => { throw new Error("network"); }) })).resolves.toEqual({ status: "pending", errorCode: "provider_revoke_outcome_unknown" });
    await expect(revokeExtensionProviderAccess({ provider: "custom", token: "token", egressDenied: false }))
      .resolves.toEqual({ status: "not_supported", actionCode: "provider_cleanup_not_supported", errorCode: "provider_revocation_not_supported" });
  });
});
