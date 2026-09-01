"use client";

// Enterprise Air-Gapped Local LLM Runner & On-Premises GPU Workstation Connection Panel.
// Allows companies to run models on local machines (Ollama / vLLM / private GPU cluster)
// and securely bridge them to their space over zero-port-forwarding WebSockets.

import * as React from "react";
import { Button, Badge, FormInput, useToast, Toast } from "@naelao/ui";
import {
  type SessionCredentials,
  apiFetch,
} from "@/lib/api";

export interface LocalDiscoveredModel {
  id: string;
  name: string;
  size?: string;
  context_window?: number;
  format?: string;
  family?: string;
  quantization_level?: string;
  modified_at?: string;
}

export interface LocalTunnelStatus {
  connected: boolean;
  models: LocalDiscoveredModel[];
  lastHeartbeatAt?: number;
}

export function LocalRunnersPanel({
  spaceId,
  creds,
  canEdit,
  airGappedOnly = false,
  onAirGappedChange,
}: {
  spaceId: string;
  creds: SessionCredentials;
  canEdit: boolean;
  airGappedOnly?: boolean;
  onAirGappedChange?: (airGapped: boolean) => void;
}) {
  const { toast, show } = useToast();
  const [tunnelStatus, setTunnelStatus] = React.useState<LocalTunnelStatus>({ connected: false, models: [] });
  const [loading, setLoading] = React.useState(true);
  const [connectToken, setConnectToken] = React.useState<string | null>(null);
  const [tokenLoading, setTokenLoading] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [airGapped, setAirGapped] = React.useState(airGappedOnly);

  const fetchStatus = React.useCallback(async () => {
    try {
      const res = await apiFetch<LocalTunnelStatus>(`/v1/spaces/${spaceId}/local-tunnel/status`, {
        method: "GET",
        session: creds,
      });
      if (res) {
        setTunnelStatus(res);
      }
    } catch {
      // Degrade gracefully if not yet connected
      setTunnelStatus({ connected: false, models: [] });
    } finally {
      setLoading(false);
    }
  }, [spaceId, creds]);

  React.useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => {
      void fetchStatus();
    }, 10_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  async function generateToken() {
    setTokenLoading(true);
    try {
      const data = await apiFetch<{ token: string; spaceId: string; userId: string; tunnelUrl: string }>(
        `/v1/spaces/${spaceId}/local-tunnel/connect-token`,
        { method: "POST", session: creds }
      );
      if (data?.token) {
        setConnectToken(data.token);
        show("One-time connection token generated (valid for 5 minutes).");
      }
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not generate connect token.");
    } finally {
      setTokenLoading(false);
    }
  }

  const runnerCommand = connectToken
    ? `npx @naelao/local-agent --ollama http://localhost:11434 --space ${spaceId} --user ${creds.userId ?? "admin"} --token ${connectToken}`
    : `npx @naelao/local-agent --ollama http://localhost:11434 --space ${spaceId} --user ${creds.userId ?? "admin"} --token <CONNECT_TOKEN>`;

  function copyCommand() {
    navigator.clipboard.writeText(runnerCommand);
    setCopied(true);
    show("Command copied to clipboard!");
    setTimeout(() => setCopied(false), 3000);
  }

  function toggleAirGapped() {
    const next = !airGapped;
    setAirGapped(next);
    if (onAirGappedChange) {
      onAirGappedChange(next);
    }
    show(next ? "🛡️ Air-Gapped Mode enabled: External Cloud AI egress blocked." : "Air-Gapped Mode disabled.");
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* Air-Gapped Mode Card */}
      <div
        className="settings-block"
        style={{
          padding: 14,
          border: airGapped ? "1px solid #16a34a" : "1px solid var(--border)",
          background: airGapped ? "rgba(34, 197, 94, 0.04)" : "var(--surface)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                🛡️ Enterprise Air-Gapped Mode (Zero Cloud Egress)
              </span>
              {airGapped ? (
                <Badge color="green">Air-Gapped Active</Badge>
              ) : (
                <Badge color="gray">Cloud AI Allowed</Badge>
              )}
            </div>
            <p style={{ fontSize: 12.5, color: "var(--text3)", lineHeight: 1.5, maxWidth: 620, margin: 0 }}>
              When enabled, <strong>all external AI cloud APIs</strong> (Anthropic, OpenAI, Google AI Studio, Cloudflare Workers AI)
              are strictly blocked at the runtime kernel level. All reasoning, tool calls, and model inference run exclusively on your on-premises local GPU runner.
            </p>
          </div>
          {canEdit && (
            <Button
              size="sm"
              variant={airGapped ? "primary" : "secondary"}
              onClick={toggleAirGapped}
            >
              {airGapped ? "Disable Air-Gapped Lock" : "Enable Air-Gapped Lock"}
            </Button>
          )}
        </div>
      </div>

      {/* Local Tunnel & Ollama Connection Status */}
      <div className="settings-block" style={{ padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
              🖥️ On-Premises Local GPU Runner (Ollama / vLLM)
            </span>
            {tunnelStatus.connected ? (
              <Badge color="green">● Connected</Badge>
            ) : (
              <Badge color="amber">○ Disconnected</Badge>
            )}
          </div>
          {canEdit && (
            <Button size="sm" variant="secondary" onClick={() => void generateToken()} disabled={tokenLoading}>
              {tokenLoading ? "Generating..." : "Generate Connect Token"}
            </Button>
          )}
        </div>

        {tunnelStatus.connected ? (
          <div>
            <p style={{ fontSize: 12.5, color: "var(--text2)", margin: "0 0 10px" }}>
              Active local tunnel connection established with your workstation.
            </p>
            {tunnelStatus.models && tunnelStatus.models.length > 0 ? (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                  Auto-Discovered Local Models ({tunnelStatus.models.length}):
                </div>
                <div style={{ display: "grid", gap: 6 }}>
                  {tunnelStatus.models.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "6px 10px",
                        background: "var(--surface2, rgba(0,0,0,0.02))",
                        borderRadius: 6,
                        fontSize: 12,
                        border: "1px solid var(--border)",
                      }}
                    >
                      <span style={{ fontWeight: 500, color: "var(--text)" }}>🦙 {m.name || m.id}</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {m.size && <span style={{ color: "var(--text3)", fontSize: 11 }}>{m.size}</span>}
                        {m.quantization_level && (
                          <span style={{ fontSize: 10, background: "var(--border)", padding: "1px 5px", borderRadius: 4 }}>
                            {m.quantization_level}
                          </span>
                        )}
                        <Badge color="green">Ready</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--text3)", fontStyle: "italic" }}>
                Connected, but no local models reported yet. Ensure Ollama is running (`ollama serve`).
              </div>
            )}
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 12.5, color: "var(--text3)", lineHeight: 1.5, margin: "0 0 10px" }}>
              Connect your local Mac / Linux / Windows GPU machine running Ollama or vLLM in 60 seconds.
              No public IP or port forwarding required — uses an outbound WebSocket bridge with single-use HMAC tokens.
            </p>

            <div
              style={{
                background: "var(--surface2, #0f172a)",
                color: "#e2e8f0",
                padding: "10px 12px",
                borderRadius: 8,
                fontFamily: "monospace",
                fontSize: 11.5,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                overflowX: "auto",
              }}
            >
              <code style={{ whiteSpace: "nowrap" }}>{runnerCommand}</code>
              <Button size="sm" variant="secondary" onClick={copyCommand} style={{ flexShrink: 0 }}>
                {copied ? "Copied ✓" : "Copy"}
              </Button>
            </div>
            {!connectToken && (
              <p style={{ fontSize: 11, color: "var(--text3)", marginTop: 6, margin: "6px 0 0" }}>
                💡 Click "Generate Connect Token" above to create an authorized connection token.
              </p>
            )}
          </div>
        )}
      </div>

      <Toast toast={toast} />
    </div>
  );
}
