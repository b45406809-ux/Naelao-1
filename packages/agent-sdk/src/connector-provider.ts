/** Provider is an execution route. Credential ownership remains with the connected tenant. */
export type ConnectorProvider =
  | "composio"
  | "pipedream"
  | "direct"
  | "custom_oauth";
export type ConnectorProviderChoice =
  | ConnectorProvider
  | "AUTO"
  | "COMPOSIO"
  | "PIPEDREAM";

export interface ConnectorProviderPreference {
  preferredProvider?: ConnectorProviderChoice;
}

function normalizePreference(
  provider: ConnectorProviderChoice | undefined
): ConnectorProvider | undefined {
  if (provider === undefined || provider === "AUTO") return undefined;
  return provider.toLowerCase() as ConnectorProvider;
}

export interface ConnectorProviderRegistry {
  composio?: ReadonlySet<string>;
  pipedream?: ReadonlySet<string>;
  direct?: ReadonlySet<string>;
  custom_oauth?: ReadonlySet<string>;
}

/** Resolve a logical app to exactly one configured route. A persisted workspace pin always wins;
 * callers cannot silently migrate to another account/provider when a pinned route is unavailable. */
export function resolveConnectorProvider(input: {
  appId: string;
  registry: ConnectorProviderRegistry;
  preferredProvider?: ConnectorProviderChoice;
  pinnedProvider?: ConnectorProvider;
}): ConnectorProvider {
  const appId = input.appId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(appId))
    throw new Error("connector_app_id_invalid");

  const preferredProvider = normalizePreference(input.preferredProvider);
  if (input.pinnedProvider) {
    if (preferredProvider && preferredProvider !== input.pinnedProvider) {
      throw new Error("connector_provider_pinned");
    }
    if (!input.registry[input.pinnedProvider]?.has(appId))
      throw new Error("connector_provider_unavailable");
    return input.pinnedProvider;
  }

  if (preferredProvider) {
    if (!input.registry[preferredProvider]?.has(appId))
      throw new Error("connector_provider_unavailable");
    return preferredProvider;
  }

  // Composio is the default for overlapping app IDs; Pipedream handles the long tail.
  for (const provider of [
    "composio",
    "pipedream",
    "direct",
    "custom_oauth",
  ] as const) {
    if (input.registry[provider]?.has(appId)) return provider;
  }
  throw new Error("connector_unavailable");
}

/** Pure pin update used by hosts before recording a connection. It never transfers or copies a
 * token between providers, and never changes an existing provider pin implicitly. */
export function pinConnectorProvider(
  pins: Readonly<Record<string, ConnectorProvider>>,
  appId: string,
  provider: ConnectorProvider
): Readonly<Record<string, ConnectorProvider>> {
  const key = appId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(key))
    throw new Error("connector_app_id_invalid");
  const existing = pins[key];
  if (existing && existing !== provider)
    throw new Error("connector_provider_pinned");
  return Object.freeze({ ...pins, [key]: provider });
}
