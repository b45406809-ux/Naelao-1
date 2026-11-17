import { assertExtensionId, type ExtensionId, type GadgetScope, type GadgetTier, type RuntimeScope, type ExecutionMode, type PermissionAction } from "./types.js";
import type { CanvasLayout } from "./canvas-runtime.js";
import { WIDGET_EVENT_TYPES, type WidgetEventType } from "./widget-events.js";
import { validateSetupFieldDefinitions, validateSetupFieldValues } from "./blueprint-setup-fields.js";
import type { BlueprintSetupValue } from "./blueprint-setup-fields.js";
import type { BlueprintSetupField } from "./types.js";
import { RECEIVE_STOCK_INPUT_SCHEMA, RECEIVE_STOCK_OUTPUT_SCHEMA, ADJUST_STOCK_INPUT_SCHEMA, ADJUST_STOCK_OUTPUT_SCHEMA,
  LIST_LOW_STOCK_INPUT_SCHEMA, LIST_LOW_STOCK_OUTPUT_SCHEMA,
  createBusinessActionClient, validateBusinessActionInput, validateBusinessActionOutput, validateExtensionBusinessAction, validateReceiveStockInput,
  validateReceiveStockOutput, validateAdjustStockInput, validateAdjustStockOutput, validateListLowStockInput, validateListLowStockOutput,
  type AdjustStockInput, type AdjustStockOutput, type ListLowStockInput, type ListLowStockOutput, type ListLowStockProduct,
  type BusinessActionClient, type BusinessActionObjectSchema, type BusinessActionRole, type ExtensionBusinessAction,
  type ReceiveStockInput, type ReceiveStockOutput } from "./business-actions.js";
export { RECEIVE_STOCK_INPUT_SCHEMA, RECEIVE_STOCK_OUTPUT_SCHEMA, ADJUST_STOCK_INPUT_SCHEMA, ADJUST_STOCK_OUTPUT_SCHEMA,
  LIST_LOW_STOCK_INPUT_SCHEMA, LIST_LOW_STOCK_OUTPUT_SCHEMA,
  createBusinessActionClient, validateBusinessActionInput, validateBusinessActionOutput, validateExtensionBusinessAction,
  validateReceiveStockInput, validateReceiveStockOutput, validateAdjustStockInput, validateAdjustStockOutput,
  validateListLowStockInput, validateListLowStockOutput };
export type { AdjustStockInput, AdjustStockOutput, ListLowStockInput, ListLowStockOutput, ListLowStockProduct,
  BusinessActionClient, BusinessActionObjectSchema, BusinessActionRole, ExtensionBusinessAction,
  ReceiveStockInput, ReceiveStockOutput };

export interface ExtensionSettingsSchema { schemaVersion: 1 | 2; fields: BlueprintSetupField[] }
/** Manifest requests are declarations only; the host binds grants to the active caller and scope. */
export type ExtensionResourceKind = "objects" | "structured_data" | "jobs" | "knowledge";
export type ExtensionResourceScope = "installation" | "project" | "space";
export type ExtensionResourceValueType = "string" | "number" | "boolean";
export interface ExtensionResourceFieldSchema { type: ExtensionResourceValueType; required?: boolean; maxLength?: number; minimum?: number; maximum?: number }
export interface ExtensionResourceObjectSchema { schemaVersion: "1.0"; fields: Readonly<Record<string, ExtensionResourceFieldSchema>> }
export interface ExtensionResourceOperation {
  id: string; input: ExtensionResourceObjectSchema; output: ExtensionResourceObjectSchema;
  idempotency: "required" | "none"; meteringUnit: "request" | "byte" | "job";
}
export const EXTENSION_OBJECT_MAX_BYTES = 64 * 1024;
export const EXTENSION_OBJECT_MAX_TOTAL_BYTES = 512 * 1024;
export const EXTENSION_OBJECT_MAX_COUNT = 64;
export const EXTENSION_OBJECT_MAX_KEY_LENGTH = 128;
export const EXTENSION_OBJECT_MAX_BASE64_LENGTH = Math.ceil(EXTENSION_OBJECT_MAX_BYTES / 3) * 4;
export function isExtensionObjectKey(value: unknown): value is string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > EXTENSION_OBJECT_MAX_KEY_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)) return false;
  return value.split("/").every(part => part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
}
export function decodeExtensionObjectBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > EXTENSION_OBJECT_MAX_BASE64_LENGTH || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const decoded = atob(value), bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    if (bytes.byteLength > EXTENSION_OBJECT_MAX_BYTES) return null;
    let canonical = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      canonical += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    return btoa(canonical) === value ? bytes : null;
  } catch { return null; }
}
export function isExtensionObjectContentType(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128
    && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value);
}
/** Structured data may bind only to an existing project Gadget. This is a requested backing
 * resource, not a grant; the effective operations still come from the installed workflow role. */
export interface ExtensionStructuredDataBinding { gadgetId: string; tables: readonly string[] }
/** A jobs declaration can target only signed workflows from the same package. */
export interface ExtensionJobsBinding { workflowIds: readonly string[] }
export interface ExtensionKnowledgeBinding { publicationIds: readonly string[] }
export interface ExtensionResourceRequirement {
  id: string; kind: ExtensionResourceKind; apiVersion: "1.0"; scope: ExtensionResourceScope;
  operations: readonly ExtensionResourceOperation[];
  limits: { requestsPerMinute: number; maxConcurrent: number; maxBytesPerOperation: number };
  binding?: ExtensionStructuredDataBinding | ExtensionJobsBinding | ExtensionKnowledgeBinding;
}
export interface ExtensionResourceCapabilityDescriptor {
  kind: ExtensionResourceKind; apiVersion: "1.0"; status: "unavailable" | "available"; operations: readonly string[];
}
/** Unavailable entries are truthful: declarations never advertise runtime support by themselves. */
export const EXTENSION_RESOURCE_CAPABILITIES = Object.freeze([
  Object.freeze({ kind: "objects" as const, apiVersion: "1.0" as const, status: "unavailable" as const, operations: Object.freeze([] as string[]) }),
  Object.freeze({ kind: "structured_data" as const, apiVersion: "1.0" as const, status: "unavailable" as const, operations: Object.freeze([] as string[]) }),
  Object.freeze({ kind: "jobs" as const, apiVersion: "1.0" as const, status: "unavailable" as const, operations: Object.freeze([] as string[]) }),
  Object.freeze({ kind: "knowledge" as const, apiVersion: "1.0" as const, status: "unavailable" as const, operations: Object.freeze([] as string[]) }),
]);
export function findUnsupportedExtensionResources(requirements: readonly ExtensionResourceRequirement[],
  capabilities: readonly ExtensionResourceCapabilityDescriptor[] = EXTENSION_RESOURCE_CAPABILITIES): Array<{ requirementId: string; kind: ExtensionResourceKind; operations: string[] }> {
  return requirements.flatMap(requirement => {
    const capability = capabilities.find(item => item.kind === requirement.kind && item.apiVersion === requirement.apiVersion && item.status === "available");
    const missing = requirement.operations.map(operation => operation.id).filter(operation => !capability?.operations.includes(operation));
    return missing.length ? [{ requirementId: requirement.id, kind: requirement.kind, operations: missing }] : [];
  });
}
export interface ExtensionResourceExecutionScope {
  tenantId: string; spaceId: string; projectId: string | null; installationId: string; principalId: string;
}
export interface HostIssuedExtensionResourceGrant {
  handle: string; requirementId: string; kind: ExtensionResourceKind; apiVersion: "1.0";
  scope: ExtensionResourceExecutionScope; operations: readonly string[];
  status: "active" | "revoked" | "suspended"; expiresAt: string;
}
export interface ExtensionResourceOperationRequest {
  handle: string; requirementId: string; operation: string; scope: ExtensionResourceExecutionScope;
  input: unknown; idempotencyKey?: string; meteringUnit: ExtensionResourceOperation["meteringUnit"]; inputBytes: number;
}
/** Trusted host adapter surface. Provider credentials and provider identifiers stay out of SDK code. */
export interface ExtensionResourceAdapter { execute<T = unknown>(request: ExtensionResourceOperationRequest): Promise<T> }
export interface ExtensionResourceClient {
  execute<T = unknown>(requirementId: string, operation: string, input: unknown, idempotencyKey?: string): Promise<T>;
}
/** `stepKey` is the durable workflow idempotency key for this resource effect. */
export interface ExtensionWorkflowResources {
  execute<T = unknown>(stepKey: string, requirementId: string, operation: string, input: unknown): Promise<T>;
  objects: { execute<T = unknown>(stepKey: string, requirementId: string, operation: "get" | "put" | "delete", input: unknown): Promise<T> };
  jobs: {
    enqueue<T = { jobId: string; status: string }>(stepKey: string, requirementId: string,
      input: { workflowId: string; params?: Record<string, unknown>; deadlineSeconds?: number }): Promise<T>;
    status<T = { jobId: string; status: string; attempt: number }>(stepKey: string, requirementId: string, jobId: string): Promise<T>;
  };
}
/** Packages can require owners to publish a validated settings draft before it affects runtime. */
export type ExtensionSettingsActivation = "owner_publish";
/** Exact immutable dependency pin. The manifest digest fences same-version substitution. */
export interface ExtensionDependency { extensionId: ExtensionId; version: string; manifestSha256: string }
export interface InstalledExtensionDependencyPin {
  extensionId: string;
  releaseVersion: string | null;
  manifestSha256: string | null;
  manifest: unknown;
}
export interface ExtensionSettingsSnapshot {
  schema: ExtensionSettingsSchema;
  settings: Partial<Record<string, BlueprintSetupValue>>;
  revision: number;
  updated_at?: string;
}

export interface ExtensionGadgetManifest {
  id: string;
  name: string;
  viewportComponent: string;
  scope: GadgetScope;
  gadgetTier: GadgetTier;
  defaultSchemaSql: string;
  migrations?: readonly ExtensionSqlMigration[];
  businessActions?: readonly ExtensionBusinessAction[];
}

export interface ExtensionDaemonManifest {
  id: string;
  name: string;
  workflowScript: string;
  schedule?: string;
  memoryScope: RuntimeScope;
}

export interface ExtensionCommandManifest { name: string; scriptPath: string }
export interface SharedFilesystemGrant { path: string; access: "READ" | "READ_WRITE" }
/** Pure display handler: `export async function run(args, ctx)` returns a bounded view; host execution
 * supplies no RPC capabilities and rejects actions, markup, links and unknown output fields. */
export interface ExtensionWidgetSubscription { event: WidgetEventType; component: string }

/** Compatibility contract for extensions installed before modular manifests were introduced. */
export type ExtensionPermission = "storage:read" | "storage:write" | "network" | "mcp:expose" | "alarms";
export interface LegacyExtensionManifest {
  id: string; version: string; permissions: readonly ExtensionPermission[];
  tools: readonly string[]; maxRetries: number; alarmIntervalMs?: number;
}

/** A userspace package. It intentionally has no prompt, kernel, or guard configuration. */
export interface ExtensionManifest {
  id: ExtensionId;
  /** Release identity for a modular package (legacy `version` is reserved for the old contract). */
  releaseVersion?: string;
  type: "extension";
  declaredPermissions: string[];
  /** Gatekeeper capabilities that must be present when this package is installed. */
  capabilityRequirements: string[];
  gadgets: ExtensionGadgetManifest[];
  daemons: ExtensionDaemonManifest[];
  commands: ExtensionCommandManifest[];
  /** Public inbound handlers use a separate channel-only host context. */
  channels?: readonly ChannelContract[];
  /** Versioned composed package; its channel primitives become the runtime channel declarations. */
  bundle?: ExtensionBundleManifest;
  /** Installed sidecars remain userspace declarations, never provider image authority. */
  containers?: readonly ContainerContract[];
  /** Opt-in access to the common Space drive. Paths are directory prefixes below /space/shared/. */
  shared_filesystem?: readonly SharedFilesystemGrant[];
  /** Delivery requires the owner-approved `events.subscribe` install grant and a signed handler artifact. */
  widgetSubscriptions?: readonly ExtensionWidgetSubscription[];
  /** Optional per-installation settings for a package-owned microapp dashboard. */
  settingsSchema?: ExtensionSettingsSchema;
  /** Omit for legacy immediate settings writes; owner_publish separates drafts from runtime values. */
  settingsActivation?: ExtensionSettingsActivation;
  /** Exact immutable package dependencies; host admission must verify the complete scoped closure. */
  dependencies?: ExtensionDependency[];
  /** Declarative resource requests; these never imply approval or current runtime availability. */
  resourceRequirements?: ExtensionResourceRequirement[];
}

