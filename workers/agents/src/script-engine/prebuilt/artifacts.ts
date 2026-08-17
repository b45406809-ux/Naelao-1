/**
 * artifacts (Phase 5) — agent-authored deliverables (a rendered HTML page, a report, a document
 * meant to be SHOWN to the person, not scratch working storage). Distinct from r2-workspace's own
 * files: those are the agent's private working directory; an artifact is a finished thing the
 * shell's Artifacts tab lists and lets the person open/download.
 *
 * Routed through the artifact worker's own service binding (space-scoped R2, requireInternalHmac
 * gated — see workers/artifact's own header for the security history this replaced).
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";

function reqWorker(ctx: PrebuiltOpContext): Fetcher {
  if (!ctx.env.artifactWorker) {
    throw new Error("artifacts: ARTIFACT_WORKER binding not configured");
  }
  return ctx.env.artifactWorker;
}

async function internalHeaders(ctx: PrebuiltOpContext, extra?: Record<string, string>): Promise<Record<string, string>> {
  return {
    "x-naelao-tenant-id": ctx.env.tenantId,
    "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
    ...extra,
  };
}

export const artifacts: PrebuiltScript = {
  name: "artifacts",
  description: "Publish a finished deliverable (an HTML page, a report, a document) for the person to view or download, distinct from your own scratch workspace files.",
  domain: "workspace",
  requires_tier: 1,
  paramHints: {
    "artifacts.create": "{filename: string, content: string, content_type?: string} — content_type defaults to 'text/plain'; use 'text/html' for a page, 'text/markdown' for a report.",
    "artifacts.list": "{} — no arguments.",
    "artifacts.get": "{artifact_id: string} — the id returned by artifacts.create or artifacts.list.",
    "artifacts.delete": "{artifact_id: string}",
  },
  operations: {
    async "artifacts.create"(args, ctx) {
      const filename = String(args["filename"] ?? "").trim();
      const content = String(args["content"] ?? "");
      if (!filename) throw new Error("artifacts.create requires a non-empty 'filename'");
      if (!content) throw new Error("artifacts.create requires non-empty 'content'");
      const contentType = typeof args["content_type"] === "string" ? args["content_type"] : "text/plain";
      const resp = await reqWorker(ctx).fetch(
        new Request(`http://artifact-worker/spaces/${ctx.env.spaceId}/artifacts`, {
          method: "POST",
          headers: await internalHeaders(ctx, { "content-type": "application/json" }),
          body: JSON.stringify({ filename, content, content_type: contentType }),
        })
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`artifacts.create failed: ${resp.status}${body ? ` — ${body}` : ""}`);
      }
      return await resp.json();
    },

    async "artifacts.list"(_args, ctx) {
      const resp = await reqWorker(ctx).fetch(
        new Request(`http://artifact-worker/spaces/${ctx.env.spaceId}/artifacts`, {
          headers: await internalHeaders(ctx),
        })
      );
      if (!resp.ok) throw new Error(`artifacts.list failed: ${resp.status}`);
      return await resp.json();
    },

    async "artifacts.get"(args, ctx) {
      const artifactId = String(args["artifact_id"] ?? "");
      if (!artifactId) throw new Error("artifacts.get requires 'artifact_id'");
      const resp = await reqWorker(ctx).fetch(
        new Request(`http://artifact-worker/spaces/${ctx.env.spaceId}/artifacts/${encodeURIComponent(artifactId)}`, {
          headers: await internalHeaders(ctx),
        })
      );
      if (!resp.ok) throw new Error(`artifacts.get failed: ${resp.status}`);
      const contentType = resp.headers.get("content-type") ?? "application/octet-stream";
      const filename = resp.headers.get("x-artifact-filename") ?? "";
      // Text content types come back readable; anything else reports metadata only (a script's
      // own return value is JSON — raw binary bytes have nowhere useful to go in this contract).
      if (/^text\/|json|xml/.test(contentType)) {
        return { artifact_id: artifactId, filename, content_type: contentType, content: await resp.text() };
      }
      return { artifact_id: artifactId, filename, content_type: contentType, binary: true };
    },

    async "artifacts.delete"(args, ctx) {
      const artifactId = String(args["artifact_id"] ?? "");
      if (!artifactId) throw new Error("artifacts.delete requires 'artifact_id'");
      const resp = await reqWorker(ctx).fetch(
        new Request(`http://artifact-worker/spaces/${ctx.env.spaceId}/artifacts/${encodeURIComponent(artifactId)}`, {
          method: "DELETE",
          headers: await internalHeaders(ctx),
        })
      );
      if (!resp.ok) throw new Error(`artifacts.delete failed: ${resp.status}`);
      return { ok: true };
    },
  },
};
