import type { GadgetScope } from "./types.js";

/** Versioned, declarative business actions supported by the host microapp runtime. */
export type BusinessActionRole = "owner" | "admin";

export interface BusinessActionScalarSchema {
  type: "string" | "integer" | "boolean";
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface BusinessActionObjectSchema {
  type: "object";
  properties: Record<string, BusinessActionScalarSchema | BusinessActionArraySchema>;
  required: string[];
  additionalProperties: false;
}

export interface BusinessActionArraySchema {
  type: "array";
  items: BusinessActionObjectSchema;
  minItems?: number;
  maxItems: number;
}

export interface ExtensionBusinessAction {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  operation: "inventory.receiveStock.v1" | "inventory.adjustStock.v1" | "inventory.listLowStock.v1";
  installationScope: GadgetScope;
  dataScope: GadgetScope;
  table: string;
  idColumn: string;
  quantityColumn: string;
  versionColumn: string;
  permission: string;
  roles: readonly BusinessActionRole[];
  effects: "transactional_write" | "read_only";
  idempotency: "required" | "none";
  approval: "none";
  inputSchema: BusinessActionObjectSchema;
  outputSchema: BusinessActionObjectSchema;
}

export interface ReceiveStockInput {
  productId: string;
  quantity: number;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}

export interface ReceiveStockOutput { productId: string; quantity: number; version: number; replayed: boolean }
/** Set the counted on-hand quantity to an exact value; this never allows negative stock. */
export interface AdjustStockInput {
  productId: string;
  newQuantity: number;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}
export interface AdjustStockOutput { productId: string; previousQuantity: number; quantity: number; version: number; replayed: boolean }
export interface ListLowStockInput { maximumQuantity: number; limit: number; afterProductId: string }
export interface ListLowStockProduct { productId: string; quantity: number; version: number }
export interface ListLowStockOutput { products: ListLowStockProduct[]; hasMore: boolean; nextCursor: string }
export interface BusinessActionClient {
  list(): Promise<{ version: 1; actions: Array<{ id: string; name: string; description: string; permission: string; roles: BusinessActionRole[];
    effects: "transactional_write" | "read_only"; idempotency: "required" | "none"; approval: "none"; inputSchema: BusinessActionObjectSchema; outputSchema: BusinessActionObjectSchema }> }>;
  invoke<T = unknown>(actionId: string, input: Record<string, unknown>): Promise<T>;
}

interface CanvasBridgeWindow {
  parent: CanvasBridgeWindow;
  addEventListener(type: "message", listener: (event: { source: unknown; data: unknown }) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

let businessActionRequestSequence = 0;

function businessActionRequestId(): string {
  const cryptoApi = (globalThis as unknown as { crypto?: {
    randomUUID?: () => string;
    getRandomValues?: (bytes: Uint8Array) => Uint8Array;
  } }).crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Correlation only: the host authenticates by the opaque frame's Window source and server session.
  businessActionRequestSequence += 1;
  return `request-${Date.now().toString(36)}-${businessActionRequestSequence.toString(36)}`;
}

function getCanvasWindow(): CanvasBridgeWindow | undefined {
  return (globalThis as unknown as { window?: CanvasBridgeWindow }).window;
}

function createCanvasBridgeBusinessActionClient(canvas: CanvasBridgeWindow, appId: string): BusinessActionClient {
  const request = <T>(operation: "list" | "invoke", actionId?: string, input?: Record<string, unknown>): Promise<T> => new Promise((resolve, reject) => {
    const id = businessActionRequestId();
    const timeout = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error("business_action_request_timeout"), { errorCode: "business_action_request_timeout" })); }, 30_000);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
    canvas.parent.postMessage({ type: "naelao.extension.business-action", id, operation, appId, ...(actionId ? { actionId } : {}), ...(input ? { input } : {}) }, "*");
  });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  canvas.addEventListener("message", event => {
    if (event.source !== canvas.parent || !event.data || typeof event.data !== "object") return;
    const message = event.data as { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    if (message.type !== "naelao.extension.business-action.result" || typeof message.id !== "string" || typeof message.ok !== "boolean") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(Object.assign(new Error(typeof message.error === "string" ? message.error : "business_action_request_failed"),
      { errorCode: typeof message.error === "string" ? message.error : "business_action_request_failed" }));
  });
  return {
    list: () => request("list"),
    invoke: (actionId, input) => {
      if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(actionId)) throw new Error("business_action_id_invalid");
      return request("invoke", actionId, input);
    },
  };
}

