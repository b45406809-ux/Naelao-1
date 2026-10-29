"use client";

import * as React from "react";
import { parseCanvasMessage } from "@naelao/agent-sdk";
import { callProjectExtensionCanvasGadgetRead, callSpaceSharedExtensionApi, callSpaceSharedExtensionOperation, type SessionCredentials, type SpaceExtensionHostCapability } from "@/lib/api";

export function MicroAppCanvas({ spaceId, appId, projectId = appId, projectScoped = false, extensionInstallationId, extensionCanvasId, readableGadgets = [], session, capabilities = [], onAction }: { spaceId: string; appId: string; projectId?: string; projectScoped?: boolean; extensionInstallationId?: string; extensionCanvasId?: string; readableGadgets?: Array<{ gadgetId: string; tables: string[] }>; session?: SessionCredentials; capabilities?: string[]; onAction(action: string, payload?: Record<string, unknown>, requestId?: string): void }) {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const src = projectScoped
    ? `/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appId)}/app`
    : `/spaces/${encodeURIComponent(spaceId)}/apps/${encodeURIComponent(appId)}/app`;
  React.useEffect(() => {
    const receive = (event: MessageEvent) => {
      // A sandbox without allow-same-origin intentionally has a null origin. Source identity is
      // therefore the security boundary; messages from any other window are ignored.
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const rpc = event.data as { type?: unknown; id?: unknown; method?: unknown; path?: unknown; query?: unknown; body?: unknown };
      const operation = event.data as { type?: unknown; id?: unknown; capability?: unknown; input?: unknown };
      const gadgetRead = event.data as { type?: unknown; id?: unknown; gadgetId?: unknown; operation?: unknown; table?: unknown; recordId?: unknown; limit?: unknown };
      if (gadgetRead?.type === "naelao.extension.gadget.read") {
        if (typeof gadgetRead.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(gadgetRead.id) || !session || !projectScoped
          || !extensionInstallationId || !extensionCanvasId || typeof gadgetRead.gadgetId !== "string" || typeof gadgetRead.table !== "string"
          || !readableGadgets.some(grant => grant.gadgetId === gadgetRead.gadgetId && grant.tables.includes(gadgetRead.table as string))) return;
        const readOperation = gadgetRead.operation;
        if (!(readOperation === "list" || readOperation === "get")
          || readOperation === "get" && (typeof gadgetRead.recordId !== "string" || gadgetRead.recordId.length > 256)
          || readOperation === "list" && gadgetRead.recordId !== undefined
          || gadgetRead.limit !== undefined && (!Number.isSafeInteger(gadgetRead.limit) || Number(gadgetRead.limit) < 1 || Number(gadgetRead.limit) > 25)) return;
        void callProjectExtensionCanvasGadgetRead(spaceId, projectId, extensionInstallationId, extensionCanvasId, gadgetRead.gadgetId, session, {
          operation: readOperation, table: gadgetRead.table,
          ...(typeof gadgetRead.recordId === "string" ? { id: gadgetRead.recordId } : {}),
          ...(typeof gadgetRead.limit === "number" ? { limit: gadgetRead.limit } : {}),
        }).then(result => frame.current?.contentWindow?.postMessage({ type: "naelao.extension.rpc.result", id: gadgetRead.id, ok: true, result }, "*"))
          .catch(error => frame.current?.contentWindow?.postMessage({ type: "naelao.extension.rpc.result", id: gadgetRead.id, ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "Gadget read failed" }, "*"));
        return;
      }
      if (operation?.type === "naelao.extension.operation") {
        if (typeof operation.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(operation.id) || !session || projectScoped
          || !["blueprint.export", "blueprint.status", "marketplace.graduate", "blackboard.read", "blackboard.policy", "blackboard.sharing"].includes(String(operation.capability))
          || !capabilities.includes(String(operation.capability))) return;
        let size = 0;
        try { size = new TextEncoder().encode(JSON.stringify(operation.input ?? {})).byteLength; } catch { return; }
        if (size > (operation.capability === "blueprint.export" ? 4_500_000 : 64_000)) return;
        if (operation.capability === "blackboard.policy") {
          const input = operation.input as { projectId?: unknown; wakeEnabled?: unknown } | null;
          if (!input || typeof input.projectId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.projectId) || typeof input.wakeEnabled !== "boolean") return;
          if (!window.confirm(`${input.wakeEnabled ? "Enable" : "Disable"} automatic blackboard wake-ups for project ${input.projectId}?`)) {
            frame.current?.contentWindow?.postMessage({ type: "naelao.extension.rpc.result", id: operation.id, ok: false, error: "Cancelled" }, "*");
            return;
          }
        }
        if (operation.capability === "blackboard.sharing") {
          const input = operation.input as { projectId?: unknown; peers?: unknown; dailyLimit?: unknown } | null;
          if (!input || typeof input.projectId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.projectId) || !Array.isArray(input.peers) || input.peers.length > 30 || input.peers.some(p => typeof p !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(p)) || !Number.isSafeInteger(input.dailyLimit) || Number(input.dailyLimit)<0 || Number(input.dailyLimit)>50) return;
          if (!window.confirm(`Allow project ${input.projectId} to coordinate automatically with ${input.peers.join(", ") || "no projects"}, up to ${input.dailyLimit} actions per day? Automatic sharing is limited to its published summary.`)) {
            frame.current?.contentWindow?.postMessage({ type:"naelao.extension.rpc.result",id:operation.id,ok:false,error:"Cancelled" },"*"); return;
          }
        }
        const capability = operation.capability as SpaceExtensionHostCapability;
        void callSpaceSharedExtensionOperation(spaceId, session, capability, operation.input ?? {})
          .then(result => frame.current?.contentWindow?.postMessage({ type: "naelao.extension.rpc.result", id: operation.id, ok: true, result }, "*"))
          .catch(error => frame.current?.contentWindow?.postMessage({ type: "naelao.extension.rpc.result", id: operation.id, ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "Extension operation failed" }, "*"));
        return;
      }
      if (rpc?.type === "naelao.extension.rpc") {
        if (typeof rpc.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(rpc.id) || !session || projectScoped
          || !["GET", "POST", "DELETE"].includes(String(rpc.method)) || !["/api/data", "/api/storage", "/mcp"].includes(String(rpc.path))
          || (rpc.path === "/mcp" && rpc.method !== "POST")
          || (rpc.query !== undefined && (!rpc.query || typeof rpc.query !== "object" || Array.isArray(rpc.query)))) return;
        const query = rpc.query as Record<string, unknown> | undefined;
        if (query && (Object.keys(query).length > 8 || Object.entries(query).some(([key, value]) => key.length > 64 || typeof value !== "string" || value.length > 256))) return;
        if (rpc.body !== undefined) {
          try { if (new TextEncoder().encode(JSON.stringify(rpc.body)).byteLength > 64_000) return; }
          catch { return; }
        }
        void callSpaceSharedExtensionApi(spaceId, appId, session, { method: rpc.method as "GET" | "POST" | "DELETE", path: rpc.path as "/api/data" | "/api/storage" | "/mcp", ...(query ? { query: query as Record<string, string> } : {}), ...(rpc.body !== undefined ? { body: rpc.body } : {}) })
          .then(result => frame.current?.contentWindow?.postMessage({ type: "naelao.extension.rpc.result", id: rpc.id, ok: true, result }, "*"))
          .catch(error => frame.current?.contentWindow?.postMessage({ type: "naelao.extension.rpc.result", id: rpc.id, ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "Extension API request failed" }, "*"));
        return;
      }
      try {
        const message = parseCanvasMessage(event.data, projectId);
        if (message.type === "canvas.action") onAction(message.action, message.payload, message.requestId);
        return;
      } catch { /* compatibility envelope below remains data-only and project-bound */ }
      const data = event.data as { type?: unknown; projectId?: unknown; action?: unknown; payload?: unknown };
      if (data?.type !== "mcp.ui_action" || data.projectId !== projectId || typeof data.action !== "string" || !/^[a-z][a-z0-9_.:-]{0,127}$/i.test(data.action) || !data.payload || typeof data.payload !== "object" || Array.isArray(data.payload)) return;
      const entries = Object.entries(data.payload as Record<string, unknown>);
      if (entries.length > 128 || entries.some(([key, item]) => key.length > 128 || (item !== null && !["string", "number", "boolean"].includes(typeof item)) || (typeof item === "string" && item.length > 16_384) || (typeof item === "number" && !Number.isFinite(item)))) return;
      onAction(data.action, data.payload as Record<string, unknown>);
    };
    window.addEventListener("message", receive);
    const relay = (event: Event) => {
      try {
        const message = parseCanvasMessage((event as CustomEvent).detail, projectId);
        if (message.type === "canvas.state") frame.current?.contentWindow?.postMessage(message, "*");
        return;
      } catch { /* Only bounded, project-scoped canvas.state crosses into the opaque iframe. */ }
      const result = (event as CustomEvent).detail as { type?: unknown; action?: unknown; request_id?: unknown; error?: unknown; run_id?: unknown };
      if (result && typeof result === "object" && typeof result.type === "string" && result.type.startsWith("mcp.ui_action.")
        && typeof result.request_id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(result.request_id)) {
        const status = result.type === "mcp.ui_action.queued" ? "queued" : result.type === "mcp.ui_action.completed" ? "completed"
          : result.type === "mcp.ui_action.accepted" ? "accepted" : "failed";
        frame.current?.contentWindow?.postMessage({ type: "naelao.extension.action.result", id: result.request_id,
          result: { status, ...(typeof result.error === "string" ? { error: result.error } : {}), ...(typeof result.run_id === "string" ? { run_id: result.run_id } : {}) } }, "*");
      }
    };
    window.addEventListener("naelao:mcp-ui-result", relay);
    return () => { window.removeEventListener("message", receive); window.removeEventListener("naelao:mcp-ui-result", relay); };
  }, [onAction, projectId, projectScoped, extensionInstallationId, extensionCanvasId, readableGadgets, session, spaceId, appId, capabilities]);
  return <iframe ref={frame} data-testid="micro-app-canvas" title="Micro-app" src={src} sandbox="allow-forms allow-modals allow-popups allow-scripts" className="micro-app-frame" />;
}
