import { AgentPortClient, type AccountModel, type ServiceManifest } from "@agentport/sdk";

export type ProviderAuth = {
  type: "oauth2" | "api_key" | "mtls" | "provider_managed" | "none";
  authorizationUrl?: string;
  scopes?: string[];
};
export type ProvisioningDeclaration = {
  mode: "none" | "approval_required" | "self_service" | "manual";
  requires?: string[];
  description?: string;
};
export type BillingDeclaration = {
  model: "free" | "fixed" | "usage" | "provider_defined";
  currency?: string;
  description?: string;
};
export interface ProviderDefinition {
  id: string;
  name: string;
  type: ServiceManifest["type"];
  endpoint?: string;
  accountModels: AccountModel[];
  capabilities: string[];
  events?: string[];
  connectionPurpose: ServiceManifest["connectionPurpose"];
  partnershipStatus?: "unaffiliated" | "restricted" | "unavailable";
  auth: ProviderAuth;
  provisioning: ProvisioningDeclaration;
  billing: BillingDeclaration;
  capabilitySchemas?: Record<string, unknown>;
}

function validate(definition: ProviderDefinition): ProviderDefinition {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(definition.id)) throw new TypeError("Provider id must be a stable AgentPort identifier.");
  if (!definition.name.trim() || definition.name.length > 120) throw new TypeError("Provider name must be 1–120 characters.");
  if (!definition.accountModels.length || new Set(definition.accountModels).size !== definition.accountModels.length) throw new TypeError("Declare one or more distinct supported account models.");
  if (!definition.capabilities.length || definition.capabilities.some(value => !value.trim() || value.length > 160)) throw new TypeError("Declare one or more valid capabilities.");
  if (definition.endpoint) {
    const endpoint = new URL(definition.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) throw new TypeError("Provider endpoint must be a public HTTPS URL without credentials or a fragment.");
  }
  if (definition.auth.type === "oauth2" && definition.auth.authorizationUrl) {
    const authorizationUrl = new URL(definition.auth.authorizationUrl);
    if (authorizationUrl.protocol !== "https:" || authorizationUrl.username || authorizationUrl.password) throw new TypeError("OAuth authorization URL must use HTTPS.");
  }
  if (definition.billing.currency && !/^[A-Z]{3}$/.test(definition.billing.currency)) throw new TypeError("Billing currency must be a three-letter ISO currency code.");
  return definition;
}

/** Declare provider metadata. This validates and publishes a manifest; provider actions and
 * account creation still execute only through the provider's own authorized API/connector. */
export function defineProvider(input: ProviderDefinition): ServiceManifest {
  const definition = validate(input);
  return {
    id: definition.id, name: definition.name.trim(), type: definition.type,
    ...(definition.endpoint ? { endpoint: definition.endpoint } : {}),
    accountModels: [...new Set(definition.accountModels)], capabilities: [...new Set(definition.capabilities)],
    events: [...new Set(definition.events ?? [])], connectionPurpose: definition.connectionPurpose,
    partnershipStatus: definition.partnershipStatus ?? "unaffiliated",
    auth: structuredClone(definition.auth), provisioning: structuredClone(definition.provisioning),
    billing: structuredClone(definition.billing), capabilitySchemas: structuredClone(definition.capabilitySchemas ?? {}),
  };
}

export async function publishProvider(client: AgentPortClient, input: ProviderDefinition) {
  return client.registerService(defineProvider(input));
}
