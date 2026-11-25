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
export type ProviderValueSchema =
  | { type: "string"; description?: string; enum?: string[]; minLength?: number; maxLength?: number }
  | { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: ProviderValueSchema; minItems?: number; maxItems?: number }
  | { type: "object"; description?: string; properties: Record<string, ProviderValueSchema>; required?: string[]; additionalProperties: false };
export type ProviderCapabilitySchema = {
  type: "object";
  properties: Record<string, ProviderValueSchema>;
  required?: string[];
  additionalProperties: false;
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
  capabilitySchemas?: Record<string, ProviderCapabilitySchema>;
}

function validateValueSchema(value: unknown, depth = 0): value is ProviderValueSchema {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8) return false;
  const schema = value as Record<string, unknown>;
  if (typeof schema.type !== "string") return false;
  if (schema.description !== undefined && (typeof schema.description !== "string" || schema.description.length > 500)) return false;
  const fields: Record<string, string[]> = {
    string: ["type", "description", "enum", "minLength", "maxLength"],
    number: ["type", "description", "enum", "minimum", "maximum"],
    integer: ["type", "description", "enum", "minimum", "maximum"],
    boolean: ["type", "description", "enum"],
    array: ["type", "description", "items", "minItems", "maxItems"],
    object: ["type", "description", "properties", "required", "additionalProperties"],
  };
  const typeFields=fields[schema.type];
  if (!typeFields || Object.keys(schema).some(key => !typeFields.includes(key))) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 100)) return false;
  if (schema.type === "string") return (schema.enum === undefined || schema.enum.every(item => typeof item === "string"))
    && ["minLength", "maxLength"].every(key => schema[key] === undefined
      || (Number.isSafeInteger(schema[key]) && Number(schema[key]) >= 0))
    && (schema.minLength === undefined || schema.maxLength === undefined || Number(schema.minLength) <= Number(schema.maxLength));
  if (schema.type === "number" || schema.type === "integer") return (schema.enum === undefined || schema.enum.every(item => typeof item === "number" && Number.isFinite(item)))
    && ["minimum", "maximum"].every(key => schema[key] === undefined
    || (typeof schema[key] === "number" && Number.isFinite(schema[key])))
    && (schema.minimum === undefined || schema.maximum === undefined || Number(schema.minimum) <= Number(schema.maximum));
  if (schema.type === "boolean") return schema.enum === undefined || schema.enum.every(item => typeof item === "boolean");
  if (schema.type === "array") return validateValueSchema(schema.items, depth + 1)
    && ["minItems", "maxItems"].every(key => schema[key] === undefined
      || (Number.isSafeInteger(schema[key]) && Number(schema[key]) >= 0))
    && (schema.minItems === undefined || schema.maxItems === undefined || Number(schema.minItems) <= Number(schema.maxItems));
  if (schema.type !== "object" || schema.additionalProperties !== false || !schema.properties
    || typeof schema.properties !== "object" || Array.isArray(schema.properties)
    || Object.keys(schema.properties).length > 128) return false;
  const propertyNames = Object.keys(schema.properties);
  if (propertyNames.some(name => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))) return false;
  if (!Object.values(schema.properties).every(child => validateValueSchema(child, depth + 1))) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > propertyNames.length
    || new Set(schema.required).size !== schema.required.length
    || schema.required.some(name => typeof name !== "string" || !propertyNames.includes(name)))) return false;
  return true;
}

function validateCapabilitySchemas(capabilities: string[], value: unknown): value is Record<string, ProviderCapabilitySchema> {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 64) return false;
  const declared = new Set(capabilities);
  return entries.every(([capability, schema]) => declared.has(capability) && validateValueSchema(schema)
    && schema.type === "object" && schema.additionalProperties === false);
}

function validate(definition: ProviderDefinition): ProviderDefinition {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(definition.id)) throw new TypeError("Provider id must be a stable AgentPort identifier.");
  if (!definition.name.trim() || definition.name.length > 120) throw new TypeError("Provider name must be 1–120 characters.");
  if (!definition.accountModels.length || new Set(definition.accountModels).size !== definition.accountModels.length) throw new TypeError("Declare one or more distinct supported account models.");
  if (!definition.capabilities.length || definition.capabilities.some(value => !value.trim() || value.length > 160)) throw new TypeError("Declare one or more valid capabilities.");
  if (!validateCapabilitySchemas(definition.capabilities, definition.capabilitySchemas))
    throw new TypeError("Capability schemas must be strict object schemas for declared capabilities only.");
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
