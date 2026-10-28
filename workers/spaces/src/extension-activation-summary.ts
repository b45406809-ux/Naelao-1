import type { ExtensionManifest } from "@naelao/agent-sdk";

/** Safe, user-facing disclosure for an extension dependency in an install preview.
 * This intentionally excludes handler source, storage schemas, and secret values. */
export interface ExtensionActivationSummary {
  primitives: Array<{
    kind: string;
    id: string;
    capabilities: string[];
    permissions: string[];
    tools?: string[];
    scope?: string;
    provider?: string;
    inbound_events?: string[];
    outbound_events?: string[];
    resources?: { cpu_cores: number; memory_mb: number; timeout_seconds: number };
    network_policy?: string;
  }>;
  capabilities: string[];
  permissions: string[];
  commands: string[];
  background_jobs: Array<{ id: string; schedule?: string; memory_scope: string }>;
  widgets: Array<{ event: string; component: string }>;
  connections: Array<{ provider: string; purpose: string; required: boolean }>;
  knowledge: Array<{ purpose: string; access: string }>;
  shared_filesystem: Array<{ path: string; access: "READ" | "READ_WRITE" }>;
  approved_shared_filesystem?: Array<{ path: string; access: "READ" | "READ_WRITE" }>;
  worker_roles: Array<{
    id: string;
    execution: string;
    invocation: string;
    primitive_ids: string[];
    gadget_actions: Array<{ gadget_id: string; operations: string[]; tables: string[] }>;
  }>;
}

export function summarizeExtensionForActivation(manifest: ExtensionManifest): ExtensionActivationSummary {
  const bundle = manifest.bundle;
  return {
    primitives: (bundle?.primitives ?? []).map(primitive => ({
      kind: primitive.kind,
      id: primitive.id,
      capabilities: [...new Set(primitive.capabilityRequirements)].sort(),
      permissions: primitive.permissions.flatMap(permission => permission.actions.map(action => `${permission.scope}:${permission.resource}:${action}`)).sort(),
      ...("toolNames" in primitive ? { tools: [...primitive.toolNames].sort() } : {}),
      ...("scope" in primitive ? { scope: primitive.scope } : {}),
      ...("provider" in primitive ? { provider: primitive.provider } : {}),
      ...("inboundEvents" in primitive ? { inbound_events: [...primitive.inboundEvents].sort() } : {}),
      ...("outboundEvents" in primitive ? { outbound_events: [...primitive.outboundEvents].sort() } : {}),
      ...("resources" in primitive ? { resources: { cpu_cores: primitive.resources.cpuCores, memory_mb: primitive.resources.memoryMb, timeout_seconds: primitive.resources.timeoutSeconds } } : {}),
      ...("networkPolicy" in primitive && primitive.networkPolicy ? { network_policy: primitive.networkPolicy } : {}),
    })).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
    capabilities: [...new Set(manifest.capabilityRequirements)].sort(),
    permissions: [...new Set(manifest.declaredPermissions)].sort(),
    commands: (manifest.commands ?? []).map(command => command.name).sort(),
    background_jobs: (manifest.daemons ?? []).map(({ id, schedule, memoryScope }) => ({ id, ...(schedule ? { schedule } : {}), memory_scope: memoryScope })).sort((a, b) => a.id.localeCompare(b.id)),
    widgets: (manifest.widgetSubscriptions ?? []).map(({ event, component }) => ({ event, component })).sort((a, b) => `${a.event}:${a.component}`.localeCompare(`${b.event}:${b.component}`)),
    connections: (bundle?.connections ?? []).map(({ provider, purpose, required }) => ({ provider, purpose, required }))
      .sort((a, b) => `${a.provider}:${a.purpose}`.localeCompare(`${b.provider}:${b.purpose}`)),
    knowledge: (bundle?.knowledge ?? []).map(({ purpose, access }) => ({ purpose, access }))
      .sort((a, b) => `${a.access}:${a.purpose}`.localeCompare(`${b.access}:${b.purpose}`)),
    shared_filesystem: (manifest.shared_filesystem ?? []).map(({ path, access }) => ({ path, access })).sort((a, b) => a.path.localeCompare(b.path)),
    worker_roles: (bundle?.workerRoles ?? []).map(({ id, execution, invocation, primitiveIds, gadgetActions }) => ({ id, execution, invocation,
      primitive_ids: [...primitiveIds].sort(),
      gadget_actions: (gadgetActions ?? []).map(({ gadgetId, operations, tables }) => ({ gadget_id: gadgetId, operations: [...operations].sort(), tables: [...tables].sort() }))
        .sort((a, b) => a.gadget_id.localeCompare(b.gadget_id)),
    }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
