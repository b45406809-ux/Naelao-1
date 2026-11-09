import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";

export type WorkspaceCompatEntry = {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
  contentType?: string;
  objectKey: string;
};

export type WorkspaceCompatHead = {
  branch: string;
  revision: number;
  updatedAt: string;
};

export type WorkspaceCompatRead =
  | { kind: "legacy" }
  | { kind: "canonical"; head: WorkspaceCompatHead; entries: WorkspaceCompatEntry[] }
  | { kind: "error"; response: Response };

function validEntry(entry: WorkspaceCompatEntry, scope: { tenantId: string; spaceId: string; projectId: string; jurisdiction: string }): boolean {
  const safePath = typeof entry.path === "string" && entry.path.length > 0 && entry.path.length <= 1024 &&
    !entry.path.startsWith("/") && !entry.path.includes("\\") && !entry.path.includes("\0") &&
    entry.path.split("/").every((part) => part && part !== "." && part !== ".." && part !== ".env" && !part.startsWith(".env."));
  const prefix = `workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/content/`;
  return safePath && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.size) && entry.size >= 0 &&
    typeof entry.executable === "boolean" &&
    (entry.contentType === undefined || (typeof entry.contentType === "string" && entry.contentType.length > 0 && entry.contentType.length <= 512 && !/[\r\n]/.test(entry.contentType))) &&
    entry.objectKey === `${prefix}${entry.sha256}`;
}

/**
 * Reads the authoritative project manifest for compatibility views. Legacy R2 reads are only
 * allowed while the flag is off or before a coordinator has initialized the project. Once a head
 * exists, all errors fail closed so stale per-file objects cannot be mistaken for committed data.
 */
export async function readWorkspaceCompat(input: {
  enabled: boolean;
  verificationOnly?: boolean;
  enforcePolicy?: boolean;
  agentsWorker: Fetcher | undefined;
  platformSecret: string;
  tenantId: string;
  spaceId: string;
  projectId: string;
  jurisdiction: "global" | "eu";
  path?: string;
}): Promise<WorkspaceCompatRead> {
  if (!input.enabled && !input.verificationOnly && !input.enforcePolicy) return { kind: "legacy" };
  if (!input.agentsWorker) return input.enabled || input.verificationOnly || input.enforcePolicy ? { kind: "error", response: Response.json({ error_code: "workspace_coordinator_unavailable" }, { status: 503 }) } : { kind: "legacy" };
  const response = await input.agentsWorker.fetch(new Request("http://agents-worker/internal/workspaces/compat-read", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": input.tenantId,
      "x-naelao-internal-token": await mintInternalToken(input.platformSecret, input.tenantId),
    },
    body: JSON.stringify({
      scope: { tenantId: input.tenantId, spaceId: input.spaceId, projectId: input.projectId, jurisdiction: input.jurisdiction },
      ...(input.path ? { path: input.path } : {}),
      branch: "main",
      ...(input.verificationOnly ? { verificationOnly: true } : {}),
    }),
  }));
  if (!response.ok) return { kind: "error", response };
  let body: { canonical?: boolean; head?: WorkspaceCompatHead; entries?: WorkspaceCompatEntry[] };
  try { body = await readBoundedResponseJson(response, 8 * 1024 * 1024) as typeof body; }
  catch { return { kind: "error", response: Response.json({ error_code: "workspace_read_invalid_response" }, { status: 503 }) }; }
  if (body.canonical === false) return { kind: "legacy" };
  if (body.canonical !== true || !body.head || !Array.isArray(body.entries) ||
      body.head.branch !== "main" || !Number.isSafeInteger(body.head.revision) ||
      typeof body.head.updatedAt !== "string" || !Number.isFinite(Date.parse(body.head.updatedAt)) ||
      !body.entries.every((entry) => entry && typeof entry === "object" && validEntry(entry, input)) ||
      new Set(body.entries.map((entry) => entry.path)).size !== body.entries.length) {
    return { kind: "error", response: Response.json({ error_code: "workspace_read_invalid_response" }, { status: 503 }) };
  }
  return { kind: "canonical", head: body.head, entries: body.entries };
}
