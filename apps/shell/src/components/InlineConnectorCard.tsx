"use client";

// Rendered under an assistant reply that tried to use a catalogued-but-not-yet-connected app
// (script-engine's tool-surface.ts sets needs_connector/connector_id/connector_name — see
// NaelaoAgentDO's writeAgentAnswerToSession call site). Lets the person connect it right there
// instead of having to go find the Connectors page themselves.

import * as React from "react";
import { getConnectorStatus, type ConnectorInfo } from "@/lib/api";
import type { SessionCredentials } from "@/lib/api";
import { startConnectorConnect, submitManualConnectorKey } from "@/lib/connectorActions";

export function InlineConnectorCard({
  spaceId,
  connectorId,
  connectorName,
  session,
}: {
  spaceId: string;
  connectorId: string;
  connectorName: string;
  session: SessionCredentials;
}) {
  const [connector, setConnector] = React.useState<ConnectorInfo | null>(null);
  const [connected, setConnected] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [manualKeyOpen, setManualKeyOpen] = React.useState(false);
  const [manualKeyValue, setManualKeyValue] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    getConnectorStatus(spaceId, session)
      .then((list) => {
        if (cancelled) return;
        const found = list.find((c) => c.id === connectorId) ?? null;
        setConnector(found);
        setConnected(!!found?.connected);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [spaceId, connectorId, session]);

  async function handleConnect() {
    if (!connector) return;
    setBusy(true);
    try {
      const { needsManualKey } = await startConnectorConnect(spaceId, session, connector, window.location.href);
      if (needsManualKey) {
        setManualKeyOpen(true);
        setBusy(false);
      }
    } catch {
      setBusy(false);
    }
  }

  async function handleManualSubmit() {
    if (!manualKeyValue.trim()) return;
    setBusy(true);
    try {
      await submitManualConnectorKey(spaceId, session, connectorId, manualKeyValue.trim());
      setConnected(true);
      setManualKeyOpen(false);
      setManualKeyValue("");
    } catch {
      /* stays actionable */
    } finally {
      setBusy(false);
    }
  }

  if (connected) return null; // already connected between load and now — nothing to show

  return (
    <div
      style={{
        marginTop: 6, maxWidth: 400, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
        background: "var(--surface2)", padding: 12, display: "flex", alignItems: "center", gap: 10,
      }}
    >
      <span aria-hidden style={{ fontSize: 16 }}>🔌</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>Connect {connectorName}</div>
        <div style={{ fontSize: 11.5, color: "var(--text3)" }}>Needed to do what was just asked.</div>
      </div>
      {!manualKeyOpen ? (
        <button type="button" className="btn btn-primary btn-sm" onClick={handleConnect} disabled={busy || !connector}>
          {busy ? "…" : "Connect"}
        </button>
      ) : (
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="form-input"
            type="password"
            placeholder="API key"
            value={manualKeyValue}
            onChange={(e) => setManualKeyValue(e.target.value)}
            style={{ width: 140, fontSize: 12 }}
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={handleManualSubmit} disabled={busy || !manualKeyValue.trim()}>
            {busy ? "…" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