/** Same origin host API used by a microapp UI; the browser session supplies identity and the
 * host route rechecks membership, installation, release, role and current permissions. Opaque
 * Canvas iframes use the source-checked parent bridge so cookies and authority stay in the host. */
export function createBusinessActionClient(endpoint: string, fetcher: typeof fetch = fetch): BusinessActionClient {
  const base = endpoint.replace(/\/$/, "");
  if (!base || base.length > 2048) throw new Error("business_action_endpoint_invalid");
  const canvas = getCanvasWindow();
  if (canvas && canvas.parent !== canvas) {
    const match = base.match(/\/apps\/([a-z][a-z0-9_-]{1,63})$/);
    if (!match) throw new Error("business_action_endpoint_invalid");
    return createCanvasBridgeBusinessActionClient(canvas, match[1]!);
  }
  const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const options = Object.assign({ cache: "no-store", headers: { accept: "application/json" } }, init ?? {},
      { credentials: "same-origin", headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
    const response = await fetcher(url, options as Parameters<typeof fetcher>[1]);
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error_code?: unknown };
      throw Object.assign(new Error(typeof error.error_code === "string" ? error.error_code : "business_action_request_failed"),
        { status: response.status, errorCode: error.error_code });
    }
    return response.json() as Promise<T>;
  };
  return {
    list: () => request(`${base}/business-actions`),
    invoke: (actionId, input) => {
      if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(actionId)) throw new Error("business_action_id_invalid");
      return request(`${base}/business-actions/${encodeURIComponent(actionId)}`, { method: "POST", body: JSON.stringify(input) });
    },
  };
}

export const RECEIVE_STOCK_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    productId: { type: "string", description: "Inventory row identifier", minLength: 1, maxLength: 128 },
    quantity: { type: "integer", description: "Positive number of units received", minimum: 1, maximum: 1_000_000 },
    expectedVersion: { type: "integer", description: "Current inventory row version", minimum: 1, maximum: 2_147_483_646 },
    reason: { type: "string", description: "Short receiving reference or reason", minLength: 3, maxLength: 256 },
    idempotencyKey: { type: "string", description: "Stable key reused for retries of this exact action", minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
  },
  required: ["productId", "quantity", "expectedVersion", "reason", "idempotencyKey"],
  additionalProperties: false,
} as BusinessActionObjectSchema);

export const RECEIVE_STOCK_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    productId: { type: "string", description: "Inventory row identifier", minLength: 1, maxLength: 128 },
    quantity: { type: "integer", description: "New on-hand quantity", minimum: 0, maximum: 2_147_483_647 },
    version: { type: "integer", description: "New inventory row version", minimum: 2, maximum: 2_147_483_647 },
    replayed: { type: "boolean", description: "Whether this result was returned from an idempotency receipt" },
  },
  required: ["productId", "quantity", "version", "replayed"],
  additionalProperties: false,
} as BusinessActionObjectSchema);

export const ADJUST_STOCK_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    productId: { type: "string", description: "Inventory row identifier", minLength: 1, maxLength: 128 },
    newQuantity: { type: "integer", description: "Exact nonnegative on-hand quantity from the count", minimum: 0, maximum: 2_147_483_647 },
    expectedVersion: { type: "integer", description: "Current inventory row version", minimum: 1, maximum: 2_147_483_646 },
    reason: { type: "string", description: "Short count or correction reference", minLength: 3, maxLength: 256 },
    idempotencyKey: { type: "string", description: "Stable key reused for retries of this exact action", minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
  },
  required: ["productId", "newQuantity", "expectedVersion", "reason", "idempotencyKey"],
  additionalProperties: false,
} as BusinessActionObjectSchema);

