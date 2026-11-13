export type ExtensionProviderRevocationStatus = "complete" | "pending" | "not_supported";
export type ExtensionProviderName = "slack" | "telegram" | "whatsapp" | string;

export interface ProviderRevocationResult {
  status: ExtensionProviderRevocationStatus;
  actionCode?: string;
  errorCode?: string;
}

/** External revocation is separate from the authoritative local deny, which happens first. */
export async function revokeExtensionProviderAccess(input: {
  provider: ExtensionProviderName;
  token: string | null;
  egressDenied: boolean;
  whatsappBusinessAccountId?: string;
  whatsappApiVersion?: string;
  whatsappAccountStillUsed?: boolean;
  telegramBotStillUsed?: boolean;
  fetcher?: typeof fetch;
}): Promise<ProviderRevocationResult> {
  if (input.provider === "whatsapp" && input.whatsappAccountStillUsed) {
    return { status: "complete", actionCode: "shared_whatsapp_subscription_retained" };
  }
  if (input.provider === "telegram" && input.telegramBotStillUsed) {
    return { status: "complete", actionCode: "shared_telegram_webhook_retained" };
  }
  if (!["slack", "telegram", "whatsapp"].includes(input.provider)) {
    return { status: "not_supported", actionCode: "provider_cleanup_not_supported", errorCode: "provider_revocation_not_supported" };
  }
  if (input.egressDenied) return { status: "pending", errorCode: "provider_egress_denied" };
  if (!input.token) return { status: "pending", errorCode: "provider_credential_unavailable" };
  const fetcher = input.fetcher ?? fetch;
  try {
    let response: Response;
    let accepted: boolean;
    if (input.provider === "slack") {
      response = await fetcher("https://slack.com/api/auth.revoke", {
        method: "POST", headers: { authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(5_000),
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      accepted = response.ok && (result.ok === true || result.error === "token_revoked");
    } else if (input.provider === "telegram") {
      response = await fetcher(`https://api.telegram.org/bot${input.token}/deleteWebhook`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ drop_pending_updates: false }), signal: AbortSignal.timeout(5_000),
      });
      const result = await response.json() as { ok?: boolean };
      accepted = response.ok && result.ok === true;
    } else {
      const businessAccountId = input.whatsappBusinessAccountId ?? "";
      if (!businessAccountId || !input.whatsappApiVersion) return { status: "pending", errorCode: "provider_configuration_missing" };
      response = await fetcher(`https://graph.facebook.com/${input.whatsappApiVersion}/${encodeURIComponent(businessAccountId)}/subscribed_apps`, {
        method: "DELETE", headers: { authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(5_000),
      });
      accepted = response.ok;
    }
    if (!accepted) return { status: "pending", errorCode: "provider_revoke_not_confirmed" };
    if (input.provider === "slack") return { status: "complete", actionCode: "slack_token_revoked" };
    if (input.provider === "telegram") {
      return { status: "not_supported", actionCode: "telegram_webhook_deleted", errorCode: "telegram_token_revocation_manual" };
    }
    return { status: "not_supported", actionCode: "whatsapp_subscription_removed", errorCode: "whatsapp_token_revocation_manual" };
  } catch {
    return { status: "pending", errorCode: "provider_revoke_outcome_unknown" };
  }
}
