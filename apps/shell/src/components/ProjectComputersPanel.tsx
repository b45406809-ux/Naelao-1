"use client";
import { type SessionCredentials, apiFetch } from "@/lib/api";
import * as React from "react";

type Computer = {
  id: string;
  scope: { spaceId?: string; projectId?: string; branch?: string };
  state: string;
  templateId: string;
  templateVersion: string;
  providerPreference: string;
  ownership: string;
  filesystemMode: string;
  connectionId: string | null;
  activeOperationId?: string | null;
  activeOperationType?: string | null;
  activeOperationStatus?: string | null;
  agentportLinkStatus?: string | null;
  agentportCapabilities?: string[];
};
type ProviderConnection = {
  id: string;
  provider: string;
  ownership: string;
  status: string;
  region: string | null;
  credentialCheckStatus?: string;
  credentialCheckErrorCode?: string | null;
  controlPlaneVerifiedAt?: string | null;
};
type Agent37Usage = {
  from: string;
  to: string;
  totalMicros: number;
  byIntegration: Array<{ kind: string; costMicros: number; awakeMinutes?: number }>;
};
type Agent37UsageResponse = { usage: Agent37Usage; scope: "agent37_workspace_account"; provenance: "provider_api_observed"; notice: string };
const panelStyle: React.CSSProperties = { marginTop: 24, padding: 16 };

/** Project computer inventory. A configured row is only durable configuration; provider
 * allocation remains disabled until a connection has passed the runtime acceptance gate. */