export const ADJUST_STOCK_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    productId: { type: "string", description: "Inventory row identifier", minLength: 1, maxLength: 128 },
    previousQuantity: { type: "integer", description: "On-hand quantity before the count adjustment", minimum: 0, maximum: 2_147_483_647 },
    quantity: { type: "integer", description: "New on-hand quantity", minimum: 0, maximum: 2_147_483_647 },
    version: { type: "integer", description: "New inventory row version", minimum: 2, maximum: 2_147_483_647 },
    replayed: { type: "boolean", description: "Whether this result was returned from an idempotency receipt" },
  },
  required: ["productId", "previousQuantity", "quantity", "version", "replayed"],
  additionalProperties: false,
} as BusinessActionObjectSchema);

export const LIST_LOW_STOCK_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    maximumQuantity: { type: "integer", description: "Include products at or below this on-hand count", minimum: 0, maximum: 2_147_483_647 },
    limit: { type: "integer", description: "Maximum rows in this page", minimum: 1, maximum: 100 },
    afterProductId: { type: "string", description: "Exclusive product ID cursor from the preceding page", minLength: 0, maxLength: 128 },
  },
  required: ["maximumQuantity", "limit"],
  additionalProperties: false,
} as BusinessActionObjectSchema);

export const LIST_LOW_STOCK_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    products: { type: "array", items: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Inventory row identifier", minLength: 1, maxLength: 128 },
        quantity: { type: "integer", description: "Current on-hand quantity", minimum: 0, maximum: 2_147_483_647 },
        version: { type: "integer", description: "Current inventory row version", minimum: 1, maximum: 2_147_483_647 },
      },
      required: ["productId", "quantity", "version"],
      additionalProperties: false,
    }, minItems: 0, maxItems: 100 },
    hasMore: { type: "boolean", description: "Whether another bounded page is available" },
    nextCursor: { type: "string", description: "Exclusive cursor for the next page, or empty when complete", minLength: 0, maxLength: 128 },
  },
  required: ["products", "hasMore", "nextCursor"],
  additionalProperties: false,
} as BusinessActionObjectSchema);

