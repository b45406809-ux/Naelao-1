"use client";

import * as React from "react";

export function MicroAppCanvas({ spaceId, appId, onAction }: { spaceId: string; appId: string; onAction(action: string, payload?: Record<string, unknown>): void }) {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const src = `/spaces/${encodeURIComponent(spaceId)}/apps/${encodeURIComponent(appId)}/app`;
  React.useEffect(() => {
    const receive = (event: MessageEvent) => {
      // A sandbox without allow-same-origin intentionally has a null origin. Source identity is
      // therefore the security boundary; messages from any other window are ignored.
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const data = event.data as { type?: unknown; action?: unknown; payload?: unknown };
      if (data?.type !== "mcp.ui_action" || typeof data.action !== "string") return;
      onAction(data.action, data.payload && typeof data.payload === "object" ? data.payload as Record<string, unknown> : {});
    };
    window.addEventListener("message", receive);
    const relay = (event: Event) => frame.current?.contentWindow?.postMessage((event as CustomEvent).detail, "*");
    window.addEventListener("naelao:mcp-ui-result", relay);
    return () => { window.removeEventListener("message", receive); window.removeEventListener("naelao:mcp-ui-result", relay); };
  }, [onAction]);
  return <iframe ref={frame} data-testid="micro-app-canvas" title="Micro-app" src={src} sandbox="allow-forms allow-modals allow-popups allow-scripts" className="micro-app-frame" />;
}