export function ProjectComputersPanel({
  spaceId,
  projectId,
  session,
}: { spaceId: string; projectId: string; session: SessionCredentials }) {
  const stableSession = React.useMemo(
    () => ({
      sessionToken: session.sessionToken,
      endUserId: session.endUserId,
    }),
    [session.sessionToken, session.endUserId]
  );
  const [computers, setComputers] = React.useState<Computer[]>([]);
  const [connections, setConnections] = React.useState<ProviderConnection[]>([]);
  const [providerUsage, setProviderUsage] = React.useState<Record<string, Agent37UsageResponse>>({});
  const [apiKey, setApiKey] = React.useState("");
  const [instanceKey, setInstanceKey] = React.useState("");
  const [region, setRegion] = React.useState("");
  const [computerConnectionId, setComputerConnectionId] = React.useState("");
  const [agent37Capabilities, setAgent37Capabilities] = React.useState<Record<string, string[]>>({});
  const connectionIdempotencyKey = React.useRef(`agent37-connect-${crypto.randomUUID()}`);
  const [providerMessage, setProviderMessage] = React.useState(
    "Checking provider availability…"
  );
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const [inventory, provider, connectionInventory] = await Promise.all([
        apiFetch<{ computers: Computer[] }>("/v1/computers", {
          session: stableSession,
          cache: "no-store",
        }),
        apiFetch<{
          providers: Array<{ id: string; status: string; reason: string }>;
        }>("/v1/providers", { session: stableSession, cache: "no-store" }),
        apiFetch<{ connections: ProviderConnection[] }>("/v1/connections", {
          session: stableSession,
          cache: "no-store",
        }),
      ]);
      setComputers(
        inventory.computers.filter(
          (item) =>
            item.scope.spaceId === spaceId && item.scope.projectId === projectId
        )
      );
      setProviderMessage(
        provider.providers
          .map((item) => `${item.id}: ${item.status}`)
          .join(" · ") || "No provider is available."
      );
      setConnections(connectionInventory.connections);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Computer inventory unavailable"
      );
    } finally {
      setLoading(false);
    }
  }, [projectId, stableSession, spaceId]);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createConfiguration() {
    setBusy(true);
    setMessage("");
    try {
      await apiFetch("/v1/computers", {
        method: "POST",
        session: stableSession,
        headers: {
          "idempotency-key": `computer-create-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          scope: { spaceId, projectId, branch: "main" },
          templateId: "node",
          templateVersion: "1",
          provider: computerConnectionId ? "agent37" : "auto",
          ...(computerConnectionId ? { connectionId: computerConnectionId } : {}),
          resources: { cpu: 2, memoryMiB: 4096, diskGiB: 4 },
          filesystemId: `fs_${crypto.randomUUID()}`,
        }),
      });
      setMessage(
        "Computer configuration saved. No provider runtime has been allocated."
      );
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not save computer configuration"
      );
    } finally {
      setBusy(false);
    }
  }
  async function shareWithAgentPort(computer: Computer) {
    const capabilities = agent37Capabilities[computer.id] ?? computer.agentportCapabilities ?? [];
    if (!capabilities.length) {
      setMessage("Select at least one Agent37 action before sharing.");
      return;
    }
    const spend = capabilities.includes("agent37.computer.start")
      ? " Starting may spend funds from your connected Agent37 account."
      : "";
    if (!window.confirm(`Share these Agent37 actions with this project's Naelao AgentPort assistant: ${capabilities.join(", ")}?${spend} Provider keys stay in Sandboxes. Runtime rollout remains disabled until live verification.`)) return;
    setBusy(true);
    setMessage("");
    try {
      await apiFetch(`/v1/computers/${encodeURIComponent(computer.id)}/agentport-share`, {
        method: "POST",
        session: stableSession,
        headers: { "idempotency-key": `agent37-share-${crypto.randomUUID()}` },
        body: JSON.stringify({ capabilities }),
      });
      setMessage("Selected Agent37 actions are linked to the project assistant.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not share Agent37 actions");
    } finally {
      setBusy(false);
    }
  }
  async function revokeAgentPortShare(computer: Computer) {
    if (!window.confirm("Revoke this computer's AgentPort account and all related grants?")) return;
    setBusy(true);
    setMessage("");
    try {
      await apiFetch(`/v1/computers/${encodeURIComponent(computer.id)}/agentport-revoke`, {
        method: "POST",
        session: stableSession,
        headers: { "idempotency-key": `agent37-unshare-${crypto.randomUUID()}` },
      });
      setMessage("AgentPort access was revoked. The customer-owned Agent37 connection remains connected.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not revoke AgentPort access");
    } finally {
      setBusy(false);
    }
  }
  async function reconcileTransition(computer: Computer) {
    const operationId = computer.activeOperationId;
    if (!operationId || !["start", "sleep"].includes(computer.activeOperationType ?? "")) return;
    if (!window.confirm(`Check the current Agent37 state for this uncertain ${computer.activeOperationType} operation? This makes a read-only provider request and will not repeat the action.`)) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await apiFetch<{ operation?: { status?: string; observedState?: string } }>(
        `/v1/computers/${encodeURIComponent(computer.id)}/operations/${encodeURIComponent(operationId)}/reconcile`,
        { method: "POST", session: stableSession, body: JSON.stringify({ confirm: true }) },
      );
      setMessage(result.operation?.status === "complete"
        ? `Agent37 state was confirmed as ${result.operation.observedState ?? "the expected state"}.`
        : `Agent37 reports ${result.operation?.observedState ?? "an unresolved state"}; the operation remains under recovery.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not inspect the Agent37 operation");
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    setMessage("");
    try {
      await apiFetch(`/v1/computers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        session: stableSession,
      });
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not remove computer"
      );
    } finally {
      setBusy(false);
    }
  }
  async function connectAgent37(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiKey.trim() || !instanceKey.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      await apiFetch("/v1/connections", {
        method: "POST",
        session: stableSession,
        headers: { "idempotency-key": connectionIdempotencyKey.current },
        body: JSON.stringify({
          provider: "agent37",
          credentials: { apiKey: apiKey.trim(), instanceKey: instanceKey.trim() },
          ...(region.trim() ? { region: region.trim() } : {}),
        }),
      });
      setApiKey("");
      setInstanceKey("");
      setRegion("");
      connectionIdempotencyKey.current = `agent37-connect-${crypto.randomUUID()}`;
      setMessage("Agent37 credentials were stored. Verify the control-plane key before use.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not connect Agent37");
    } finally {
      setBusy(false);
    }
  }
  async function verifyConnection(id: string) {
    setBusy(true);
    setMessage("");
    try {
      await apiFetch(`/v1/connections/${encodeURIComponent(id)}/verify`, {
        method: "POST",
        session: stableSession,
      });
      setMessage("Agent37 control-plane credentials verified. Runtime capabilities remain unverified.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not verify Agent37 credentials");
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function fetchProviderUsage(id: string) {
    setBusy(true);
    setMessage("");
    try {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
      const result = await apiFetch<Agent37UsageResponse>(`/v1/connections/${encodeURIComponent(id)}/usage?from=${from}&to=${to}`, {
        session: stableSession,
        cache: "no-store",
      });
      setProviderUsage((current) => ({ ...current, [id]: result }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not read Agent37 provider usage");
    } finally {
      setBusy(false);
    }
  }
  async function revokeConnection(id: string) {
    if (!window.confirm("Revoke this provider connection and queue cleanup for computers that use it?")) return;
    setBusy(true);
    setMessage("");
    try {
      await apiFetch(`/v1/connections/${encodeURIComponent(id)}`, {
        method: "DELETE",
        session: stableSession,
      });
      setMessage("Provider access was revoked. Any required provider cleanup remains queued until confirmed.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not revoke provider connection");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-block" style={panelStyle}>
      <div className="section-label" style={{ marginTop: 0 }}>
        Project computers
      </div>
      <p style={{ color: "var(--text3)", fontSize: 13, margin: "0 0 12px" }}>
        Computer configuration is stored per project. Provider allocation,
        execution, desktop control, and workspace sync become available after a
        provider and its runtime pass live verification.
      </p>
      <p style={{ color: "var(--text3)", fontSize: 12 }}>
        Providers: {providerMessage}
      </p>
      <label style={{ display: "grid", gap: 4, maxWidth: 520, marginBottom: 12, fontSize: 12 }}>
        Provider for the next computer
        <select value={computerConnectionId} onChange={(event) => setComputerConnectionId(event.target.value)} disabled={busy}>
          <option value="">Automatic provider selection</option>
          {connections.filter((connection) => connection.provider === "agent37" && connection.ownership === "customer_owned" && connection.status !== "revoked")
            .map((connection) => <option key={connection.id} value={connection.id}>Customer-owned Agent37 · {connection.region ?? "region not set"} · {connection.credentialCheckStatus ?? "not verified"}</option>)}
        </select>
      </label>
      <div style={{ margin: "16px 0", padding: 12, border: "1px solid var(--border)", borderRadius: 10 }}>
        <strong style={{ fontSize: 13 }}>Your Agent37 connection</strong>
        <p style={{ color: "var(--text3)", fontSize: 12 }}>
          This connects your own Agent37 account. Agent37 bills that account directly. A successful credential check verifies only the control-plane key; it does not verify runtime capabilities or enable rollout.
        </p>
        <form onSubmit={(event) => void connectAgent37(event)} style={{ display: "grid", gap: 8, maxWidth: 520 }}>
          <label style={{ fontSize: 12 }}>
            Agent37 API key
            <input autoComplete="off" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); connectionIdempotencyKey.current = `agent37-connect-${crypto.randomUUID()}`; }} disabled={busy} required />
          </label>
          <label style={{ fontSize: 12 }}>
            Agent37 instance key
            <input autoComplete="off" type="password" value={instanceKey} onChange={(event) => { setInstanceKey(event.target.value); connectionIdempotencyKey.current = `agent37-connect-${crypto.randomUUID()}`; }} disabled={busy} required />
          </label>
          <label style={{ fontSize: 12 }}>
            Provider region (optional)
            <input autoComplete="off" value={region} onChange={(event) => { setRegion(event.target.value); connectionIdempotencyKey.current = `agent37-connect-${crypto.randomUUID()}`; }} disabled={busy} maxLength={80} />
          </label>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !apiKey.trim() || !instanceKey.trim()}>
            {busy ? "Saving…" : "Connect Agent37 account"}
          </button>
        </form>
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {connections.filter((connection) => connection.provider === "agent37").map((connection) => (
            <div key={connection.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
              <div>
                <strong style={{ fontSize: 12 }}>Agent37 · {connection.ownership}</strong>
                <div style={{ color: "var(--text3)", fontSize: 11 }}>
                  {connection.status} · credential check: {connection.credentialCheckStatus ?? "not checked"}
                  {connection.region ? ` · ${connection.region}` : ""}
                  {connection.credentialCheckErrorCode ? ` · ${connection.credentialCheckErrorCode}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy || connection.status === "revoked"} onClick={() => void verifyConnection(connection.id)}>
                  Verify key
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy || connection.status === "revoked" || connection.credentialCheckStatus !== "verified"} onClick={() => void fetchProviderUsage(connection.id)}>
                  Read usage
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy || connection.status === "revoked"} onClick={() => void revokeConnection(connection.id)}>
                  Revoke
                </button>
              </div>
              {providerUsage[connection.id] && <div style={{ width: "100%", color: "var(--text3)", fontSize: 11 }}>
                Agent37 reported {new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(providerUsage[connection.id]!.usage.totalMicros / 1_000_000)}
                {` · ${providerUsage[connection.id]!.usage.from} to ${providerUsage[connection.id]!.usage.to} · `}
                {providerUsage[connection.id]!.usage.byIntegration.map((item) => `${item.kind} ${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(item.costMicros / 1_000_000)}`).join(" · ")}
                <div>{providerUsage[connection.id]!.notice}</div>
              </div>}
            </div>
          ))}
          {!loading && connections.every((connection) => connection.provider !== "agent37") && (
            <p style={{ color: "var(--text3)", fontSize: 12 }}>No Agent37 account is connected.</p>
          )}
        </div>
      </div>
      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          Loading computers…
        </p>
      ) : computers.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          No computers are configured for this project.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {computers.map((computer) => (
            <div
              key={computer.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                padding: 12,
                border: "1px solid var(--border)",
                borderRadius: 10,
              }}
            >
              <div>
                <strong style={{ fontSize: 13 }}>
                  {computer.templateId}@{computer.templateVersion}
                </strong>
                <div style={{ color: "var(--text3)", fontSize: 12 }}>
                  {computer.state} · {computer.providerPreference} ·{" "}
                  {computer.filesystemMode}
                </div>
                {computer.providerPreference === "agent37" && computer.ownership === "customer_owned" && (
                  <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                    <div style={{ color: "var(--text3)", fontSize: 11 }}>
                      AgentPort link: {computer.agentportLinkStatus ?? "not shared"}
                      {computer.agentportCapabilities?.length ? ` · ${computer.agentportCapabilities.join(", ")}` : ""}
                    </div>
                    {computer.agentportLinkStatus !== "active" && <fieldset style={{ border: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <legend style={{ fontSize: 11, color: "var(--text3)" }}>Choose exact assistant actions</legend>
                      {([
                        ["agent37.computer.start", "Start (may spend provider funds)"],
                        ["agent37.computer.sleep", "Sleep"],
                        ["agent37.exec", "Run commands"],
                        ["agent37.artifacts.read", "Read selected provider files"],
                        ["agent37.artifacts.write", "Import selected project files"],
                      ] as const).map(([capability, label]) => {
                        const selected = agent37Capabilities[computer.id] ?? computer.agentportCapabilities ?? [];
                        return <label key={capability} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                          <input type="checkbox" checked={selected.includes(capability)} disabled={busy} onChange={(event) => setAgent37Capabilities(current => ({
                            ...current,
                            [computer.id]: event.target.checked ? [...selected, capability] : selected.filter(value => value !== capability),
                          }))} />
                          {label}
                        </label>;
                      })}
                    </fieldset>}
                    {computer.agentportLinkStatus === "active" ? (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void revokeAgentPortShare(computer)}>Revoke AgentPort access</button>
                    ) : (
                      <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !(agent37Capabilities[computer.id]?.length ?? computer.agentportCapabilities?.length)} onClick={() => void shareWithAgentPort(computer)}>Share selected actions</button>
                    )}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                {computer.state === "recovery_required" && computer.activeOperationStatus === "indeterminate" &&
                  ["start", "sleep"].includes(computer.activeOperationType ?? "") && (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void reconcileTransition(computer)}>
                      Inspect uncertain action
                    </button>
                  )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void remove(computer.id)}
                >
                  Remove config
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {message && (
        <output
          aria-live="polite"
          style={{ color: "var(--text2)", fontSize: 12 }}
        >
          {message}
        </output>
      )}
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={busy}
        onClick={() => void createConfiguration()}
      >
        {busy ? "Saving…" : "Add computer configuration"}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={loading || busy}
        style={{ marginLeft: 8 }}
        onClick={() => void refresh()}
      >
        Refresh
      </button>
    </section>
  );
}
