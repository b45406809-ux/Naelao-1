import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import { TelnyxTelephony, type TelnyxCredentials } from "../voice/telnyx-telephony.js";
import { generatePhoneCredentialToken, isE164 } from "../voice/twilio-telephony.js";
import type { CommunicationIdentity, CommunicationScope } from "./core.js";
import type { AssistantPhoneBinding } from "./phones.js";

const credentialName = (identity: CommunicationIdentity) => `ASSISTANT_PHONE_TELNYX_${identity.id}`;
type Account = TelnyxCredentials & { verifiedNumberId: string; verifiedPhoneNumber: string; callControlId?: string | null };

export async function resolveTelnyxAccount(env: AgentsEnv, identity: CommunicationIdentity, binding?: Pick<AssistantPhoneBinding, "payer" | "provider_number_sid" | "phone_number">): Promise<Account | null> {
  if (binding?.payer === "managed") {
    if (!env.TELNYX_MANAGED_API_KEY || !env.TELNYX_MANAGED_PUBLIC_KEY || !binding.provider_number_sid || !binding.phone_number) return null;
    const account: Account = { apiKey: env.TELNYX_MANAGED_API_KEY, publicKey: env.TELNYX_MANAGED_PUBLIC_KEY,
      verifiedNumberId: binding.provider_number_sid, verifiedPhoneNumber: binding.phone_number,
      callControlId: env.TELNYX_MANAGED_CALL_CONTROL_ID ?? null };
    new TelnyxTelephony(account);
    return account;
  }
  if (!env.CREDENTIALS_WORKER) throw new Error("credential_vault_unavailable");
  const response = await env.CREDENTIALS_WORKER.fetch(new Request(
    `http://credentials/v1/internal/spaces/${encodeURIComponent(identity.space_id)}/credentials/${encodeURIComponent(credentialName(identity))}/plaintext`,
    { method: "POST", headers: { "x-naelao-tenant-id": identity.tenant_id,
      "x-naelao-credential-token": await generatePhoneCredentialToken(env.PLATFORM_SECRET, identity.tenant_id, identity.space_id) } },
  ));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("telnyx_account_status_unavailable");
  const saved = await readBoundedResponseJson<{ value?: string }>(response, 16384);
  try {
    const account = JSON.parse(saved.value ?? "") as Account;
    new TelnyxTelephony(account);
    if (!/^\d{1,32}$/.test(account.verifiedNumberId) || !isE164(account.verifiedPhoneNumber)
      || (account.callControlId != null && !/^[A-Za-z0-9_-]{1,128}$/.test(account.callControlId))) throw new Error();
    return account;
  } catch { throw new Error("telnyx_account_record_invalid"); }
}

export async function removeTelnyxAccount(env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity) {
  if (!env.CREDENTIALS_WORKER) throw new Error("credential_vault_unavailable");
  const headers = { "x-naelao-tenant-id": scope.tenantId, "x-naelao-user-id": scope.userId, "x-naelao-role": "admin",
    "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId) };
  const root = `http://credentials/spaces/${encodeURIComponent(scope.spaceId)}/credentials`;
  const response = await env.CREDENTIALS_WORKER.fetch(new Request(root, { headers }));
  if (!response.ok) throw new Error("telnyx_account_status_unavailable");
  const list = await readBoundedResponseJson<{ credentials?: Array<{ id: string; name: string; scope: string; project_id: string | null }> }>(response, 256 * 1024);
  const candidates = list.credentials?.filter(row => row.name === credentialName(identity) && row.scope === "space" && !row.project_id) ?? [];
  for (const row of candidates) {
    const deleted = await env.CREDENTIALS_WORKER.fetch(new Request(`${root}/${encodeURIComponent(row.id)}`, { method: "DELETE", headers }));
    if (!deleted.ok && deleted.status !== 404) throw new Error("telnyx_account_removal_failed");
  }
  return { configured: false, transport_active: false };
}

export async function telnyxAccountStatus(env: AgentsEnv, identity: CommunicationIdentity) {
  if (!env.CREDENTIALS_WORKER) return { configured: false, transport_active: false };
  const account = await resolveTelnyxAccount(env, identity);
  if (!account) return { configured: false, transport_active: false };
  return { configured: true, transport_active: false, voice_available: Boolean(account.callControlId), number_id: account.verifiedNumberId, phone_number: account.verifiedPhoneNumber };
}

/** Called only after host authorization, phone enablement and egress checks. This stores
 * a verified account candidate; it never changes a number's callbacks or active carrier. */
export async function configureTelnyxAccount(env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity,
  body: Record<string, unknown>, fetcher: typeof fetch = fetch) {
  if (!env.CREDENTIALS_WORKER) throw new Error("credential_vault_unavailable");
  if (typeof body.api_key !== "string" || typeof body.public_key !== "string" || typeof body.number_id !== "string")
    throw new Error("telnyx_account_input_invalid");
  const credentials = { apiKey: body.api_key, publicKey: body.public_key };
  const number = await new TelnyxTelephony(credentials, fetcher).inspectPhoneNumber(body.number_id);
  const response = await env.CREDENTIALS_WORKER.fetch(new Request(
    `http://credentials/spaces/${encodeURIComponent(scope.spaceId)}/credentials`, {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId,
        "x-naelao-user-id": scope.userId, "x-naelao-role": "admin",
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId) },
      body: JSON.stringify({ name: credentialName(identity), scope: "space", description: "Verified Telnyx assistant carrier candidate",
        value: JSON.stringify({ ...credentials, verifiedNumberId: number.id, verifiedPhoneNumber: number.phoneNumber, callControlId: number.callControlId }) }),
    }));
  if (!response.ok) throw new Error("credential_store_failed");
  return { configured: true, transport_active: false, voice_available: Boolean(number.callControlId), number_id: number.id, phone_number: number.phoneNumber };
}
