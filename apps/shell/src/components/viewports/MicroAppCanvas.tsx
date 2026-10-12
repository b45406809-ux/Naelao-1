"use client";

import * as React from "react";
import { parseCanvasMessage } from "@naelao/agent-sdk";

export function MicroAppCanvas({ spaceId, appId, projectId = appId, onAction }: { spaceId: string; appId: string; projectId?: string; onAction(action: string, payload?: Record<string, unknown>): void }) {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const src = `/spaces/${encodeURIComponent(spaceId)}/apps/${encodeURIComponent(appId)}/app`;
  React.useEffect(() => {
    const receive = (event: MessageEvent) => {
      // A sandbox without allow-same-origin intentionally has a null origin. Source identity is
      // therefore the security boundary; messages from any other window are ignored.
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      try {
        const message = parseCanvasMessage(event.data, projectId);
        if (message.type === "canvas.action") onAction(message.action, message.payload);
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
      } catch { /* Only bounded, project-scoped canvas.state crosses into the opaque iframe. */ }
    };
    window.addEventListener("naelao:mcp-ui-result", relay);
    return () => { window.removeEventListener("message", receive); window.removeEventListener("naelao:mcp-ui-result", relay); };
  }, [onAction, projectId]);
  return <iframe ref={frame} data-testid="micro-app-canvas" title="Micro-app" src={src} sandbox="allow-forms allow-modals allow-popups allow-scripts" className="micro-app-frame" />;
}
