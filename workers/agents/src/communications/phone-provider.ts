import { readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import {
  generateCustomerVoiceCredentialToken,
  parseTwilioVoiceCredentials,
  type TwilioVoiceCredentials,
} from "../voice/customer-telephony.js";
import type { CommunicationIdentity } from "./core.js";

export class PhoneProviderError extends Error {
  constructor(
    readonly uncertain: boolean,
    readonly code = uncertain
      ? "phone_provider_outcome_unknown"
      : "phone_provider_rejected"
  ) {
    super(code);
  }
}
/** Only fixed account resources, never caller supplied URLs. Unknown mutations are not retried. */
export async function phoneProvider(
  credentials: TwilioVoiceCredentials,
  resource: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  form?: URLSearchParams,
  fetcher: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  if (
    !/^(?:IncomingPhoneNumbers(?:\/PN[a-fA-F0-9]{32})?|Messages(?:\/SM[a-fA-F0-9]{32})?|Calls(?:\/CA[a-fA-F0-9]{32})?)\.json$/.test(
      resource
    )
  )
    throw new Error("invalid_phone_resource");
  let response: Response;
  try {
    response = await fetcher(
      `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/${resource}`,
      {
        method,
        headers: {
          authorization: `Basic ${btoa(`${credentials.accountSid}:${credentials.authToken}`)}`,
          ...(form
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(form ? { body: form } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      }
    );
  } catch {
    throw new PhoneProviderError(method !== "GET");
  }
  if (method === "DELETE" && response.status === 404) return {};
  if (!response.ok)
    throw new PhoneProviderError(method !== "GET" && response.status >= 500);
  if (method === "DELETE" && response.status === 204) return {};
  try {
    return await readBoundedResponseJson<Record<string, unknown>>(
      response,
      64 * 1024
    );
  } catch {
    throw new PhoneProviderError(method !== "GET");
  }
}
export function phoneCredentialName(identity: CommunicationIdentity) {
  return `ASSISTANT_PHONE_${identity.id}`;
}
export async function resolvePhoneCredentials(
  env: AgentsEnv,
  identity: CommunicationIdentity,
  payer: string
): Promise<TwilioVoiceCredentials | null> {
  // The existing WhatsApp account is never implicitly used for paid telephone provisioning.
  if (payer === "managed") return null; // Managed resale needs a separately configured carrier billing contract.
  if (!env.CREDENTIALS_WORKER) return null;
  const token = await generateCustomerVoiceCredentialToken(
    env.PLATFORM_SECRET,
    identity.tenant_id,
    identity.space_id
  );
  const response = await env.CREDENTIALS_WORKER.fetch(
    new Request(
      `http://credentials/v1/internal/spaces/${encodeURIComponent(identity.space_id)}/credentials/${encodeURIComponent(phoneCredentialName(identity))}/plaintext`,
      {
        method: "POST",
        headers: {
          "x-naelao-tenant-id": identity.tenant_id,
          "x-naelao-credential-token": token,
        },
      }
    )
  );
  if (!response.ok) return null;
  const value = await readBoundedResponseJson<{ value?: string }>(
    response,
    16384
  );
  return parseTwilioVoiceCredentials(value.value ?? null);
}
export function phonePublicOrigin(env: AgentsEnv): string {
  const url = new URL(env.PUBLIC_AGENTS_URL ?? "http://invalid");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  )
    throw new Error("public_agents_url_unconfigured");
  return url.origin;
}
export function phoneCallbacks(env: AgentsEnv, id: string) {
  const root = `${phonePublicOrigin(env)}/assistant-phone/twilio/${encodeURIComponent(id)}`;
  return {
    VoiceUrl: `${root}/answer`,
    VoiceMethod: "POST",
    SmsUrl: `${root}/sms`,
    SmsMethod: "POST",
    StatusCallback: `${root}/status`,
    StatusCallbackMethod: "POST",
  };
}
export const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!
  );