/** Stable content pin for the canonical modular extension manifest stored by the host. */
export async function digestExtensionManifest(manifest: ExtensionManifest): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const ID = /^[a-z][a-z0-9_-]{1,63}$/;
const PERMISSION = /^[a-z][a-z0-9_.:-]{1,127}$/;
const SAFE_PATH = /^(?=.{1,256}$)(?:\.\/)?(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(?:ts|js)$/;
const COMMAND = /^(?:ext:[a-z][a-z0-9_-]{1,59}|[a-z][a-z0-9_-]{1,63})$/;
const FORBIDDEN_KEY = /(?:kernel|systemprompt|coreprompt|promptlayers?|writeguard|gatekeepers?|replloop|reasoningloop|bypass|disableguard|unsandboxed|sandboxdisabled)/i;
const FORBIDDEN_SCRIPT = /(?:NaelaoAgentDO|WriteGuard|Gatekeeper|system\s*prompt|core\s*prompt|reasoning\s*loop|\bmain\b.*(?:push|commit|write)|bypass\s+(?:guard|approval))/i;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invalid_extension_manifest:${message}`);
}

function parseResourceSchema(value: unknown): ExtensionResourceObjectSchema {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_resource_schema");
  const schema = value as Record<string, unknown>;
  assert(Object.keys(schema).every(key => key === "schemaVersion" || key === "fields")
    && schema.schemaVersion === "1.0" && schema.fields !== null && typeof schema.fields === "object" && !Array.isArray(schema.fields), "invalid_resource_schema");
  const fields = schema.fields as Record<string, unknown>;
  assert(Object.keys(fields).length <= 64, "resource_schema_field_limit");
  for (const [name, raw] of Object.entries(fields)) {
    assert(/^[a-z][a-zA-Z0-9_]{0,63}$/.test(name) && raw !== null && typeof raw === "object" && !Array.isArray(raw), "invalid_resource_schema_field");
    const field = raw as Record<string, unknown>;
    assert(Object.keys(field).every(key => ["type", "required", "maxLength", "minimum", "maximum"].includes(key))
      && ["string", "number", "boolean"].includes(String(field.type)), "invalid_resource_schema_field");
    assert(field.required === undefined || typeof field.required === "boolean", "invalid_resource_schema_field");
    assert(field.maxLength === undefined || Number.isInteger(field.maxLength) && Number(field.maxLength) >= 0 && Number(field.maxLength) <= 1_048_576, "invalid_resource_schema_field");
    for (const key of ["minimum", "maximum"] as const)
      assert(field[key] === undefined || typeof field[key] === "number" && Number.isFinite(field[key]), "invalid_resource_schema_field");
    assert(field.minimum === undefined || field.maximum === undefined || Number(field.minimum) <= Number(field.maximum), "invalid_resource_schema_field");
  }
  return Object.freeze({ schemaVersion: "1.0", fields: Object.freeze(fields as Record<string, ExtensionResourceFieldSchema>) });
}

function parseResourceRequirements(value: unknown): ExtensionResourceRequirement[] {
  assert(Array.isArray(value) && value.length <= 32, "invalid_resource_requirements");
  const ids = new Set<string>();
  return value.map(rawValue => {
    assert(rawValue !== null && typeof rawValue === "object" && !Array.isArray(rawValue), "invalid_resource_requirement");
    const raw = rawValue as Record<string, unknown>;
    assert(Object.keys(raw).every(key => ["id", "kind", "apiVersion", "scope", "operations", "limits", "binding"].includes(key)), "invalid_resource_requirement_field");
    assert(typeof raw.id === "string" && /^[a-z][a-z0-9._-]{1,63}$/.test(raw.id) && !ids.has(raw.id), "invalid_resource_requirement_id"); ids.add(raw.id);
    assert((EXTENSION_RESOURCE_CAPABILITIES as readonly { kind: string; apiVersion: string }[]).some(item => item.kind === raw.kind && item.apiVersion === raw.apiVersion), "unsupported_resource_api_version");
    assert(["installation", "project", "space"].includes(String(raw.scope)), "invalid_resource_scope");
    assert(Array.isArray(raw.operations) && raw.operations.length > 0 && raw.operations.length <= 32, "invalid_resource_operations");
    const operationIds = new Set<string>();
    const operations = raw.operations.map(value => {
      assert(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_resource_operation");
      const operation = value as Record<string, unknown>;
      assert(Object.keys(operation).every(key => ["id", "input", "output", "idempotency", "meteringUnit"].includes(key)), "invalid_resource_operation_field");
      assert(typeof operation.id === "string" && /^[a-z][a-z0-9._-]{1,63}$/.test(operation.id) && !operationIds.has(operation.id), "invalid_resource_operation_id"); operationIds.add(operation.id);
      assert(operation.idempotency === "required" || operation.idempotency === "none", "invalid_resource_idempotency");
      assert(["request", "byte", "job"].includes(String(operation.meteringUnit)), "invalid_resource_metering_unit");
      return Object.freeze({ id: operation.id, input: parseResourceSchema(operation.input), output: parseResourceSchema(operation.output),
        idempotency: operation.idempotency, meteringUnit: operation.meteringUnit }) as ExtensionResourceOperation;
    });
    assert(raw.limits !== null && typeof raw.limits === "object" && !Array.isArray(raw.limits), "invalid_resource_limits");
    const limits = raw.limits as Record<string, unknown>;
    assert(Object.keys(limits).every(key => ["requestsPerMinute", "maxConcurrent", "maxBytesPerOperation"].includes(key)), "invalid_resource_limit_field");
    assert(Number.isInteger(limits.requestsPerMinute) && Number(limits.requestsPerMinute) >= 1 && Number(limits.requestsPerMinute) <= 1000
      && Number.isInteger(limits.maxConcurrent) && Number(limits.maxConcurrent) >= 1 && Number(limits.maxConcurrent) <= 64
      && Number.isInteger(limits.maxBytesPerOperation) && Number(limits.maxBytesPerOperation) >= 1 && Number(limits.maxBytesPerOperation) <= 10 * 1024 * 1024, "invalid_resource_limits");
    let binding: ExtensionStructuredDataBinding | ExtensionJobsBinding | ExtensionKnowledgeBinding | undefined;
    if (raw.binding !== undefined) {
      assert((raw.kind === "structured_data" || raw.kind === "jobs" || raw.kind === "knowledge") && raw.binding !== null && typeof raw.binding === "object" && !Array.isArray(raw.binding), "resource_binding_kind_mismatch");
      const bindingRaw = raw.binding as Record<string, unknown>;
      if (raw.kind === "structured_data") {
        assert(Object.keys(bindingRaw).every(key => key === "gadgetId" || key === "tables"), "invalid_resource_binding_field");
        assert(typeof bindingRaw.gadgetId === "string" && /^[a-z][a-z0-9_-]{1,63}$/.test(bindingRaw.gadgetId), "invalid_resource_binding_gadget");
        assert(Array.isArray(bindingRaw.tables) && bindingRaw.tables.length > 0 && bindingRaw.tables.length <= 64
          && new Set(bindingRaw.tables).size === bindingRaw.tables.length
          && bindingRaw.tables.every(table => typeof table === "string" && /^[a-z][a-z0-9_-]{0,62}$/.test(table)), "invalid_resource_binding_tables");
        binding = Object.freeze({ gadgetId: bindingRaw.gadgetId, tables: Object.freeze([...(bindingRaw.tables as string[])].sort()) });
      } else if (raw.kind === "jobs") {
        assert(Object.keys(bindingRaw).every(key => key === "workflowIds"), "invalid_resource_binding_field");
        assert(Array.isArray(bindingRaw.workflowIds) && bindingRaw.workflowIds.length > 0 && bindingRaw.workflowIds.length <= 32
          && new Set(bindingRaw.workflowIds).size === bindingRaw.workflowIds.length
          && bindingRaw.workflowIds.every(id => typeof id === "string" && /^[a-z][a-z0-9._-]{1,63}$/.test(id)), "invalid_resource_binding_workflows");
        binding = Object.freeze({ workflowIds: Object.freeze([...(bindingRaw.workflowIds as string[])].sort()) });
      } else {
        assert(Object.keys(bindingRaw).every(key => key === "publicationIds"), "invalid_resource_binding_field");
        assert(Array.isArray(bindingRaw.publicationIds) && bindingRaw.publicationIds.length > 0 && bindingRaw.publicationIds.length <= 16
          && new Set(bindingRaw.publicationIds).size === bindingRaw.publicationIds.length
          && bindingRaw.publicationIds.every(id => typeof id === "string" && /^[a-z][a-z0-9_-]{2,63}$/.test(id)), "invalid_resource_binding_publications");
        binding = Object.freeze({ publicationIds: Object.freeze([...(bindingRaw.publicationIds as string[])].sort()) });
      }
    }
    assert(raw.kind !== "structured_data" || (raw.scope === "project" && binding !== undefined && "gadgetId" in binding), "structured_data_project_gadget_binding_required");
    assert(raw.kind !== "jobs" || (raw.scope === "project" && binding !== undefined && "workflowIds" in binding), "jobs_project_workflow_binding_required");
    assert(raw.kind !== "knowledge" || (raw.scope === "project" && binding !== undefined && "publicationIds" in binding), "knowledge_project_publication_binding_required");
    assert(raw.kind !== "objects" || binding === undefined, "resource_binding_kind_mismatch");
    if (raw.kind === "structured_data") {
      const allowedOperations = new Set(["list", "get", "insert", "update", "delete"]);
      assert(operations.every(operation => allowedOperations.has(operation.id)), "structured_data_operation_unsupported");
      assert(operations.filter(operation => ["insert", "update", "delete"].includes(operation.id)).every(operation => operation.idempotency === "required"), "structured_data_write_idempotency_required");
      for (const operation of operations) {
        const inputFields = operation.input.fields, outputFields = operation.output.fields;
        const expectedInputFields = operation.id === "list" ? ["table", "filterJson", "limit"]
          : operation.id === "get" || operation.id === "delete" ? ["table", "id"]
          : operation.id === "insert" ? ["table", "recordJson"] : ["table", "id", "recordJson"];
        assert(Object.keys(inputFields).every(key => expectedInputFields.includes(key))
          && inputFields.table?.type === "string" && inputFields.table.required === true
          && (inputFields.table.maxLength ?? 0) > 0 && inputFields.table.maxLength! <= 63, "structured_data_operation_schema_invalid");
        if (operation.id === "get" || operation.id === "delete" || operation.id === "update")
          assert(inputFields.id?.type === "string" && inputFields.id.required === true
            && (inputFields.id.maxLength ?? 0) > 0 && inputFields.id.maxLength! <= 256, "structured_data_operation_schema_invalid");
        if (operation.id === "insert" || operation.id === "update")
          assert(inputFields.recordJson?.type === "string" && inputFields.recordJson.required === true
            && (inputFields.recordJson.maxLength ?? 0) > 0 && inputFields.recordJson.maxLength! <= Number(limits.maxBytesPerOperation), "structured_data_operation_schema_invalid");
        if (inputFields.filterJson) assert(operation.id === "list" && inputFields.filterJson.type === "string"
          && (inputFields.filterJson.maxLength ?? 0) > 0 && inputFields.filterJson.maxLength! <= Number(limits.maxBytesPerOperation), "structured_data_operation_schema_invalid");
        if (inputFields.limit) assert(operation.id === "list" && inputFields.limit.type === "number" && inputFields.limit.required !== true
          && (inputFields.limit.minimum ?? 0) >= 1 && (inputFields.limit.maximum ?? 0) >= Number(inputFields.limit.minimum ?? 1)
          && inputFields.limit.maximum! <= 100, "structured_data_operation_schema_invalid");
        assert(Object.keys(outputFields).length === 1 && outputFields.resultJson?.type === "string" && outputFields.resultJson.required === true
          && (outputFields.resultJson.maxLength ?? 0) > 0 && outputFields.resultJson.maxLength! <= Number(limits.maxBytesPerOperation), "structured_data_operation_schema_invalid");
      }
    } else if (raw.kind === "objects") {
      assert(raw.scope === "project" && Number(limits.maxBytesPerOperation) <= 256 * 1024, "object_resource_scope_or_limit_unsupported");
      assert(operations.every(operation => ["get", "put", "delete"].includes(operation.id)), "object_resource_operation_unsupported");
      assert(operations.filter(operation => ["put", "delete"].includes(operation.id)).every(operation => operation.idempotency === "required"),
        "object_resource_mutation_idempotency_required");
      for (const operation of operations) {
        const inputFields = operation.input.fields, outputFields = operation.output.fields;
        const expectedInput = operation.id === "put" ? ["key", "dataBase64", "contentType"] : ["key"];
        const expectedOutput = operation.id === "get" ? ["found", "dataBase64", "contentType", "size", "sha256"]
          : operation.id === "put" ? ["stored", "size", "sha256"] : ["deleted"];
        assert(Object.keys(inputFields).every(key => expectedInput.includes(key)) && Object.keys(inputFields).length === expectedInput.length
          && inputFields.key?.type === "string" && inputFields.key.required === true
          && (inputFields.key.maxLength ?? 0) > 0 && inputFields.key.maxLength! <= 128, "object_resource_operation_schema_invalid");
        if (operation.id === "put") assert(inputFields.dataBase64?.type === "string" && inputFields.dataBase64.required === true
          && (inputFields.dataBase64.maxLength ?? 0) > 0 && inputFields.dataBase64.maxLength! <= 87_384
          && inputFields.contentType?.type === "string" && inputFields.contentType.required === true
          && (inputFields.contentType.maxLength ?? 0) > 0 && inputFields.contentType.maxLength! <= 128, "object_resource_operation_schema_invalid");
        assert(Object.keys(outputFields).every(key => expectedOutput.includes(key)) && Object.keys(outputFields).length === expectedOutput.length,
          "object_resource_operation_schema_invalid");
        if (operation.id === "get") assert(outputFields.found?.type === "boolean" && outputFields.found.required === true
          && outputFields.size?.type === "number" && outputFields.size.required === true && outputFields.size.minimum === 0
          && outputFields.size.maximum !== undefined && outputFields.size.maximum <= 65_536
          && outputFields.dataBase64?.type === "string" && outputFields.dataBase64.required !== true
          && (outputFields.dataBase64.maxLength ?? 0) > 0 && outputFields.dataBase64.maxLength! <= 87_384
          && outputFields.contentType?.type === "string" && outputFields.contentType.required !== true
          && (outputFields.contentType.maxLength ?? 0) > 0 && outputFields.contentType.maxLength! <= 128
          && outputFields.sha256?.type === "string" && outputFields.sha256.required !== true && outputFields.sha256.maxLength === 64,
        "object_resource_operation_schema_invalid");
        if (operation.id === "put") assert(outputFields.stored?.type === "boolean" && outputFields.stored.required === true
          && outputFields.size?.type === "number" && outputFields.size.required === true && outputFields.size.minimum === 0
          && outputFields.size.maximum !== undefined && outputFields.size.maximum <= 65_536
          && outputFields.sha256?.type === "string" && outputFields.sha256.required === true && outputFields.sha256.maxLength === 64,
        "object_resource_operation_schema_invalid");
        if (operation.id === "delete") assert(outputFields.deleted?.type === "boolean" && outputFields.deleted.required === true,
          "object_resource_operation_schema_invalid");
      }
    } else if (raw.kind === "jobs") {
      assert(binding !== undefined && "workflowIds" in binding, "jobs_project_workflow_binding_required");
      assert(operations.every(operation => operation.id === "enqueue" || operation.id === "status"), "jobs_operation_unsupported");
      assert(operations.some(operation => operation.id === "enqueue"), "jobs_enqueue_operation_required");
      for (const operation of operations) {
        const inputFields = operation.input.fields, outputFields = operation.output.fields;
        if (operation.id === "enqueue") {
          assert(operation.idempotency === "required" && operation.meteringUnit === "job", "jobs_enqueue_metering_or_idempotency_invalid");
          assert(Object.keys(inputFields).every(key => ["workflowId", "paramsJson", "deadlineSeconds"].includes(key))
            && inputFields.workflowId?.type === "string" && inputFields.workflowId.required === true && inputFields.workflowId.maxLength === 64
            && (inputFields.paramsJson === undefined || inputFields.paramsJson.type === "string" && inputFields.paramsJson.required !== true
              && (inputFields.paramsJson.maxLength ?? 0) > 0 && inputFields.paramsJson.maxLength! <= Number(limits.maxBytesPerOperation))
            && (inputFields.deadlineSeconds === undefined || inputFields.deadlineSeconds.type === "number" && inputFields.deadlineSeconds.required !== true
              && inputFields.deadlineSeconds.minimum === 1 && inputFields.deadlineSeconds.maximum !== undefined
              && inputFields.deadlineSeconds.maximum <= 86_400), "jobs_enqueue_schema_invalid");
          assert(Object.keys(outputFields).length === 2 && outputFields.jobId?.type === "string" && outputFields.jobId.required === true
            && outputFields.jobId.maxLength === 128 && outputFields.status?.type === "string" && outputFields.status.required === true
            && outputFields.status.maxLength === 16, "jobs_enqueue_output_invalid");
        } else {
          assert(operation.idempotency === "none" && operation.meteringUnit === "request", "jobs_status_metering_or_idempotency_invalid");
          assert(Object.keys(inputFields).length === 1 && inputFields.jobId?.type === "string" && inputFields.jobId.required === true
            && inputFields.jobId.maxLength === 128, "jobs_status_input_invalid");
          assert(Object.keys(outputFields).length === 3 && outputFields.jobId?.type === "string" && outputFields.jobId.required === true
            && outputFields.jobId.maxLength === 128 && outputFields.status?.type === "string" && outputFields.status.required === true
            && outputFields.status.maxLength === 16 && outputFields.attempt?.type === "number" && outputFields.attempt.required === true
            && outputFields.attempt.minimum === 0 && outputFields.attempt.maximum !== undefined && outputFields.attempt.maximum <= 5,
          "jobs_status_output_invalid");
        }
      }
    } else if (raw.kind === "knowledge") {
      assert(operations.length === 1 && operations[0]?.id === "search" && operations[0].idempotency === "none"
        && operations[0].meteringUnit === "request", "knowledge_operation_unsupported");
      const operation = operations[0]!;
      const inputFields = operation.input.fields, outputFields = operation.output.fields;
      assert(Object.keys(inputFields).every(key => ["publicationId", "query", "topK"].includes(key))
        && inputFields.publicationId?.type === "string" && inputFields.publicationId.required === true
        && inputFields.publicationId.maxLength !== undefined && inputFields.publicationId.maxLength <= 64
        && inputFields.query?.type === "string" && inputFields.query.required === true
        && inputFields.query.maxLength !== undefined && inputFields.query.maxLength <= 1000
        && (inputFields.topK === undefined || inputFields.topK.type === "number" && inputFields.topK.required !== true
          && inputFields.topK.minimum !== undefined && inputFields.topK.minimum >= 1 && inputFields.topK.maximum !== undefined && inputFields.topK.maximum <= 3),
        "knowledge_search_input_schema_invalid");
      assert(Object.keys(outputFields).length === 1 && outputFields.resultJson?.type === "string"
        && outputFields.resultJson.required === true && outputFields.resultJson.maxLength !== undefined
        && outputFields.resultJson.maxLength <= 32_768, "knowledge_search_output_schema_invalid");
    }
    return Object.freeze({ id: raw.id, kind: raw.kind, apiVersion: "1.0", scope: raw.scope,
      operations: Object.freeze(operations), limits: Object.freeze({ ...limits }), ...(binding ? { binding } : {}) }) as ExtensionResourceRequirement;
  });
}

export function validateExtensionResourceValue(schema: ExtensionResourceObjectSchema, value: unknown, label = "value"): Record<string, unknown> {
  if (!schema || schema.schemaVersion !== "1.0" || !schema.fields || typeof schema.fields !== "object" || Array.isArray(schema.fields)) throw new Error("resource_schema_invalid");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`resource_${label}_object_required`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!Object.hasOwn(schema.fields, key)) throw new Error(`resource_${label}_unknown_field:${key}`);
  for (const [key, field] of Object.entries(schema.fields)) {
    const item = record[key];
    if (item === undefined) { if (field.required) throw new Error(`resource_${label}_required:${key}`); continue; }
    if (field.type === "string") {
      if (typeof item !== "string" || field.maxLength !== undefined && new TextEncoder().encode(item).byteLength > field.maxLength) throw new Error(`resource_${label}_invalid:${key}`);
    } else if (field.type === "number") {
      if (typeof item !== "number" || !Number.isFinite(item) || field.minimum !== undefined && item < field.minimum || field.maximum !== undefined && item > field.maximum) throw new Error(`resource_${label}_invalid:${key}`);
    } else if (typeof item !== "boolean") throw new Error(`resource_${label}_invalid:${key}`);
  }
  return record;
}

/** Resolve a runtime request through the signed workflow declaration. Returns only an operation
 * already authorized by the worker role; callers must still recheck the current installation. */
export function resolveExtensionStructuredDataRequest(input: {
  manifest: Pick<ExtensionManifest, "bundle" | "resourceRequirements">;
  workflowId: string; requirementId: string; operationId: string; input: unknown;
}): { gadgetId: string; gadgetOperation: string; table: string; arguments: Record<string, unknown>; outputSchema: ExtensionResourceObjectSchema } | null {
  const requirement = input.manifest.resourceRequirements?.find(item => item.id === input.requirementId && item.kind === "structured_data");
  const binding = requirement?.binding;
  const operation = requirement?.operations.find(item => item.id === input.operationId);
  if (!requirement || requirement.scope !== "project" || !binding || !("gadgetId" in binding) || !operation) return null;
  let value: Record<string, unknown>;
  try { value = validateExtensionResourceValue(operation.input, input.input, "input"); } catch { return null; }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > requirement.limits.maxBytesPerOperation) return null;
  const table = value.table;
  if (typeof table !== "string" || !binding.tables.includes(table)) return null;
  const bundle = input.manifest.bundle;
  const workflow = bundle?.primitives.find((part): part is WorkflowContract => part.kind === "workflow" && part.id === input.workflowId);
  const gadgetOperation = `extension.gadget.${operation.id}`;
  const roles = bundle?.workerRoles?.filter(role => role.principal === "project_member" && role.execution === "worker"
    && ["workflow_step", "tool"].includes(role.invocation) && role.entry === workflow?.entry && role.primitiveIds.includes(input.workflowId)) ?? [];
  if (!workflow?.toolNames.includes("extension.resource.structured_data") || !workflow.toolNames.includes(gadgetOperation) || roles.length !== 1
    || !roles[0]?.gadgetActions?.some(grant => grant.gadgetId === binding.gadgetId && grant.operations.includes(gadgetOperation) && grant.tables.includes(table))) return null;
  const args: Record<string, unknown> = { table };
  try {
    if (operation.id === "list") {
      if (typeof value.filterJson === "string") {
        const filter: unknown = JSON.parse(value.filterJson);
        if (!filter || typeof filter !== "object" || Array.isArray(filter)) return null;
        args.filter = filter;
      }
      if (value.limit !== undefined) args.limit = value.limit;
    } else if (operation.id === "get" || operation.id === "delete") args.id = value.id;
    if (operation.id === "insert" || operation.id === "update") {
      if (operation.id === "update") args.id = value.id;
      const record: unknown = JSON.parse(String(value.recordJson));
      if (!record || typeof record !== "object" || Array.isArray(record)) return null;
      args.record = record;
    }
  } catch { return null; }
  return { gadgetId: binding.gadgetId, gadgetOperation, table, arguments: args, outputSchema: operation.output };
}

/** Resolves a declared object operation through one signed Project workflow role. The object
 * key remains a logical name; the host maps it inside the exact installation namespace. */
export function resolveExtensionObjectResourceRequest(input: {
  manifest: Pick<ExtensionManifest, "bundle" | "resourceRequirements">;
  workflowId: string; requirementId: string; operationId: string; input: unknown;
}): { key: string; value: Record<string, unknown>; operation: ExtensionResourceOperation; outputSchema: ExtensionResourceObjectSchema } | null {
  const requirement = input.manifest.resourceRequirements?.find(item => item.id === input.requirementId && item.kind === "objects");
  const operation = requirement?.operations.find(item => item.id === input.operationId);
  if (!requirement || requirement.scope !== "project" || !operation) return null;
  let value: Record<string, unknown>;
  try { value = validateExtensionResourceValue(operation.input, input.input, "input"); } catch { return null; }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > requirement.limits.maxBytesPerOperation || !isExtensionObjectKey(value.key)) return null;
  if (operation.id === "put" && (!decodeExtensionObjectBase64(value.dataBase64) || !isExtensionObjectContentType(value.contentType))) return null;
  const bundle = input.manifest.bundle;
  const workflow = bundle?.primitives.find((part): part is WorkflowContract => part.kind === "workflow" && part.id === input.workflowId);
  const roles = bundle?.workerRoles?.filter(role => role.principal === "project_member" && role.execution === "worker"
    && ["workflow_step", "tool"].includes(role.invocation) && role.entry === workflow?.entry && role.primitiveIds.includes(input.workflowId)) ?? [];
  if (!workflow?.toolNames.includes("extension.resource.objects") || roles.length !== 1) return null;
  return { key: value.key, value, operation, outputSchema: operation.output };
}

/** Resolve a jobs call only to a same-package workflow explicitly named in the signed binding.
 * Target workflows cannot hold the jobs capability, which prevents recursive queue fan-out. */
export function resolveExtensionJobResourceRequest(input: {
  manifest: Pick<ExtensionManifest, "bundle" | "resourceRequirements">;
  workflowId: string; requirementId: string; operationId: string; input: unknown;
}): { operation: ExtensionResourceOperation; outputSchema: ExtensionResourceObjectSchema; jobId?: string;
  targetWorkflowId?: string; params?: Record<string, unknown>; deadlineSeconds?: number } | null {
  const requirement = input.manifest.resourceRequirements?.find(item => item.id === input.requirementId && item.kind === "jobs");
  const binding = requirement?.binding;
  const operation = requirement?.operations.find(item => item.id === input.operationId);
  if (!requirement || requirement.scope !== "project" || !binding || !("workflowIds" in binding) || !operation) return null;
  let value: Record<string, unknown>;
  try { value = validateExtensionResourceValue(operation.input, input.input, "input"); } catch { return null; }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > requirement.limits.maxBytesPerOperation) return null;
  const bundle = input.manifest.bundle;
  const workflows = bundle?.primitives.filter((part): part is WorkflowContract => part.kind === "workflow") ?? [];
  const caller = workflows.find(workflow => workflow.id === input.workflowId);
  const roles = bundle?.workerRoles ?? [];
  const callerRoles = caller ? roles.filter(role => role.principal === "project_member" && role.execution === "worker"
    && ["workflow_step", "tool"].includes(role.invocation) && role.entry === caller.entry && role.primitiveIds.includes(caller.id)) : [];
  if (!caller?.toolNames.includes("extension.resource.jobs") || callerRoles.length !== 1) return null;
  if (input.operationId === "status") return typeof value.jobId === "string"
    ? { operation, outputSchema: operation.output, jobId: value.jobId } : null;
  const targetWorkflowId = value.workflowId;
  const target = typeof targetWorkflowId === "string" && binding.workflowIds.includes(targetWorkflowId)
    ? workflows.find(workflow => workflow.id === targetWorkflowId) : undefined;
  const targetRoles = target ? roles.filter(role => role.principal === "project_member" && role.execution === "worker"
    && ["workflow_step", "tool"].includes(role.invocation) && role.entry === target.entry && role.primitiveIds.includes(target.id)) : [];
  if (!target || targetRoles.length !== 1 || target.toolNames.includes("extension.resource.jobs")) return null;
  let params: unknown = {};
  try { if (typeof value.paramsJson === "string") params = JSON.parse(value.paramsJson); } catch { return null; }
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const paramsJson = JSON.stringify(params);
  if (new TextEncoder().encode(paramsJson).byteLength > requirement.limits.maxBytesPerOperation) return null;
  const deadlineSeconds = value.deadlineSeconds;
  if (deadlineSeconds !== undefined && (!Number.isSafeInteger(deadlineSeconds) || Number(deadlineSeconds) < 1 || Number(deadlineSeconds) > 86_400)) return null;
  return { operation, outputSchema: operation.output, targetWorkflowId: target.id, params: params as Record<string, unknown>,
    ...(deadlineSeconds !== undefined ? { deadlineSeconds: Number(deadlineSeconds) } : {}) };
}

/** Resolve a read-only Knowledge search to an explicitly owner-published collection named by
 * the signed Project workflow requirement. Current publication and owner grant are rechecked by
 * the host adapter for every call. */
export function resolveExtensionKnowledgeResourceRequest(input: {
  manifest: Pick<ExtensionManifest, "bundle" | "resourceRequirements">;
  workflowId: string; requirementId: string; operationId: string; input: unknown;
}): { publicationId: string; query: string; topK: number; operation: ExtensionResourceOperation;
  outputSchema: ExtensionResourceObjectSchema } | null {
  const requirement = input.manifest.resourceRequirements?.find(item => item.id === input.requirementId && item.kind === "knowledge");
  const binding = requirement?.binding;
  const operation = requirement?.operations.find(item => item.id === input.operationId);
  if (!requirement || requirement.scope !== "project" || !binding || !("publicationIds" in binding)
    || input.operationId !== "search" || !operation) return null;
  let value: Record<string, unknown>;
  try { value = validateExtensionResourceValue(operation.input, input.input, "input"); } catch { return null; }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > requirement.limits.maxBytesPerOperation
    || typeof value.publicationId !== "string" || !binding.publicationIds.includes(value.publicationId)
    || typeof value.query !== "string" || !value.query.trim() || value.query.length > 1000) return null;
  const bundle = input.manifest.bundle;
  const workflow = bundle?.primitives.find((part): part is WorkflowContract => part.kind === "workflow" && part.id === input.workflowId);
  const roles = bundle?.workerRoles?.filter(role => role.principal === "project_member" && role.execution === "worker"
    && ["workflow_step", "tool"].includes(role.invocation) && role.entry === workflow?.entry && role.primitiveIds.includes(input.workflowId)) ?? [];
  if (!workflow?.toolNames.includes("extension.resource.knowledge") || roles.length !== 1) return null;
  const topK = value.topK === undefined ? 3 : value.topK;
  if (typeof topK !== "number" || !Number.isInteger(topK) || topK < 1 || topK > 3) return null;
  return { publicationId: value.publicationId, query: value.query.trim(), topK, operation, outputSchema: operation.output };
}

function sameResourceScope(a: ExtensionResourceExecutionScope, b: ExtensionResourceExecutionScope): boolean {
  return a.tenantId === b.tenantId && a.spaceId === b.spaceId && a.projectId === b.projectId
    && a.installationId === b.installationId && a.principalId === b.principalId;
}
/** Runtime adapter must receive grants already verified and issued by the host. */
export function createExtensionResourceClient(requirements: readonly ExtensionResourceRequirement[], grants: readonly HostIssuedExtensionResourceGrant[],
  scope: ExtensionResourceExecutionScope, adapter: ExtensionResourceAdapter, now: () => number = Date.now): ExtensionResourceClient {
  const requested = new Map(requirements.map(item => [item.id, item]));
  const approved = new Map(grants.map(item => [item.requirementId, item]));
  const requestTimes = new Map<string, number[]>();
  const concurrent = new Map<string, number>();
  return Object.freeze({ async execute<T>(requirementId: string, operation: string, input: unknown, idempotencyKey?: string): Promise<T> {
    const requirement = requested.get(requirementId);
    if (!requirement) throw new Error("resource_requirement_not_declared");
    const grant = approved.get(requirementId);
    if (!grant || grant.status !== "active" || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now()) throw new Error("resource_grant_unavailable");
    if (grant.kind !== requirement.kind || grant.apiVersion !== requirement.apiVersion || !sameResourceScope(grant.scope, scope)) throw new Error("resource_grant_scope_mismatch");
    if (requirement.scope === "project" && !scope.projectId || requirement.scope === "space" && scope.projectId !== null)
      throw new Error("resource_grant_scope_mismatch");
    const declaration = requirement.operations.find(item => item.id === operation);
    if (!declaration || !grant.operations.includes(operation)) throw new Error("resource_operation_denied");
    validateExtensionResourceValue(declaration.input, input, "input");
    if (declaration.idempotency === "required" && !(typeof idempotencyKey === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey))) throw new Error("resource_idempotency_key_required");
    const inputBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    if (inputBytes > requirement.limits.maxBytesPerOperation) throw new Error("resource_operation_size_exceeded");
    const timestamp = now(), recent = (requestTimes.get(requirementId) ?? []).filter(item => timestamp - item < 60_000);
    if (recent.length >= requirement.limits.requestsPerMinute) throw new Error("resource_rate_limit_exceeded");
    const active = concurrent.get(requirementId) ?? 0;
    if (active >= requirement.limits.maxConcurrent) throw new Error("resource_concurrency_limit_exceeded");
    recent.push(timestamp); requestTimes.set(requirementId, recent); concurrent.set(requirementId, active + 1);
    try {
      const result = await adapter.execute<T>({ handle: grant.handle, requirementId, operation, scope, input, inputBytes,
        meteringUnit: declaration.meteringUnit, ...(idempotencyKey ? { idempotencyKey } : {}) });
      const output = validateExtensionResourceValue(declaration.output, result, "output");
      if (new TextEncoder().encode(JSON.stringify(output)).byteLength > requirement.limits.maxBytesPerOperation) throw new Error("resource_operation_size_exceeded");
      return result;
    } finally { concurrent.set(requirementId, Math.max(0, (concurrent.get(requirementId) ?? 1) - 1)); }
  } });
}
/** Local authoring fixture only. Its generated handles/grants are simulated and cannot be used by
 * the SpaceDO host broker. Tests can inject deterministic provider successes and failures here. */
export function createLocalExtensionResourceHarness(requirements: readonly ExtensionResourceRequirement[], scope: ExtensionResourceExecutionScope,
  simulate: (request: ExtensionResourceOperationRequest) => Promise<unknown>, now: () => number = Date.now): {
    mode: "simulated"; grants: readonly HostIssuedExtensionResourceGrant[]; client: ExtensionResourceClient;
  } {
  const grants = requirements.map(requirement => ({ handle: `simulated:${requirement.id}`, requirementId: requirement.id,
    kind: requirement.kind, apiVersion: requirement.apiVersion, scope, operations: requirement.operations.map(operation => operation.id),
    status: "active" as const, expiresAt: new Date(now() + 60 * 60_000).toISOString() }));
  return Object.freeze({ mode: "simulated" as const, grants: Object.freeze(grants),
    client: createExtensionResourceClient(requirements, grants, scope, { async execute<T>(request: ExtensionResourceOperationRequest) { return await simulate(request) as T; } }, now) });
}

function validateExtensionMigrations(value: unknown): void {
  assert(Array.isArray(value) && value.length <= 128, "invalid_migrations");
  let previous = 0;
  for (const item of value) {
    assert(item !== null && typeof item === "object" && !Array.isArray(item), "invalid_migration");
    const migration = item as Record<string, unknown>;
    assert(Object.keys(migration).every(key => ["version", "description", "up"].includes(key)), "invalid_migration_field");
    assert(Number.isSafeInteger(migration.version) && Number(migration.version) > previous, "migration_versions_must_increase");
    assert(typeof migration.description === "string" && migration.description.trim().length > 0 && migration.description.length <= 256, "invalid_migration_description");
    assert(typeof migration.up === "string" && migration.up.length > 0 && migration.up.length <= 64_000, "invalid_migration_sql");
    previous = Number(migration.version);
  }
}

function rejectKernelOverrides(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const active = new WeakSet<object>();
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (current.exit) { active.delete(current.value as object); continue; }
    if (!current.value || typeof current.value !== "object") continue;
    assert(++visited <= 100_000 && current.depth <= 64, "manifest_complexity_limit");
    assert(!active.has(current.value), "manifest_cycle");
    active.add(current.value);
    pending.push({ value: current.value, depth: current.depth, exit: true });
    for (const [key, nested] of Object.entries(current.value as Record<string, unknown>)) {
      assert(!FORBIDDEN_KEY.test(key), `forbidden_field:${key}`);
      pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
}

export interface ExtensionValidationContext { gatekeeperCapabilities: readonly string[] }
/** Strict parser used at the trust boundary before an extension is persisted. */
export function validateExtensionManifest(value: LegacyExtensionManifest): LegacyExtensionManifest;
export function validateExtensionManifest(value: unknown, context?: ExtensionValidationContext): ExtensionManifest;
export function validateExtensionManifest(value: unknown, context?: ExtensionValidationContext): ExtensionManifest | LegacyExtensionManifest {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "object_required");
  const raw = value as Record<string, unknown>;
  if ("version" in raw) {
    if (raw.bundle !== undefined) throw new Error("legacy_extension_bundle_requires_modular_manifest");
    return validateLegacyManifest(raw);
  }
  rejectKernelOverrides(raw);
  const allowed = new Set(["id", "releaseVersion", "type", "declaredPermissions", "capabilityRequirements", "gadgets", "daemons", "commands", "channels", "containers", "bundle", "shared_filesystem", "widgetSubscriptions", "settingsSchema", "settingsActivation", "dependencies", "resourceRequirements"]);
  for (const key of Object.keys(raw)) assert(allowed.has(key), `unknown_field:${key}`);
  assert(typeof raw.id === "string", "invalid_id");
  try { assertExtensionId(raw.id); } catch { throw new Error("invalid_extension_manifest:invalid_id"); }
  let dependencies: ExtensionDependency[] | undefined;
  const resourceRequirements = raw.resourceRequirements === undefined ? undefined : parseResourceRequirements(raw.resourceRequirements);
  if (raw.dependencies !== undefined) {
    assert(Array.isArray(raw.dependencies) && raw.dependencies.length <= 32, "invalid_dependencies");
    const seen = new Set<string>();
    dependencies = (raw.dependencies as unknown[]).map(value => {
      assert(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_dependency");
      const dependency = value as Record<string, unknown>;
      assert(Object.keys(dependency).every(key => ["extensionId", "version", "manifestSha256"].includes(key)), "invalid_dependency_field");
      assert(typeof dependency.extensionId === "string", "invalid_dependency_id");
      try { assertExtensionId(dependency.extensionId); } catch { throw new Error("invalid_extension_manifest:invalid_dependency_id"); }
      assert(dependency.extensionId !== raw.id && !seen.has(dependency.extensionId), "duplicate_or_self_dependency");
      seen.add(dependency.extensionId);
      assert(typeof dependency.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(dependency.version), "invalid_dependency_version");
      assert(typeof dependency.manifestSha256 === "string" && /^[a-f0-9]{64}$/.test(dependency.manifestSha256), "invalid_dependency_manifest_digest");
      return Object.freeze({ extensionId: dependency.extensionId, version: dependency.version, manifestSha256: dependency.manifestSha256 });
    }).sort((left, right) => left.extensionId.localeCompare(right.extensionId));
  }
  assert(raw.type === "extension", "invalid_type");
  assert(raw.releaseVersion === undefined || (typeof raw.releaseVersion === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw.releaseVersion)), "invalid_release_version");
  assert(raw.settingsActivation === undefined || raw.settingsActivation === "owner_publish", "invalid_settings_activation");
  assert(raw.settingsActivation === undefined || raw.settingsSchema !== undefined, "settings_activation_schema_required");
  assert(Array.isArray(raw.declaredPermissions) && raw.declaredPermissions.length <= 128 && raw.declaredPermissions.every((p) => typeof p === "string" && PERMISSION.test(p)), "invalid_permissions");
  assert(Array.isArray(raw.capabilityRequirements) && raw.capabilityRequirements.length > 0 && raw.capabilityRequirements.length <= 128 && raw.capabilityRequirements.every((p) => typeof p === "string" && PERMISSION.test(p)), "capability_requirements_required");
  if (context) {
    const granted = new Set(context.gatekeeperCapabilities);
    for (const capability of raw.capabilityRequirements as string[]) assert(granted.has(capability), `gatekeeper_capability_denied:${capability}`);
  }
  let settingsSchema: ExtensionSettingsSchema | undefined;
  if (raw.settingsSchema !== undefined) {
    assert(raw.settingsSchema !== null && typeof raw.settingsSchema === "object" && !Array.isArray(raw.settingsSchema), "invalid_settings_schema");
    const schema = raw.settingsSchema as Record<string, unknown>;
    assert(Object.keys(schema).every(key => key === "schemaVersion" || key === "fields"), "unknown_settings_schema_field");
    assert(schema.schemaVersion === 1 || schema.schemaVersion === 2, "unsupported_settings_schema_version");
    try { settingsSchema = { schemaVersion: schema.schemaVersion, fields: validateSetupFieldDefinitions(schema.fields, { schemaVersion: schema.schemaVersion }) }; }
    catch (error) { throw new Error(`invalid_extension_manifest:invalid_settings_schema:${error instanceof Error ? error.message : "invalid"}`); }
    assert((raw.capabilityRequirements as string[]).includes("extension.settings.read")
      && (raw.declaredPermissions as string[]).includes("extension.settings.read"), "settings_read_capability_required");
  }
  const hasSettingsCapability = (raw.capabilityRequirements as string[]).some(capability => capability.startsWith("extension.settings."));
  assert(!hasSettingsCapability || settingsSchema !== undefined, "settings_schema_required");
  if ((raw.capabilityRequirements as string[]).includes("extension.settings.configure"))
    assert((raw.declaredPermissions as string[]).includes("extension.settings.configure"), "settings_configure_permission_required");
  const templateSetupCapabilities = raw.capabilityRequirements as string[];
  const templateSetupPermissions = raw.declaredPermissions as string[];
  const hasTemplateSetupCapability = templateSetupCapabilities.some(capability => capability.startsWith("template.setup."));
  if (hasTemplateSetupCapability) {
    assert(templateSetupCapabilities.includes("template.setup.read") && templateSetupPermissions.includes("template.setup.read"), "template_setup_read_capability_required");
  }
  if (templateSetupCapabilities.includes("template.setup.configure"))
    assert(templateSetupPermissions.includes("template.setup.configure"), "template_setup_configure_permission_required");
  let widgetSubscriptions: ExtensionWidgetSubscription[] | undefined;
  if (raw.widgetSubscriptions !== undefined) {
    assert(Array.isArray(raw.widgetSubscriptions) && raw.widgetSubscriptions.length <= 32, "invalid_widget_subscriptions");
    assert((raw.capabilityRequirements as string[]).includes("events.subscribe") && (raw.declaredPermissions as string[]).includes("events.subscribe"), "widget_event_capability_required");
    const seen = new Set<string>();
    widgetSubscriptions = (raw.widgetSubscriptions as unknown[]).map(value => {
      assert(value && typeof value === "object" && !Array.isArray(value), "invalid_widget_subscription");
      const item = value as Record<string, unknown>;
      assert(Object.keys(item).every(key => key === "event" || key === "component"), "invalid_widget_subscription_field");
      assert(typeof item.event === "string" && (WIDGET_EVENT_TYPES as readonly string[]).includes(item.event), "invalid_widget_event");
      assert(typeof item.component === "string" && SAFE_PATH.test(item.component) && !FORBIDDEN_SCRIPT.test(item.component), "invalid_widget_component");
      const key = `${item.event}:${item.component}`;
      assert(!seen.has(key), "duplicate_widget_subscription"); seen.add(key);
      return Object.freeze({ event: item.event as WidgetEventType, component: item.component });
    });
  }
  let canonicalSharedFilesystem: SharedFilesystemGrant[] | undefined;
  if (raw.shared_filesystem !== undefined) {
    assert(Array.isArray(raw.shared_filesystem) && raw.shared_filesystem.length <= 64, "invalid_shared_filesystem");
    const capabilities = new Set(raw.capabilityRequirements as string[]);
    canonicalSharedFilesystem = (raw.shared_filesystem as unknown[]).map((item) => {
      assert(item && typeof item === "object" && !Array.isArray(item), "invalid_shared_filesystem_grant");
      const grant = item as Record<string, unknown>;
      assert(Object.keys(grant).every(key => key === "path" || key === "access"), "invalid_shared_filesystem_grant_field");
      assert(typeof grant.path === "string" && /^\/space\/shared\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)+$/.test(grant.path)
        && grant.path.length <= 256 && !grant.path.includes("..") && !grant.path.includes("\\") && !grant.path.includes("//"), "invalid_shared_filesystem_path");
      assert(grant.access === "READ" || grant.access === "READ_WRITE", "invalid_shared_filesystem_access");
      assert(capabilities.has("space.shared.read"), "shared_filesystem_read_capability_required");
      if (grant.access === "READ_WRITE") assert(capabilities.has("space.shared.write"), "shared_filesystem_write_capability_required");
      return Object.freeze({ path: grant.path, access: grant.access });
    });
  }
  assert(Array.isArray(raw.gadgets) && raw.gadgets.length <= 128
    && Array.isArray(raw.daemons) && raw.daemons.length <= 64
    && Array.isArray(raw.commands) && raw.commands.length <= 256, "arrays_required_or_limit_exceeded");
  let canonicalBundle: ExtensionBundleManifest | undefined;
  let canonicalChannels = raw.channels;
  if (raw.bundle !== undefined) {
    canonicalBundle = parseExtensionBundle(raw.bundle);
    assert(canonicalBundle.id === raw.id, "bundle_extension_id_mismatch");
    const businessActionsRequired = canonicalBundle.primitives.some((primitive): primitive is GadgetContract =>
      primitive.kind === "gadget" && (primitive.businessActions?.length ?? 0) > 0);
    assert(!businessActionsRequired || (raw.capabilityRequirements as unknown[]).includes("extension.gadget.business_action"), "business_action_package_capability_required");
    const channels = canonicalBundle.primitives.filter((primitive): primitive is ChannelContract => primitive.kind === "channel");
    if (raw.channels !== undefined) {
      assert(Array.isArray(raw.channels), "invalid_channels");
      const legacyChannels = (raw.channels as unknown[]).map(parseExtensionPrimitive);
      assert(JSON.stringify(legacyChannels) === JSON.stringify(channels), "bundle_channel_declaration_mismatch");
    }
    canonicalChannels = channels;
  }
  for (const requirement of resourceRequirements ?? []) {
    if (requirement.kind !== "structured_data") continue;
    const binding = requirement.binding;
    assert(binding !== undefined && "gadgetId" in binding, "structured_data_project_gadget_binding_required");
    assert(canonicalBundle !== undefined, "structured_data_bundle_required");
    const gadget = canonicalBundle.primitives.find((item): item is GadgetContract => item.kind === "gadget" && item.id === binding.gadgetId);
    assert(gadget?.scope === "PROJECT_BOUND", "structured_data_gadget_must_be_project_bound");
    const workflows = canonicalBundle.primitives.filter((item): item is WorkflowContract => item.kind === "workflow");
    const roles = canonicalBundle.workerRoles ?? [];
    for (const operation of requirement.operations) {
      const toolName = `extension.gadget.${operation.id}`;
      const authorized = workflows.some(workflow => workflow.toolNames.includes(toolName)
        && workflow.toolNames.includes("extension.resource.structured_data")
        && roles.some(role => role.principal === "project_member" && role.execution === "worker"
          && ["workflow_step", "tool"].includes(role.invocation) && role.entry === workflow.entry
          && role.primitiveIds.includes(workflow.id)
          && role.gadgetActions?.some(grant => grant.gadgetId === binding.gadgetId
            && grant.operations.includes(toolName) && binding.tables.every(table => grant.tables.includes(table)))));
      assert(authorized, "structured_data_binding_exceeds_installed_workflow_grant");
    }
  }
  for (const requirement of resourceRequirements ?? []) {
    if (requirement.kind !== "objects") continue;
    assert(requirement.scope === "project" && canonicalBundle !== undefined, "object_resource_project_bundle_required");
    const workflows = canonicalBundle.primitives.filter((item): item is WorkflowContract => item.kind === "workflow");
    const roles = canonicalBundle.workerRoles ?? [];
    const authorized = workflows.some(workflow => workflow.toolNames.includes("extension.resource.objects")
      && roles.filter(role => role.principal === "project_member" && role.execution === "worker"
        && ["workflow_step", "tool"].includes(role.invocation) && role.entry === workflow.entry && role.primitiveIds.includes(workflow.id)).length === 1);
    assert(authorized, "object_resource_workflow_role_required");
  }
  for (const requirement of resourceRequirements ?? []) {
    if (requirement.kind !== "jobs") continue;
    const binding = requirement.binding;
    assert(requirement.scope === "project" && canonicalBundle !== undefined && binding !== undefined && "workflowIds" in binding,
      "jobs_project_workflow_bundle_required");
    const workflows = canonicalBundle.primitives.filter((item): item is WorkflowContract => item.kind === "workflow");
    const roles = canonicalBundle.workerRoles ?? [];
    const roleCount = (workflow: WorkflowContract) => roles.filter(role => role.principal === "project_member" && role.execution === "worker"
      && ["workflow_step", "tool"].includes(role.invocation) && role.entry === workflow.entry && role.primitiveIds.includes(workflow.id)).length;
    assert(workflows.some(workflow => workflow.toolNames.includes("extension.resource.jobs") && roleCount(workflow) === 1),
      "jobs_workflow_role_required");
    for (const targetId of binding.workflowIds) {
      const target = workflows.find(workflow => workflow.id === targetId);
      assert(target !== undefined && roleCount(target) === 1 && !target.toolNames.includes("extension.resource.jobs"),
        "jobs_target_workflow_invalid_or_recursive");
    }
  }
  for (const requirement of resourceRequirements ?? []) {
    if (requirement.kind !== "knowledge") continue;
    assert(requirement.scope === "project" && canonicalBundle !== undefined && requirement.binding !== undefined
      && "publicationIds" in requirement.binding, "knowledge_resource_project_bundle_required");
    const workflows = canonicalBundle.primitives.filter((item): item is WorkflowContract => item.kind === "workflow");
    const roles = canonicalBundle.workerRoles ?? [];
    const authorized = workflows.some(workflow => workflow.toolNames.includes("extension.resource.knowledge")
      && roles.filter(role => role.principal === "project_member" && role.execution === "worker"
        && ["workflow_step", "tool"].includes(role.invocation) && role.entry === workflow.entry && role.primitiveIds.includes(workflow.id)).length === 1);
    assert(authorized, "knowledge_resource_workflow_role_required");
  }
  const scopes = new Set<GadgetScope>(["SPACE_WIDE", "PROJECT_BOUND", "USER_PRIVATE", "PROJECT_SHARED", "PROJECT_USER", "SPACE_SHARED", "SPACE_USER"]);
  const ids = new Set<string>();
  for (const item of raw.gadgets as Record<string, unknown>[]) {
    assert(item && typeof item === "object", "invalid_gadget");
    assert(typeof item.id === "string" && ID.test(item.id) && !ids.has(item.id), "invalid_gadget_id"); ids.add(item.id);
    assert(typeof item.name === "string" && item.name.trim().length > 0, "invalid_gadget_name");
    assert(typeof item.viewportComponent === "string" && SAFE_PATH.test(item.viewportComponent), "invalid_viewport");
    assert(scopes.has(item.scope as GadgetScope), "invalid_gadget_scope");
    assert(item.gadgetTier === 1 || item.gadgetTier === 2 || item.gadgetTier === 3, "invalid_gadget_tier");
    assert(item.gadgetTier !== 1 || ["USER_PRIVATE", "PROJECT_USER", "SPACE_USER"].includes(String(item.scope)), "tier_1_must_be_user_private");
    assert(item.gadgetTier !== 2 || ["PROJECT_BOUND", "PROJECT_SHARED", "PROJECT_USER"].includes(String(item.scope)), "tier_2_scope_invalid");
    assert(item.gadgetTier !== 3 || ["PROJECT_BOUND", "PROJECT_SHARED", "SPACE_WIDE", "SPACE_SHARED"].includes(String(item.scope)), "tier_3_scope_invalid");
    assert(typeof item.defaultSchemaSql === "string" && item.defaultSchemaSql.length <= 64_000, "invalid_schema");
    assert(!FORBIDDEN_SCRIPT.test(item.defaultSchemaSql), "unsafe_schema");
    if (item.migrations !== undefined) validateExtensionMigrations(item.migrations);
    if (item.businessActions !== undefined) {
      assert(Array.isArray(item.businessActions) && item.businessActions.length <= 32, "invalid_business_actions");
      const actionIds = new Set<string>();
      for (const value of item.businessActions as unknown[]) {
        let action: ExtensionBusinessAction;
        try { action = validateExtensionBusinessAction(value); } catch { throw new Error("invalid_extension_manifest:invalid_business_action"); }
        assert(!actionIds.has(action.id), "duplicate_business_action_id"); actionIds.add(action.id);
        assert(action.installationScope === item.scope && action.dataScope === item.scope, "business_action_scope_mismatch");
        assert((raw.capabilityRequirements as unknown[]).includes("extension.gadget.business_action"), "business_action_package_capability_required");
        assert((raw.declaredPermissions as string[]).includes(action.permission), "business_action_permission_required");
      }
    }
  }
  for (const item of raw.daemons as Record<string, unknown>[]) {
    assert(item && typeof item === "object", "invalid_daemon");
    assert(typeof item.id === "string" && ID.test(item.id) && !ids.has(item.id), "invalid_daemon_id"); ids.add(item.id);
    assert(typeof item.name === "string" && item.name.trim().length > 0, "invalid_daemon_name");
    assert(typeof item.workflowScript === "string" && SAFE_PATH.test(item.workflowScript) && !FORBIDDEN_SCRIPT.test(item.workflowScript), "invalid_workflow_script");
    assert(scopes.has(item.memoryScope as RuntimeScope), "invalid_memory_scope");
    assert(item.schedule === undefined || (typeof item.schedule === "string" && item.schedule.length <= 128), "invalid_schedule");
  }
  for (const item of raw.commands as Record<string, unknown>[]) {
    assert(item && typeof item.name === "string" && COMMAND.test(item.name), "invalid_command_name");
    assert(typeof item.scriptPath === "string" && SAFE_PATH.test(item.scriptPath) && !FORBIDDEN_SCRIPT.test(item.scriptPath), "invalid_command_path");
  }
  if (canonicalChannels !== undefined) {
    assert(Array.isArray(canonicalChannels) && canonicalChannels.length <= 32, "invalid_channels");
    const channelIds = new Set<string>();
    for (const item of canonicalChannels as unknown[]) {
      const channel = parseExtensionPrimitive(item);
      assert(channel.kind === "channel" && !channelIds.has(channel.id), "invalid_channel_kind_or_duplicate");
      channelIds.add(channel.id);
    }
  }
  if (raw.containers !== undefined) {
    assert(Array.isArray(raw.containers) && raw.containers.length <= 16, "invalid_containers");
    const containerIds = new Set<string>();
    for (const item of raw.containers as unknown[]) {
      const container = parseExtensionPrimitive(item);
      assert(container.kind === "container" && !containerIds.has(container.id), "invalid_container_kind_or_duplicate");
      containerIds.add(container.id);
    }
  }
  return { ...raw, ...(widgetSubscriptions ? { widgetSubscriptions: Object.freeze(widgetSubscriptions) } : {}), ...(canonicalSharedFilesystem ? { shared_filesystem: Object.freeze(canonicalSharedFilesystem) } : {}), ...(canonicalBundle ? { bundle: canonicalBundle } : {}), ...(canonicalChannels !== undefined ? { channels: canonicalChannels } : {}), ...(settingsSchema ? { settingsSchema } : {}), ...(dependencies ? { dependencies: Object.freeze(dependencies) as unknown as ExtensionDependency[] } : {}), ...(resourceRequirements ? { resourceRequirements: Object.freeze(resourceRequirements) as unknown as ExtensionResourceRequirement[] } : {}) } as unknown as ExtensionManifest;
}

/** Resolve an exact, same-scope dependency graph against admitted installation pins. The caller
 * supplies only active installations visible to the target package's own scope/project. */
export async function resolveExtensionDependencyClosure(
  root: ExtensionManifest,
  installed: readonly InstalledExtensionDependencyPin[],
): Promise<{ resolved: true; dependencies: Array<{ extensionId: string; version: string; manifestSha256: string }> }
  | { resolved: false; error: "dependency_unresolved" | "dependency_pin_conflict" | "dependency_cycle" | "dependency_manifest_invalid" }> {
  const requested = new Map<string, { version: string; manifestSha256: string }>();
  const visiting = new Set<string>([root.id]);
  const visited = new Set<string>();
  const closure = new Map<string, { extensionId: string; version: string; manifestSha256: string }>();
  type DependencyResolutionError = "dependency_unresolved" | "dependency_pin_conflict" | "dependency_cycle" | "dependency_manifest_invalid";
  const walk = async (manifest: ExtensionManifest): Promise<DependencyResolutionError | null> => {
    for (const dependency of manifest.dependencies ?? []) {
      if (visiting.has(dependency.extensionId)) return "dependency_cycle";
      const prior = requested.get(dependency.extensionId);
      if (prior && (prior.version !== dependency.version || prior.manifestSha256 !== dependency.manifestSha256)) return "dependency_pin_conflict";
      requested.set(dependency.extensionId, { version: dependency.version, manifestSha256: dependency.manifestSha256 });
      const candidates = installed.filter(item => item.extensionId === dependency.extensionId && item.releaseVersion === dependency.version);
      if (!candidates.length) return installed.some(item => item.extensionId === dependency.extensionId) ? "dependency_pin_conflict" : "dependency_unresolved";
      let selected: { manifest: ExtensionManifest; manifestSha256: string } | undefined;
      for (const candidate of candidates) {
        try {
          const parsed = validateExtensionManifest(candidate.manifest);
          if (!parsed.bundle || parsed.bundle.version !== dependency.version) continue;
          const digest = await digestExtensionManifest(parsed);
          if (digest === candidate.manifestSha256 && digest === dependency.manifestSha256) {
            selected = { manifest: parsed, manifestSha256: digest };
            break;
          }
        } catch { /* Invalid or non-modular installs cannot satisfy exact package dependencies. */ }
      }
      if (!selected) return "dependency_pin_conflict";
      const key = `${dependency.extensionId}@${dependency.version}:${dependency.manifestSha256}`;
      closure.set(dependency.extensionId, { extensionId: dependency.extensionId, version: dependency.version, manifestSha256: dependency.manifestSha256 });
      if (visited.has(key)) continue;
      visiting.add(dependency.extensionId);
      const childError = await walk(selected.manifest);
      visiting.delete(dependency.extensionId);
      if (childError) return childError;
      visited.add(key);
    }
    return null;
  };
  const error = await walk(root);
  return error ? { resolved: false, error } : { resolved: true, dependencies: [...closure.values()].sort((left, right) => left.extensionId.localeCompare(right.extensionId)) };
}

export function validateExtensionSettingsValues(manifest: Pick<ExtensionManifest, "settingsSchema">, raw: unknown, options: { allowIncomplete?: boolean } = {}): Record<string, BlueprintSetupValue> {
  if (!manifest.settingsSchema || (manifest.settingsSchema.schemaVersion !== 1 && manifest.settingsSchema.schemaVersion !== 2)) throw new Error("extension_settings_schema_unavailable");
  return validateSetupFieldValues(manifest.settingsSchema.fields, raw, options);
}

/** Verify a file path is contained in an installed Space-shared directory grant. */
export function isSharedFilesystemPathAllowed(grants: readonly SharedFilesystemGrant[], path: string, access: "read" | "write"): boolean {
  if (typeof path !== "string" || !path || path.length > 1024 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  if (segments.some(part => !part || part === "." || part === ".." || new TextEncoder().encode(part).byteLength > 255)) return false;
  const absolute = `/space/shared/${path}`;
  return grants.some(grant => (grant.access === "READ_WRITE" || access === "read") && absolute.startsWith(grant.path));
}

const LEGACY_PERMISSIONS = new Set<ExtensionPermission>(["storage:read", "storage:write", "network", "mcp:expose", "alarms"]);
function validateLegacyManifest(raw: Record<string, unknown>): LegacyExtensionManifest {
  if (!(typeof raw.id === "string" && /^[a-z][a-z0-9-]{1,62}$/.test(raw.id) && typeof raw.version === "string" && /^\d+\.\d+\.\d+$/.test(raw.version))) throw new Error("invalid extension identity");
  if (!(Array.isArray(raw.permissions) && raw.permissions.every((p) => LEGACY_PERMISSIONS.has(p as ExtensionPermission)))) throw new Error("unknown extension permission");
  assert(Array.isArray(raw.tools) && raw.tools.every((tool) => typeof tool === "string"), "invalid_legacy_tools");
  if (!(Number.isInteger(raw.maxRetries) && Number(raw.maxRetries) >= 0 && Number(raw.maxRetries) <= 5)) throw new Error("extension retries must be between 0 and 5");
  if (!(raw.alarmIntervalMs === undefined || (typeof raw.alarmIntervalMs === "number" && raw.alarmIntervalMs >= 1_000 && raw.alarmIntervalMs <= 86_400_000))) throw new Error("extension alarm interval is out of bounds");
  if (!(raw.alarmIntervalMs === undefined || (raw.permissions as unknown[]).includes("alarms"))) throw new Error("alarms permission is required");
  return Object.freeze({ ...(raw as unknown as LegacyExtensionManifest), permissions: Object.freeze([...(raw.permissions as ExtensionPermission[])]), tools: Object.freeze([...(raw.tools as string[])]) });
}

export function requireExtensionPermission(manifest: LegacyExtensionManifest, permission: ExtensionPermission): void {
  if (!manifest.permissions.includes(permission)) throw new Error(`extension permission denied: ${permission}`);
}

/** Legacy workspace-object key helper retained for already-installed Phase 1 extensions. */
export function gadgetStorageKey(tenantId: string, spaceId: string, projectId: string, gadgetId: string, key: string): string {
  const fields = [tenantId, spaceId, projectId, gadgetId];
  if (fields.some((field) => !/^[A-Za-z0-9_-]{1,128}$/.test(field)) || !key || key.includes("..") || key.startsWith("/")) throw new Error("invalid gadget storage scope");
  return `gadgets/${tenantId}/${spaceId}/${projectId}/${gadgetId}/${key}`;
}

// Versioned, domain-neutral extension contract. The npm package version is intentionally
// independent from this wire schema so old manifests can be adapted safely.
export type ExtensionSchemaVersion = "1.0";
export type ExtensionPrimitiveKind = "gadget" | "canvas" | "channel" | "container" | "linter" | "workflow";
export interface PermissionDeclaration { scope: GadgetScope; actions: readonly PermissionAction[]; resource: string; }
export interface LifecycleContract { onInstall?: string; onLoad?: string; onUnload?: string; onDelete?: string; }
export interface BudgetContract { maxCredits?: number; maxDurationSeconds?: number; maxConcurrency?: number; }
export interface CancellationContract { owner: "invoker" | "project" | "space_owner" | "admin"; graceSeconds: number; }
export interface ExtensionContractBase {
  schemaVersion: ExtensionSchemaVersion;
  id: string;
  version: string;
  permissions: readonly PermissionDeclaration[];
  capabilityRequirements: readonly string[];
  lifecycle: LifecycleContract;
  budget?: BudgetContract;
  cancellation?: CancellationContract;
}
export interface ExtensionSqlMigration { version: number; description: string; up: string; }
export interface GadgetContract extends ExtensionContractBase {
  kind: "gadget"; scope: GadgetScope; schemaSql?: string; migrations?: readonly ExtensionSqlMigration[];
  /** Named host-executed operations. They are separate from generic CRUD permissions. */
  businessActions?: readonly ExtensionBusinessAction[];
}
export interface CanvasContract extends ExtensionContractBase {
  kind: "canvas";
  layout: CanvasLayout | "CanvasMount";
  component: string;
  dynamicPage: boolean;
  /** Read-only Gadget tables this canvas may render. Mutations still go through worker/tool grants. */
  gadgetReads?: readonly { gadgetId: string; tables: readonly string[] }[];
}
/**
 * A channel primitive is invoked for untrusted external events. Its host context is deliberately
 * distinct from member initiated workflows: it contains only the normalized channel event and
 * channel-scoped operations (reply and, when granted, conversation storage). It never implies
 * access to a Space Assistant, planner, project tools, credentials, or workspace files.
 */
export interface ChannelContract extends ExtensionContractBase {
  kind: "channel";
  provider: string;
  /** Optional reference to the host-managed connection requirement used by this handler. */
  connectionId?: string;
  /** Script path inside the installed extension bundle. */
  handlerScript: string;
  /** Versioned least-privilege host surface; other context kinds require a different contract. */
  context: "channel_only";
  inboundEvents: readonly string[];
  outboundEvents: readonly string[];
  /** Named owner-published project collections the channel host may retrieve before dispatch. */
  knowledgeCollections?: readonly string[];
  /** Explicit opt-in to bounded host-mediated access to files on this exact inbound message. */
  attachmentAccess?: { mode: "read_text" | "read_image"; maxFiles?: number; maxTotalBytes?: number };
  /** Optional host-managed per-conversation state; disabled unless explicitly enabled. */
  session?: { enabled: true; maxBytes?: number; ttlDays?: number };
}
/** Runtime object exposed as `ctx.channel` to an installed channel handler. The provider's raw
 * webhook, signing secret, owner identity, Space/project APIs, and agent tools are not part of it. */
export interface ChannelOnlyExtensionContext {
  channel: {
    provider: string;
    event: { id: string; type: string; occurredAt: string; payload: Readonly<Record<string, unknown>> };
    conversation: { id: string };
    /** Validated settings from this exact installation, available only with extension.settings.read. */
    settings?: { schemaVersion: 1 | 2; revision: number; values: Readonly<Record<string, string | number | boolean>> };
    /** Request one host-bounded, source-grounded response; the handler cannot choose models or tools. */
    answer(input: { question: string; attachmentIds?: readonly string[] }): Promise<{ answerId: string }>;
    reply(message: { text: string }): Promise<{ messageId: string }>;
    /** Available only when the owner-approved channel declaration enables bounded session state. */
    session?: { get(): Promise<unknown>; set(value: unknown): Promise<{ saved: true }> };
  /** Several private records owned by this one external conversation. IDs are extension chosen
   * labels; the host always keys them under the verified project/install/conversation identity. */
  sessions?: { get(sessionId: string): Promise<unknown>; set(sessionId: string, value: unknown): Promise<{ saved: true }> };
  };
}
export interface ContainerContract extends ExtensionContractBase {
  kind: "container";
  /** Immutable OCI identity. The host must ALSO approve a deployed binding for this digest. */
  image: string;
  resources: { memoryMb: number; cpuCores: number; timeoutSeconds: number };
  exportedBinaries: readonly string[];
  /** Opt into concurrent worker runs only when the host creates a separate container instance
   *  and workspace for each worker branch. Omitted contracts remain single-slot. */
  parallelExecution?: { isolation: "worker_branch"; maxConcurrentWorkers: number };
  mounts?: readonly { path: "/workspace" | "/tmp" | "/home/runtime"; writable: boolean }[];
  networkPolicy?: "none" | "approved_proxy";
  webContainerCompatible?: boolean;
}
export interface LinterContract extends ExtensionContractBase { kind: "linter"; mode: "deterministic" | "semantic"; entry: string; failureMode: "warn" | "block"; }
export interface WorkflowContract extends ExtensionContractBase { kind: "workflow"; executionMode: ExecutionMode; entry: string; steps: readonly string[]; toolNames: readonly string[]; }
/** Narrow API available only to an internal project-member Durable Workflow role.
 * `toolNames` declares the workflow capability; the worker role's `gadgetActions` further limits
 * each operation to specific Gadget IDs and schema-declared tables. External channel handlers
 * never receive this context. */
export interface ExtensionWorkflowGadgets {
  list<T = unknown>(stepKey: string, gadgetId: string, table: string, options?: { filter?: Record<string, unknown>; limit?: number }): Promise<T>;
  get<T = unknown>(stepKey: string, gadgetId: string, table: string, id: string | number): Promise<T>;
  insert<T = unknown>(stepKey: string, gadgetId: string, table: string, record: Record<string, unknown>): Promise<T>;
  update<T = unknown>(stepKey: string, gadgetId: string, table: string, id: string | number, record: Record<string, unknown>): Promise<T>;
  delete<T = unknown>(stepKey: string, gadgetId: string, table: string, id: string | number): Promise<T>;
}
export interface ExtensionWorkflowContext<TParams = Record<string, unknown>> {
  readonly params: TParams;
  readonly gadgets: ExtensionWorkflowGadgets;
  readonly resources: ExtensionWorkflowResources;
  readonly tools: { call<T = unknown>(stepKey: string, operation: string, params: Record<string, unknown>): Promise<T> };
}
export type ExtensionPrimitiveManifest = GadgetContract | CanvasContract | ChannelContract | ContainerContract | LinterContract | WorkflowContract;
/**
 * A worker role is an invocation shape, not a trust boundary or a runtime tier.
 * Its authority is still derived from the primitive grants and host-issued install.
 */
export interface ExtensionWorkerRole {
  id: string;
  /** Who may cause this role to run; separate from invocation and compute placement. */
  principal: "project_member" | "space_owner" | "external_channel_subject" | "service";
  invocation: "subagent" | "workflow_step" | "tool";
  execution: "worker" | "container" | "web_container";
  entry: string;
  primitiveIds: readonly string[];
  /** Exact Gadget operations and tables this worker role may invoke from a workflow. */
  gadgetActions?: readonly { gadgetId: string; operations: readonly string[]; tables: readonly string[] }[];
}
/** Host-managed provider dependency. Secrets and transport always remain host-owned. */
export interface ExtensionConnectionRequirement {
  id: string;
  provider: string;
  purpose: string;
  required: boolean;
}
/** Named project knowledge that the owner may publish to a restricted public handler. */
export interface ExtensionKnowledgeRequirement {
  id: string;
  purpose: string;
  access: "member_only" | "owner_published_external";
}
export interface ExtensionBundleManifest {
  schemaVersion: ExtensionSchemaVersion;
  kind: "extension_bundle";
  id: string;
  version: string;
  primitives: readonly ExtensionPrimitiveManifest[];
  workerRoles?: readonly ExtensionWorkerRole[];
  connections?: readonly ExtensionConnectionRequirement[];
  knowledge?: readonly ExtensionKnowledgeRequirement[];
}

const CONTRACT_KINDS = new Set<ExtensionPrimitiveKind>(["gadget", "canvas", "channel", "container", "linter", "workflow"]);
const CONTRACT_ID = /^[a-z][a-z0-9._-]{1,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CONTRACT_PATH = /^(?=.{1,160}$)(?:\.\/)?(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$/;
const CONTRACT_SCOPE = new Set<GadgetScope>(["USER_PRIVATE", "SPACE_WIDE", "PROJECT_BOUND", "PROJECT_SHARED", "PROJECT_USER", "SPACE_SHARED", "SPACE_USER"]);
const CONTRACT_ACTIONS = new Set<PermissionAction>(["read", "write", "execute", "network", "admin"]);
const CONTRACT_BASE_KEYS = new Set(["schemaVersion", "kind", "id", "version", "permissions", "capabilityRequirements", "lifecycle", "budget", "cancellation"]);
function contractAssert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`invalid_extension_contract:${message}`); }
function rejectUnknownContractKeys(raw: Record<string, unknown>, allowed: Set<string>): void { for (const key of Object.keys(raw)) contractAssert(allowed.has(key), `unknown_field:${key}`); }
function validateContractBase(raw: Record<string, unknown>, kind: ExtensionPrimitiveKind): void {
  const specific = kind === "gadget" ? ["scope", "schemaSql", "migrations", "businessActions"] : kind === "canvas" ? ["layout", "component", "dynamicPage", "gadgetReads"] : kind === "channel" ? ["provider", "connectionId", "handlerScript", "context", "inboundEvents", "outboundEvents", "knowledgeCollections", "attachmentAccess", "session"] : kind === "container" ? ["image", "resources", "exportedBinaries", "parallelExecution", "mounts", "networkPolicy", "webContainerCompatible"] : kind === "linter" ? ["mode", "entry", "failureMode"] : ["executionMode", "entry", "steps", "toolNames"];
  rejectUnknownContractKeys(raw, new Set([...CONTRACT_BASE_KEYS, ...specific]));
  contractAssert(raw.schemaVersion === "1.0", `unsupported_schema_version:${String(raw.schemaVersion)}`);
  contractAssert(raw.kind === kind, `kind_mismatch:${kind}`);
  contractAssert(typeof raw.id === "string" && CONTRACT_ID.test(raw.id), "invalid_id");
  contractAssert(typeof raw.version === "string" && SEMVER.test(raw.version), "invalid_version");
  contractAssert(Array.isArray(raw.permissions), "permissions_required");
  for (const permission of raw.permissions as unknown[]) {
    contractAssert(permission !== null && typeof permission === "object" && !Array.isArray(permission), "invalid_permission");
    const item = permission as Record<string, unknown>;
    rejectUnknownContractKeys(item, new Set(["scope", "actions", "resource"]));
    contractAssert(CONTRACT_SCOPE.has(item.scope as RuntimeScope) && Array.isArray(item.actions) && item.actions.length > 0, "invalid_permission_scope");
    contractAssert((item.actions as unknown[]).every((action) => CONTRACT_ACTIONS.has(action as PermissionAction)), "invalid_permission_action");
    contractAssert(typeof item.resource === "string" && item.resource.length > 0 && item.resource.length <= 160, "invalid_permission_resource");
  }
  contractAssert(Array.isArray(raw.capabilityRequirements) && (raw.capabilityRequirements as unknown[]).every((item) => typeof item === "string" && CONTRACT_ID.test(item)), "invalid_capabilities");
  contractAssert(raw.lifecycle !== null && typeof raw.lifecycle === "object" && !Array.isArray(raw.lifecycle), "lifecycle_required");
  rejectUnknownContractKeys(raw.lifecycle as Record<string, unknown>, new Set(["onInstall", "onLoad", "onUnload", "onDelete"]));
  for (const value of Object.values(raw.lifecycle as Record<string, unknown>)) contractAssert(typeof value === "string" && CONTRACT_PATH.test(value), "invalid_lifecycle_hook");
  if (raw.budget !== undefined) {
    contractAssert(raw.budget !== null && typeof raw.budget === "object" && !Array.isArray(raw.budget), "invalid_budget");
    rejectUnknownContractKeys(raw.budget as Record<string, unknown>, new Set(["maxCredits", "maxDurationSeconds", "maxConcurrency"]));
    for (const value of Object.values(raw.budget as Record<string, unknown>)) contractAssert(typeof value === "number" && Number.isFinite(value) && value >= 0, "invalid_budget_value");
  }
  if (raw.cancellation !== undefined) {
    contractAssert(raw.cancellation !== null && typeof raw.cancellation === "object" && !Array.isArray(raw.cancellation), "invalid_cancellation");
    rejectUnknownContractKeys(raw.cancellation as Record<string, unknown>, new Set(["owner", "graceSeconds"]));
    const cancellation = raw.cancellation as Record<string, unknown>;
    contractAssert(["invoker", "project", "space_owner", "admin"].includes(String(cancellation.owner)) && typeof cancellation.graceSeconds === "number" && cancellation.graceSeconds >= 0, "invalid_cancellation_value");
  }
}

export function parseExtensionPrimitive(value: unknown): ExtensionPrimitiveManifest {
  contractAssert(value !== null && typeof value === "object" && !Array.isArray(value), "object_required");
  const raw = value as Record<string, unknown>;
  contractAssert(raw.schemaVersion === "1.0", `unsupported_schema_version:${String(raw.schemaVersion)}`);
  contractAssert(CONTRACT_KINDS.has(raw.kind as ExtensionPrimitiveKind), `unknown_primitive_kind:${String(raw.kind)}`);
  const kind = raw.kind as ExtensionPrimitiveKind;
  validateContractBase(raw, kind);
  if (kind === "gadget") {
    contractAssert(CONTRACT_SCOPE.has(raw.scope as GadgetScope), "invalid_scope");
    if (raw.schemaSql !== undefined) contractAssert(typeof raw.schemaSql === "string" && raw.schemaSql.length <= 64000, "invalid_schema_sql");
    if (raw.migrations !== undefined) {
      try { validateExtensionMigrations(raw.migrations); } catch (error) { throw new Error(`invalid_extension_contract:${error instanceof Error ? error.message.replace("invalid_extension_manifest:", "") : "invalid_migrations"}`); }
    }
    if (raw.businessActions !== undefined) {
      contractAssert(Array.isArray(raw.businessActions) && raw.businessActions.length <= 32, "invalid_business_actions");
      const actionIds = new Set<string>();
      for (const value of raw.businessActions as unknown[]) {
        let action: ExtensionBusinessAction;
        try { action = validateExtensionBusinessAction(value); }
        catch { throw new Error("invalid_extension_contract:invalid_business_action"); }
        contractAssert(!actionIds.has(action.id), "duplicate_business_action_id"); actionIds.add(action.id);
        contractAssert(action.installationScope === raw.scope && action.dataScope === raw.scope, "business_action_scope_mismatch");
        contractAssert((raw.capabilityRequirements as unknown[]).includes("extension.gadget.business_action"), "business_action_capability_required");
        contractAssert((raw.permissions as Array<{ scope: string; actions: string[]; resource: string }>).some(permission =>
          permission.scope === raw.scope && permission.actions.includes(action.effects === "read_only" ? "read" : "write")
          && permission.resource === action.permission), "business_action_permission_required");
      }
    }
  }
  if (kind === "canvas") {
    contractAssert(["DualPane.Document", "DualPane.DataGrid", "CanvasMount"].includes(String(raw.layout)), "invalid_canvas_layout");
    contractAssert(typeof raw.component === "string" && CONTRACT_PATH.test(raw.component), "invalid_canvas_component");
    contractAssert(typeof raw.dynamicPage === "boolean", "invalid_canvas_dynamic_page");
    if (raw.gadgetReads !== undefined) {
      contractAssert(Array.isArray(raw.gadgetReads) && raw.gadgetReads.length <= 32, "invalid_canvas_gadget_reads");
      const seenGadgets = new Set<string>();
      for (const item of raw.gadgetReads as unknown[]) {
        contractAssert(item !== null && typeof item === "object" && !Array.isArray(item), "invalid_canvas_gadget_read");
        const grant = item as Record<string, unknown>;
        rejectUnknownContractKeys(grant, new Set(["gadgetId", "tables"]));
        contractAssert(typeof grant.gadgetId === "string" && CONTRACT_ID.test(grant.gadgetId) && !seenGadgets.has(grant.gadgetId), "invalid_canvas_gadget_id");
        contractAssert(Array.isArray(grant.tables) && grant.tables.length > 0 && grant.tables.length <= 64
          && new Set(grant.tables).size === grant.tables.length
          && (grant.tables as unknown[]).every(table => typeof table === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(table)), "invalid_canvas_gadget_tables");
        seenGadgets.add(grant.gadgetId);
      }
      contractAssert((raw.gadgetReads as unknown[]).length === 0 || (raw.capabilityRequirements as unknown[]).includes("extension.gadget.read"), "canvas_gadget_read_capability_required");
    }
  }
  if (kind === "channel") {
    // Public channel handlers execute for unauthenticated external senders. Their authority is
    // the channel-only context (normalized event + bounded reply), never extension-wide grants.
    // Reject privilege declarations here so a future dispatcher cannot accidentally interpret
    // a channel primitive as permission to call the member/project capability surface.
    contractAssert((raw.permissions as unknown[]).length === 0, "channel_permissions_forbidden");
    contractAssert((raw.capabilityRequirements as unknown[]).length === 0, "channel_capabilities_forbidden");
    contractAssert(typeof raw.provider === "string" && CONTRACT_ID.test(raw.provider), "invalid_channel_provider");
    contractAssert(raw.connectionId === undefined || (typeof raw.connectionId === "string" && CONTRACT_ID.test(raw.connectionId)), "invalid_channel_connection_reference");
    contractAssert(typeof raw.handlerScript === "string" && /^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(raw.handlerScript), "invalid_channel_handler");
    contractAssert(raw.context === "channel_only", "invalid_channel_context");
    for (const [field, events] of [["inboundEvents", raw.inboundEvents], ["outboundEvents", raw.outboundEvents]] as const) {
      contractAssert(Array.isArray(events) && events.length <= 64 && new Set(events).size === events.length, `invalid_${field}`);
      contractAssert((events as unknown[]).every((event) => typeof event === "string" && /^[a-z][a-z0-9_.:-]{0,63}$/.test(event)), `invalid_${field}`);
    }
    contractAssert((raw.inboundEvents as unknown[]).length > 0, "channel_inbound_events_required");
    contractAssert((raw.inboundEvents as unknown[]).includes("message.received"), "channel_message_event_required");
    contractAssert((raw.outboundEvents as unknown[]).includes("message.reply"), "channel_reply_event_required");
    if (raw.knowledgeCollections !== undefined) {
      contractAssert(Array.isArray(raw.knowledgeCollections) && raw.knowledgeCollections.length <= 16
        && new Set(raw.knowledgeCollections).size === raw.knowledgeCollections.length
        && (raw.knowledgeCollections as unknown[]).every(id => typeof id === "string" && /^[a-z][a-z0-9_-]{2,63}$/.test(id)
          && !/^(all|all[_-]|project[_-]?all|space[_-]?all)/i.test(id)), "invalid_channel_knowledge_collections");
    }
    if (raw.attachmentAccess !== undefined) {
      contractAssert(raw.attachmentAccess !== null && typeof raw.attachmentAccess === "object" && !Array.isArray(raw.attachmentAccess), "invalid_channel_attachment_access");
      const access = raw.attachmentAccess as Record<string, unknown>;
      rejectUnknownContractKeys(access, new Set(["mode", "maxFiles", "maxTotalBytes"]));
      contractAssert(access.mode === "read_text" || access.mode === "read_image", "invalid_channel_attachment_mode");
      if (access.mode === "read_text") {
        contractAssert(access.maxFiles === undefined || (Number.isInteger(access.maxFiles) && Number(access.maxFiles) >= 1 && Number(access.maxFiles) <= 3), "invalid_channel_attachment_max_files");
        contractAssert(access.maxTotalBytes === undefined || (Number.isInteger(access.maxTotalBytes) && Number(access.maxTotalBytes) >= 1 && Number(access.maxTotalBytes) <= 2 * 1024 * 1024), "invalid_channel_attachment_max_bytes");
      } else {
        contractAssert(access.maxFiles === undefined || access.maxFiles === 1, "invalid_channel_image_max_files");
        contractAssert(access.maxTotalBytes === undefined || (Number.isInteger(access.maxTotalBytes) && Number(access.maxTotalBytes) >= 1 && Number(access.maxTotalBytes) <= 480 * 1024), "invalid_channel_image_max_bytes");
      }
    }
    if (raw.session !== undefined) {
      contractAssert(raw.session !== null && typeof raw.session === "object" && !Array.isArray(raw.session), "invalid_channel_session");
      const session = raw.session as Record<string, unknown>;
      rejectUnknownContractKeys(session, new Set(["enabled", "maxBytes", "ttlDays"]));
      contractAssert(session.enabled === true, "channel_session_must_be_opt_in");
      contractAssert(session.maxBytes === undefined || (Number.isInteger(session.maxBytes) && Number(session.maxBytes) >= 1 && Number(session.maxBytes) <= 4_096), "invalid_channel_session_max_bytes");
      contractAssert(session.ttlDays === undefined || (Number.isInteger(session.ttlDays) && Number(session.ttlDays) >= 1 && Number(session.ttlDays) <= 90), "invalid_channel_session_ttl");
    }
    const budget = raw.budget as Record<string, unknown> | undefined;
    contractAssert(budget?.maxCredits === undefined || budget.maxCredits === 0, "channel_credit_budget_unsupported");
    contractAssert(budget?.maxConcurrency === undefined || (Number.isInteger(budget.maxConcurrency) && Number(budget.maxConcurrency) >= 1 && Number(budget.maxConcurrency) <= 4), "channel_concurrency_budget_exceeded");
    contractAssert(budget?.maxDurationSeconds === undefined || (Number.isFinite(budget.maxDurationSeconds) && Number(budget.maxDurationSeconds) >= 1 && Number(budget.maxDurationSeconds) <= 10), "channel_duration_budget_exceeded");
  }
  if (kind === "container") {
    contractAssert(typeof raw.image === "string" && raw.image.length <= 300 && /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(raw.image), "immutable_image_digest_required");
    contractAssert(raw.resources !== null && typeof raw.resources === "object" && !Array.isArray(raw.resources), "invalid_resources");
    const resources = raw.resources as Record<string, unknown>;
    rejectUnknownContractKeys(resources, new Set(["memoryMb", "cpuCores", "timeoutSeconds"]));
    for (const [key, limit] of [["memoryMb", 32768], ["cpuCores", 16], ["timeoutSeconds", 60]] as const)
      contractAssert(typeof resources[key] === "number" && Number.isFinite(resources[key]) && Number(resources[key]) > 0 && Number(resources[key]) <= limit, "invalid_resource_value:" + key);
    contractAssert(Array.isArray(raw.exportedBinaries) && raw.exportedBinaries.length > 0 && raw.exportedBinaries.length <= 64 && new Set(raw.exportedBinaries).size === raw.exportedBinaries.length && raw.exportedBinaries.every(item => typeof item === "string" && /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(item)), "invalid_exports");
    if (raw.parallelExecution !== undefined) {
      contractAssert(raw.parallelExecution !== null && typeof raw.parallelExecution === "object" && !Array.isArray(raw.parallelExecution), "invalid_parallel_execution");
      const parallel = raw.parallelExecution as Record<string, unknown>;
      rejectUnknownContractKeys(parallel, new Set(["isolation", "maxConcurrentWorkers"]));
      contractAssert(parallel.isolation === "worker_branch", "container_parallel_isolation_unsupported");
      contractAssert(Number.isInteger(parallel.maxConcurrentWorkers) && Number(parallel.maxConcurrentWorkers) >= 2 && Number(parallel.maxConcurrentWorkers) <= 4, "container_parallel_limit_exceeded");
    }
    contractAssert(raw.networkPolicy === undefined || raw.networkPolicy === "none" || raw.networkPolicy === "approved_proxy", "invalid_network_policy");
    contractAssert(raw.webContainerCompatible === undefined || typeof raw.webContainerCompatible === "boolean", "invalid_browser_compatibility");
    if (raw.mounts !== undefined) {
      contractAssert(Array.isArray(raw.mounts) && raw.mounts.length <= 3, "invalid_mounts");
      const paths = new Set<string>();
      for (const mount of raw.mounts as Record<string, unknown>[]) {
        contractAssert(mount !== null && typeof mount === "object" && !Array.isArray(mount), "invalid_mount");
        rejectUnknownContractKeys(mount, new Set(["path", "writable"]));
        contractAssert(["/workspace", "/tmp", "/home/runtime"].includes(String(mount.path)) && typeof mount.writable === "boolean" && !paths.has(String(mount.path)), "invalid_mount");
        paths.add(String(mount.path));
      }
    }
  }
  if (kind === "linter") {
    contractAssert(raw.mode === "deterministic" && CONTRACT_PATH.test(String(raw.entry)) && ["warn", "block"].includes(String(raw.failureMode)), "deterministic_linter_required");
  }
  if (kind === "workflow") contractAssert(["interactive", "headless"].includes(String(raw.executionMode)) && typeof raw.entry === "string" && /^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(raw.entry)
    && Array.isArray(raw.steps) && (raw.steps as unknown[]).every((item) => typeof item === "string" && CONTRACT_PATH.test(item))
    && Array.isArray(raw.toolNames) && raw.toolNames.length <= 64 && (raw.toolNames as unknown[]).every((item) => typeof item === "string" && CONTRACT_ID.test(item)), "invalid_workflow");
  return Object.freeze(raw as unknown as ExtensionPrimitiveManifest);
}
export function serializeExtensionPrimitive(value: ExtensionPrimitiveManifest): string { return JSON.stringify(parseExtensionPrimitive(value)); }

/** Strict package boundary for composed FDEs. This validates declarations only; installation
 * must still bind each declaration to host-authorized grants and immutable artifact contents. */
export function parseExtensionBundle(value: unknown): ExtensionBundleManifest {
  contractAssert(value !== null && typeof value === "object" && !Array.isArray(value), "bundle_object_required");
  const raw = value as Record<string, unknown>;
  rejectUnknownContractKeys(raw, new Set(["schemaVersion", "kind", "id", "version", "primitives", "workerRoles", "connections", "knowledge"]));
  contractAssert(raw.schemaVersion === "1.0" && raw.kind === "extension_bundle", "invalid_bundle_version_or_kind");
  contractAssert(typeof raw.id === "string" && CONTRACT_ID.test(raw.id), "invalid_bundle_id");
  contractAssert(typeof raw.version === "string" && SEMVER.test(raw.version), "invalid_bundle_version");
  contractAssert(Array.isArray(raw.primitives) && raw.primitives.length <= 128, "invalid_bundle_primitives");
  const primitives = (raw.primitives as unknown[]).map(parseExtensionPrimitive);
  const primitiveIds = new Set<string>();
  for (const primitive of primitives) {
    contractAssert(!primitiveIds.has(primitive.id), "duplicate_bundle_primitive_id");
    primitiveIds.add(primitive.id);
  }
  const gadgetPrimitives = new Map(primitives.filter((item): item is GadgetContract => item.kind === "gadget").map(item => [item.id, item]));
  for (const canvas of primitives.filter((item): item is CanvasContract => item.kind === "canvas")) {
    for (const grant of canvas.gadgetReads ?? []) contractAssert(gadgetPrimitives.get(grant.gadgetId)?.scope === "PROJECT_BOUND", "canvas_read_gadget_not_project_bound");
  }
  const workerRoles = raw.workerRoles;
  if (workerRoles !== undefined) {
    contractAssert(Array.isArray(workerRoles) && workerRoles.length <= 64, "invalid_worker_roles");
    const ids = new Set<string>();
    for (const item of workerRoles as unknown[]) {
      contractAssert(item !== null && typeof item === "object" && !Array.isArray(item), "invalid_worker_role");
      const role = item as Record<string, unknown>;
      rejectUnknownContractKeys(role, new Set(["id", "principal", "invocation", "execution", "entry", "primitiveIds", "gadgetActions"]));
      contractAssert(typeof role.id === "string" && CONTRACT_ID.test(role.id) && !ids.has(role.id), "invalid_worker_role_id");
      ids.add(role.id);
      contractAssert(["project_member", "space_owner", "external_channel_subject", "service"].includes(String(role.principal)), "invalid_worker_principal");
      contractAssert(["subagent", "workflow_step", "tool"].includes(String(role.invocation)), "invalid_worker_invocation");
      contractAssert(["worker", "container", "web_container"].includes(String(role.execution)), "invalid_worker_execution");
      contractAssert(typeof role.entry === "string" && CONTRACT_PATH.test(role.entry), "invalid_worker_entry");
      contractAssert(Array.isArray(role.primitiveIds) && new Set(role.primitiveIds).size === role.primitiveIds.length && (role.primitiveIds as unknown[]).every(id => typeof id === "string" && primitiveIds.has(id)), "invalid_worker_primitive_reference");
      if (role.gadgetActions !== undefined) {
        contractAssert(role.principal === "project_member" && ["workflow_step", "tool"].includes(String(role.invocation)), "invalid_worker_gadget_action_principal");
        contractAssert(Array.isArray(role.gadgetActions) && role.gadgetActions.length <= 32, "invalid_worker_gadget_actions");
        const grants = new Set<string>();
        for (const item of role.gadgetActions as unknown[]) {
          contractAssert(item !== null && typeof item === "object" && !Array.isArray(item), "invalid_worker_gadget_action");
          const grant = item as Record<string, unknown>;
          rejectUnknownContractKeys(grant, new Set(["gadgetId", "operations", "tables"]));
          contractAssert(typeof grant.gadgetId === "string" && CONTRACT_ID.test(grant.gadgetId), "invalid_worker_gadget_id");
          contractAssert(Array.isArray(grant.operations) && grant.operations.length > 0 && grant.operations.length <= 5
            && new Set(grant.operations).size === grant.operations.length
            && grant.operations.every(operation => typeof operation === "string" && ["extension.gadget.list", "extension.gadget.get", "extension.gadget.insert", "extension.gadget.update", "extension.gadget.delete"].includes(operation)), "invalid_worker_gadget_operations");
          contractAssert(Array.isArray(grant.tables) && grant.tables.length > 0 && grant.tables.length <= 64
            && new Set(grant.tables).size === grant.tables.length && grant.tables.every(table => typeof table === "string" && /^[a-z][a-z0-9_-]{0,62}$/.test(table)), "invalid_worker_gadget_tables");
          for (const operation of grant.operations as string[]) for (const table of grant.tables as string[]) {
            const key = `${grant.gadgetId}:${operation}:${table}`;
            contractAssert(!grants.has(key), "duplicate_worker_gadget_action"); grants.add(key);
          }
        }
      }
    }
  }
  for (const workflow of primitives.filter((item): item is WorkflowContract => item.kind === "workflow")) {
    contractAssert(Array.isArray(workerRoles) && (workerRoles as ExtensionWorkerRole[]).some(role => role.primitiveIds.includes(workflow.id)
      && role.entry === workflow.entry && ["workflow_step", "tool"].includes(role.invocation)), "workflow_worker_role_binding_required");
    const gadgetOperations = workflow.toolNames.filter(name => name.startsWith("extension.gadget."));
    contractAssert(gadgetOperations.every(name => ["extension.gadget.list", "extension.gadget.get", "extension.gadget.insert", "extension.gadget.update", "extension.gadget.delete"].includes(name))
      && (!gadgetOperations.length || primitives.some(item => item.kind === "gadget")), "invalid_workflow_gadget_capability");
    if (gadgetOperations.length) {
      const roles = (workerRoles as ExtensionWorkerRole[]).filter(role => role.principal === "project_member" && role.entry === workflow.entry && role.primitiveIds.includes(workflow.id)
        && ["workflow_step", "tool"].includes(role.invocation));
      contractAssert(roles.length === 1, "workflow_gadget_role_ambiguous");
      const role = roles[0]!;
      for (const grant of role.gadgetActions ?? []) {
        const gadget = primitives.find((item): item is GadgetContract => item.kind === "gadget" && item.id === grant.gadgetId);
        contractAssert(gadget, "worker_gadget_not_declared");
        contractAssert(grant.operations.every(operation => workflow.toolNames.includes(operation)), "worker_gadget_operation_not_declared");
        const schema = [gadget.schemaSql ?? "", ...(gadget.migrations ?? []).map(migration => migration.up)].join("\n");
        const declaredTables = new Set<string>();
        const createTable = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^\"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z][A-Za-z0-9_]*))/gi;
        for (const match of schema.matchAll(createTable)) declaredTables.add((match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").toLowerCase());
        contractAssert(grant.tables.every(table => declaredTables.has(table.toLowerCase())), "worker_gadget_table_not_declared");
      }
      for (const operation of gadgetOperations) contractAssert((role.gadgetActions ?? []).some(grant => grant.operations.includes(operation)), "workflow_gadget_action_grant_required");
    }
  }
  for (const role of (workerRoles ?? []) as ExtensionWorkerRole[]) for (const grant of role.gadgetActions ?? []) {
    contractAssert(primitives.some(item => item.kind === "workflow" && item.entry === role.entry && role.primitiveIds.includes(item.id)
      && grant.operations.every(operation => item.toolNames.includes(operation))), "worker_gadget_grant_workflow_mismatch");
  }
  for (const [field, max] of [["connections", 32], ["knowledge", 64]] as const) {
    const entries = raw[field];
    if (entries === undefined) continue;
    contractAssert(Array.isArray(entries) && entries.length <= max, `invalid_bundle_${field}`);
    const ids = new Set<string>();
    for (const item of entries as unknown[]) {
      contractAssert(item !== null && typeof item === "object" && !Array.isArray(item), `invalid_bundle_${field}_entry`);
      const entry = item as Record<string, unknown>;
      const allowed = field === "connections" ? new Set(["id", "provider", "purpose", "required"]) : new Set(["id", "purpose", "access"]);
      rejectUnknownContractKeys(entry, allowed);
      contractAssert(typeof entry.id === "string" && CONTRACT_ID.test(entry.id) && !ids.has(entry.id), `invalid_bundle_${field}_id`);
      ids.add(entry.id);
      contractAssert(typeof entry.purpose === "string" && entry.purpose.trim().length > 0 && entry.purpose.length <= 240, `invalid_bundle_${field}_purpose`);
      if (field === "connections") contractAssert(typeof entry.provider === "string" && CONTRACT_ID.test(entry.provider) && typeof entry.required === "boolean", "invalid_connection_requirement");
      else contractAssert(["member_only", "owner_published_external"].includes(String(entry.access)), "invalid_knowledge_access");
    }
  }
  const connections = new Map(((raw.connections ?? []) as Array<{ id: string; provider: string }>).map(connection => [connection.id, connection]));
  for (const primitive of primitives) {
    if (primitive.kind !== "channel" || !primitive.connectionId) continue;
    const connection = connections.get(primitive.connectionId);
    contractAssert(connection?.provider === primitive.provider, "invalid_channel_connection_provider_reference");
  }
  const knowledgeIds = new Set(((raw.knowledge ?? []) as Array<{ id: string }>).map(entry => entry.id));
  for (const primitive of primitives) {
    if (primitive.kind !== "channel" || !primitive.knowledgeCollections) continue;
    contractAssert(primitive.knowledgeCollections.every(id => knowledgeIds.has(id)), "invalid_channel_knowledge_reference");
    const externalKnowledgeIds = new Set(((raw.knowledge ?? []) as Array<{ id: string; access: string }>)
      .filter(entry => entry.access === "owner_published_external").map(entry => entry.id));
    contractAssert(primitive.knowledgeCollections.every(id => externalKnowledgeIds.has(id)), "channel_knowledge_must_be_explicitly_published");
  }
  return Object.freeze({ ...raw, primitives: Object.freeze(primitives) }) as unknown as ExtensionBundleManifest;
}
export function defineGadget(value: GadgetContract): GadgetContract { return parseExtensionPrimitive(value) as GadgetContract; }
export function defineCanvas(value: CanvasContract): CanvasContract { return parseExtensionPrimitive(value) as CanvasContract; }
export function defineChannelAdapter(value: ChannelContract): ChannelContract { return parseExtensionPrimitive(value) as ChannelContract; }
export function defineContainer(value: ContainerContract): ContainerContract { return parseExtensionPrimitive(value) as ContainerContract; }
export function defineLinter(value: LinterContract): LinterContract { return parseExtensionPrimitive(value) as LinterContract; }
export function defineWorkflow(value: WorkflowContract): WorkflowContract { return parseExtensionPrimitive(value) as WorkflowContract; }

export function migrateLegacyExtensionManifest(value: unknown): ExtensionBundleManifest {
  const legacy = validateExtensionManifest(value as LegacyExtensionManifest) as LegacyExtensionManifest;
  const actions: PermissionAction[] = legacy.permissions.includes("storage:write") ? ["read", "write"] : ["read"];
  const migrated: GadgetContract = { schemaVersion: "1.0", kind: "gadget", id: `ext_${legacy.id}`, version: legacy.version, scope: "PROJECT_BOUND", permissions: [{ scope: "PROJECT_BOUND", actions, resource: "legacy" }], capabilityRequirements: ["legacy.adapter"], lifecycle: {}, schemaSql: "CREATE TABLE legacy_extension_state (key TEXT PRIMARY KEY, value TEXT)" };
  return Object.freeze({ schemaVersion: "1.0", kind: "extension_bundle", id: `bundle_${legacy.id}`, version: legacy.version, primitives: Object.freeze([defineGadget(migrated)]) });
}