const ACTION_ID = /^[a-z][a-zA-Z0-9]{0,63}$/;
const PERMISSION = /^[a-z][a-z0-9_.:-]{1,127}$/;
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Strict SDK parser. The host implements only the explicitly named inventory v1 operations above. */
export function validateExtensionBusinessAction(value: unknown): ExtensionBusinessAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_business_action");
  const raw = value as Record<string, unknown>;
  const contract = raw.operation === "inventory.receiveStock.v1" ? {
    schemas: [RECEIVE_STOCK_INPUT_SCHEMA, RECEIVE_STOCK_OUTPUT_SCHEMA], effects: "transactional_write", idempotency: "required",
  } : raw.operation === "inventory.adjustStock.v1" ? {
    schemas: [ADJUST_STOCK_INPUT_SCHEMA, ADJUST_STOCK_OUTPUT_SCHEMA], effects: "transactional_write", idempotency: "required",
  } : raw.operation === "inventory.listLowStock.v1" ? {
    schemas: [LIST_LOW_STOCK_INPUT_SCHEMA, LIST_LOW_STOCK_OUTPUT_SCHEMA], effects: "read_only", idempotency: "none",
  } : null;
  const allowed = new Set(["schemaVersion", "id", "name", "description", "operation", "installationScope", "dataScope", "table", "idColumn", "quantityColumn", "versionColumn", "permission", "roles", "effects", "idempotency", "approval", "inputSchema", "outputSchema"]);
  const scopes = new Set<GadgetScope>(["USER_PRIVATE", "SPACE_WIDE", "PROJECT_BOUND", "PROJECT_SHARED", "PROJECT_USER", "SPACE_SHARED", "SPACE_USER"]);
  if (Object.keys(raw).some(key => !allowed.has(key)) || raw.schemaVersion !== 1 || typeof raw.id !== "string" || !ACTION_ID.test(raw.id)
    || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 128
    || typeof raw.description !== "string" || !raw.description.trim() || raw.description.length > 512
    || !contract
    || !scopes.has(raw.installationScope as GadgetScope) || !scopes.has(raw.dataScope as GadgetScope) || raw.installationScope !== raw.dataScope
    || raw.table !== "inventory" || raw.idColumn !== "id" || raw.quantityColumn !== "quantity" || raw.versionColumn !== "version"
    || new Set([raw.idColumn, raw.quantityColumn, raw.versionColumn]).size !== 3
    || typeof raw.permission !== "string" || !PERMISSION.test(raw.permission)
    || !Array.isArray(raw.roles) || !raw.roles.length || raw.roles.length > 2 || new Set(raw.roles).size !== raw.roles.length
    || raw.roles.some(role => role !== "owner" && role !== "admin")
    || raw.effects !== contract.effects || raw.idempotency !== contract.idempotency || raw.approval !== "none"
    || canonicalJson(raw.inputSchema) !== canonicalJson(contract.schemas[0])
    || canonicalJson(raw.outputSchema) !== canonicalJson(contract.schemas[1])) {
    throw new Error("invalid_business_action");
  }
  return Object.freeze({ ...raw, roles: Object.freeze([...(raw.roles as BusinessActionRole[])]), inputSchema: contract.schemas[0],
    outputSchema: contract.schemas[1] }) as unknown as ExtensionBusinessAction;
}

export function validateReceiveStockInput(value: unknown): ReceiveStockInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("business_action_input_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "expectedVersion,idempotencyKey,productId,quantity,reason"
    || typeof input.productId !== "string" || input.productId.length < 1 || input.productId.length > 128
    || !Number.isSafeInteger(input.quantity) || Number(input.quantity) < 1 || Number(input.quantity) > 1_000_000
    || !Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1 || Number(input.expectedVersion) > 2_147_483_646
    || typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.length > 256
    || typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey)) {
    throw new Error("business_action_input_invalid");
  }
  return { productId: input.productId, quantity: Number(input.quantity), expectedVersion: Number(input.expectedVersion),
    reason: input.reason.trim(), idempotencyKey: input.idempotencyKey };
}

export function validateReceiveStockOutput(value: unknown): ReceiveStockOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("business_action_output_invalid");
  const output = value as Record<string, unknown>;
  if (Object.keys(output).sort().join(",") !== "productId,quantity,replayed,version"
    || typeof output.productId !== "string" || output.productId.length < 1 || output.productId.length > 128
    || !Number.isSafeInteger(output.quantity) || Number(output.quantity) < 0 || Number(output.quantity) > 2_147_483_647
    || !Number.isSafeInteger(output.version) || Number(output.version) < 2 || Number(output.version) > 2_147_483_647
    || typeof output.replayed !== "boolean") throw new Error("business_action_output_invalid");
  return output as unknown as ReceiveStockOutput;
}

export function validateAdjustStockInput(value: unknown): AdjustStockInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("business_action_input_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "expectedVersion,idempotencyKey,newQuantity,productId,reason"
    || typeof input.productId !== "string" || input.productId.length < 1 || input.productId.length > 128
    || !Number.isSafeInteger(input.newQuantity) || Number(input.newQuantity) < 0 || Number(input.newQuantity) > 2_147_483_647
    || !Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1 || Number(input.expectedVersion) > 2_147_483_646
    || typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.length > 256
    || typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey)) {
    throw new Error("business_action_input_invalid");
  }
  return { productId: input.productId, newQuantity: Number(input.newQuantity), expectedVersion: Number(input.expectedVersion),
    reason: input.reason.trim(), idempotencyKey: input.idempotencyKey };
}

