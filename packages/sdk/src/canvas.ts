/** Authenticated browser-side bridge from an extension Canvas to its declared project Gadgets.
 * The host still resolves membership, current package release, publisher revocation, and the
 * Gadget actor on every request. `authorize` should supply a short-lived Naelao session token;
 * never place publisher or provider secrets in Canvas HTML. */
export interface CanvasGadgetClientOptions {
  apiBaseUrl: string;
  spaceId: string;
  projectId: string;
  /** The host-derived project Gadget app id (installation key + declared primitive id). */
  gadgetAppId: string;
  authorize: () => HeadersInit | Promise<HeadersInit>;
  fetch?: typeof fetch;
}

export interface CanvasGadgetClient {
  list<T = Record<string, unknown>>(
    table: string,
    filter?: Record<string, unknown>,
    limit?: number
  ): Promise<T[]>;
  get<T = Record<string, unknown>>(
    table: string,
    id: string | number
  ): Promise<T | null>;
  insert(table: string, record: Record<string, unknown>): Promise<unknown>;
  update(
    table: string,
    id: string | number,
    record: Record<string, unknown>
  ): Promise<unknown>;
  delete(table: string, id: string | number): Promise<unknown>;
  moveCursor(x: number, y: number, label?: string): Promise<void>;
  postCanvasEvent(
    kind: "comment" | "operation",
    payload: Record<string, unknown>
  ): Promise<{ id: number; created_at: number }>;
  pollCanvas(after?: number): Promise<CanvasCollaborationPage>;
  readActionAudit(after?: number): Promise<CanvasGadgetActionAuditPage>;
}

export interface CanvasCollaborationEvent {
  id: number;
  actor_id: string;
  kind: "comment" | "operation";
  payload: Record<string, unknown>;
  created_at: number;
}
export interface CanvasCollaborationPage {
  events: CanvasCollaborationEvent[];
  presence: Array<{
    actor_id: string;
    cursor: { x: number; y: number; label?: string };
    updated_at: number;
  }>;
  next_after: number;
}
export interface CanvasGadgetActionAuditPage {
  items: Array<{
    id: number;
    actor_id: string;
    operation: string;
    table_name: string;
    target_hash: string | null;
    created_at: number;
  }>;
  next_after: number;
}

interface JsonRpcResponse {
  result?: {
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  error?: { message?: string };
}

const MAX_CANVAS_REQUEST_BYTES = 64 * 1024;
const MAX_CANVAS_RESPONSE_BYTES = 1024 * 1024;

function jsonBody(value: unknown): string {
  const body = JSON.stringify(value);
  if (body === undefined) throw new TypeError("canvas_request_body_invalid");
  if (new TextEncoder().encode(body).byteLength > MAX_CANVAS_REQUEST_BYTES) {
    throw new RangeError("canvas_request_too_large");
  }
  return body;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_CANVAS_RESPONSE_BYTES) {
    throw new RangeError("canvas_response_too_large");
  }
  return JSON.parse(body) as T;
}

export function createCanvasGadgetClient(
  options: CanvasGadgetClientOptions
): CanvasGadgetClient {
  if (
    !options.apiBaseUrl ||
    !options.spaceId ||
    !options.projectId ||
    !/^[a-z][a-z0-9_-]{1,63}$/.test(options.gadgetAppId)
  ) {
    throw new Error("canvas_gadget_scope_invalid");
  }
  const fetcher = options.fetch ?? fetch;
  const url = `${options.apiBaseUrl.replace(/\/$/, "")}/v1/spaces/${encodeURIComponent(options.spaceId)}/projects/${encodeURIComponent(options.projectId)}/apps/${encodeURIComponent(options.gadgetAppId)}/mcp`;
  const collaborationUrl = url.replace(/\/mcp$/, "/collaboration");
  const actionAuditUrl = url.replace(/\/mcp$/, "/action-audit");
  const validateCursor = (after: number): void => {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RangeError("canvas_cursor_invalid");
    }
  };
  async function collaborationRequest<T>(
    method: "GET" | "POST",
    body?: unknown,
    after = 0
  ): Promise<T> {
    const headers = new Headers(await options.authorize());
    if (method === "POST") headers.set("content-type", "application/json");
    const response = await fetcher(
      method === "GET"
        ? `${collaborationUrl}?after=${after}`
        : collaborationUrl,
      {
        method,
        headers,
        ...(method === "POST" ? { body: jsonBody(body) } : {}),
      }
    );
    const payload = await readJson<{
      error?: string;
      error_code?: string;
      [key: string]: unknown;
    }>(response);
    if (!response.ok)
      throw new Error(
        payload.error_code ??
          payload.error ??
          `canvas_collaboration_request_failed_${response.status}`
      );
    return payload as T;
  }
  async function call<T>(
    operation: "list" | "get" | "insert" | "update" | "delete",
    args: Record<string, unknown>
  ): Promise<T> {
    const headers = new Headers(await options.authorize());
    headers.set("content-type", "application/json");
    const body = jsonBody({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: `app_${options.gadgetAppId.replace(/[^a-zA-Z0-9_]/g, "_")}_${operation}`,
        arguments: args,
      },
    });
    const response = await fetcher(url, {
      method: "POST",
      headers,
      body,
    });
    const payload = await readJson<JsonRpcResponse>(response);
    if (!response.ok || payload.error)
      throw new Error(
        payload.error?.message ??
          `canvas_gadget_request_failed_${response.status}`
      );
    return (payload.result?.structuredContent ??
      payload.result?.content?.find((item) => item.type === "text")?.text ??
      payload.result) as T;
  }
  return Object.freeze({
    list: <T>(
      table: string,
      filter: Record<string, unknown> = {},
      limit = 100
    ) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError("canvas_list_limit_invalid");
      }
      return call<T[]>("list", { table, filter, limit });
    },
    get: <T>(table: string, id: string | number) =>
      call<T | null>("get", { table, id }),
    insert: (table: string, record: Record<string, unknown>) =>
      call("insert", { table, record }),
    update: (
      table: string,
      id: string | number,
      record: Record<string, unknown>
    ) => call("update", { table, id, record }),
    delete: (table: string, id: string | number) =>
      call("delete", { table, id }),
    moveCursor: async (x: number, y: number, label?: string) => {
      await collaborationRequest("POST", {
        kind: "cursor",
        payload: { x, y, ...(label ? { label } : {}) },
      });
    },
    postCanvasEvent: async (
      kind: "comment" | "operation",
      payload: Record<string, unknown>
    ) =>
      collaborationRequest<{ id: number; created_at: number }>("POST", {
        kind,
        payload,
      }),
    pollCanvas: (after = 0) => {
      validateCursor(after);
      return collaborationRequest<CanvasCollaborationPage>(
        "GET",
        undefined,
        after
      );
    },
    readActionAudit: async (after = 0) => {
      validateCursor(after);
      const headers = new Headers(await options.authorize());
      const response = await fetcher(`${actionAuditUrl}?after=${after}`, {
        method: "GET",
        headers,
      });
      const payload = await readJson<
        CanvasGadgetActionAuditPage & {
          error_code?: string;
        }
      >(response);
      if (!response.ok)
        throw new Error(
          payload.error_code ?? `canvas_action_audit_failed_${response.status}`
        );
      return payload;
    },
  });
}