export function validateAdjustStockOutput(value: unknown): AdjustStockOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("business_action_output_invalid");
  const output = value as Record<string, unknown>;
  if (Object.keys(output).sort().join(",") !== "previousQuantity,productId,quantity,replayed,version"
    || typeof output.productId !== "string" || output.productId.length < 1 || output.productId.length > 128
    || !Number.isSafeInteger(output.previousQuantity) || Number(output.previousQuantity) < 0 || Number(output.previousQuantity) > 2_147_483_647
    || !Number.isSafeInteger(output.quantity) || Number(output.quantity) < 0 || Number(output.quantity) > 2_147_483_647
    || !Number.isSafeInteger(output.version) || Number(output.version) < 2 || Number(output.version) > 2_147_483_647
    || typeof output.replayed !== "boolean") throw new Error("business_action_output_invalid");
  return output as unknown as AdjustStockOutput;
}

export function validateListLowStockInput(value: unknown): ListLowStockInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("business_action_input_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["maximumQuantity", "limit", "afterProductId"].includes(key))
    || !Number.isSafeInteger(input.maximumQuantity) || Number(input.maximumQuantity) < 0 || Number(input.maximumQuantity) > 2_147_483_647
    || !Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100
    || input.afterProductId !== undefined && (typeof input.afterProductId !== "string" || input.afterProductId.length > 128)) {
    throw new Error("business_action_input_invalid");
  }
  return { maximumQuantity: Number(input.maximumQuantity), limit: Number(input.limit), afterProductId: String(input.afterProductId ?? "") };
}

export function validateListLowStockOutput(value: unknown): ListLowStockOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("business_action_output_invalid");
  const output = value as Record<string, unknown>;
  if (Object.keys(output).sort().join(",") !== "hasMore,nextCursor,products"
    || !Array.isArray(output.products) || output.products.length > 100 || typeof output.hasMore !== "boolean"
    || typeof output.nextCursor !== "string" || output.nextCursor.length > 128) throw new Error("business_action_output_invalid");
  const products = output.products.map((candidate): ListLowStockProduct => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("business_action_output_invalid");
    const row = candidate as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "productId,quantity,version"
      || typeof row.productId !== "string" || row.productId.length < 1 || row.productId.length > 128
      || !Number.isSafeInteger(row.quantity) || Number(row.quantity) < 0 || Number(row.quantity) > 2_147_483_647
      || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || Number(row.version) > 2_147_483_647) {
      throw new Error("business_action_output_invalid");
    }
    return { productId: row.productId, quantity: Number(row.quantity), version: Number(row.version) };
  });
  if (new Set(products.map(row => row.productId)).size !== products.length
    || products.some((row, index) => index > 0 && row.productId <= products[index - 1]!.productId)
    || output.hasMore && (products.length === 0 || output.nextCursor !== products.at(-1)?.productId)
    || !output.hasMore && output.nextCursor !== "") throw new Error("business_action_output_invalid");
  return { products, hasMore: output.hasMore, nextCursor: output.nextCursor } as ListLowStockOutput;
}

export function validateBusinessActionInput(action: ExtensionBusinessAction, value: unknown): ReceiveStockInput | AdjustStockInput | ListLowStockInput {
  return action.operation === "inventory.receiveStock.v1" ? validateReceiveStockInput(value)
    : action.operation === "inventory.adjustStock.v1" ? validateAdjustStockInput(value) : validateListLowStockInput(value);
}

export function validateBusinessActionOutput(action: ExtensionBusinessAction, value: unknown): ReceiveStockOutput | AdjustStockOutput | ListLowStockOutput {
  return action.operation === "inventory.receiveStock.v1" ? validateReceiveStockOutput(value)
    : action.operation === "inventory.adjustStock.v1" ? validateAdjustStockOutput(value) : validateListLowStockOutput(value);
}
