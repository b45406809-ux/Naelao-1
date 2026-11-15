"use client";

import * as React from "react";
import { getProjectExtensionAgentMaintenance, grantProjectExtensionAgentMaintenance, revokeProjectExtensionAgentMaintenance, type ProjectExtensionAgentMaintenanceResponse, type SessionCredentials } from "@/lib/api";

export function ExtensionAgentMaintenanceDelegation({ spaceId, projectId, installationId, session }: {
  spaceId: string; projectId: string; installationId: string; session: SessionCredentials;
}) {
  const [data, setData] = React.useState<ProjectExtensionAgentMaintenanceResponse | null>(null);
  const [selectedAgent, setSelectedAgent] = React.useState("");
  const [busyAgent, setBusyAgent] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const result = await getProjectExtensionAgentMaintenance(spaceId, projectId, installationId, session);
    setData(result);
    setSelectedAgent(current => current && result.eligible_agents.some(agent => agent.id === current)
      ? current : result.eligible_agents[0]?.id ?? "");
  }, [spaceId, projectId, installationId, session]);
  React.useEffect(() => {
    let cancelled = false;
    setData(null); setError(null);
    void getProjectExtensionAgentMaintenance(spaceId, projectId, installationId, session)
      .then(result => { if (!cancelled) { setData(result); setSelectedAgent(result.eligible_agents[0]?.id ?? ""); } })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : "Agent maintenance grants are unavailable."); });
    return () => { cancelled = true; };
  }, [spaceId, projectId, installationId, session]);

  async function grant() {
    if (!data || !selectedAgent || busyAgent) return;
    const current = data.grants.find(item => item.agent_id === selectedAgent);
    setBusyAgent(selectedAgent); setError(null); setNotice(null);
    try {
      await grantProjectExtensionAgentMaintenance(spaceId, projectId, installationId, session,
        { agentId: selectedAgent, expectedRevision: current?.revision ?? 0 });
      await reload();
      setNotice("The agent can propose settings drafts for this installation. Owner publication is still required.");
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't grant agent maintenance."); }
    finally { setBusyAgent(null); }
  }

  async function revoke(agentId: string, revision: number) {
    if (busyAgent) return;
    setBusyAgent(agentId); setError(null); setNotice(null);
    try {
      await revokeProjectExtensionAgentMaintenance(spaceId, projectId, installationId, session, { agentId, expectedRevision: revision });
      await reload(); setNotice("The agent's settings proposal grant was revoked.");
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't revoke agent maintenance."); }
    finally { setBusyAgent(null); }
  }

  return <details style={{ marginTop: 10, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
    <summary style={{ cursor: "pointer", fontSize: 11.5, fontWeight: 600 }}>Delegate settings proposals</summary>
    <p style={{ fontSize: 11.5, color: "var(--text3)", margin: "8px 0" }}>
      Delegation is limited to this installation. The agent can propose values allowed by the signed settings schema. It cannot publish settings, update package code, manage publishers, or read provider credentials.
    </p>
    {error && <p role="alert" style={{ color: "var(--danger, #b42318)", fontSize: 11.5 }}>{error}</p>}
    {notice && <p role="status" style={{ color: "var(--text2)", fontSize: 11.5 }}>{notice}</p>}
    {!data ? <p role="status" style={{ fontSize: 11.5 }}>Loading eligible agents…</p> : <>
      {data.eligible_agents.length === 0 ? <p role="status" style={{ fontSize: 11.5 }}>This project has no eligible active agents.</p> : <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ fontSize: 11.5 }}>Project agent
          <select aria-label="Project agent for settings proposals" value={selectedAgent} onChange={event => setSelectedAgent(event.target.value)} style={{ display: "block", marginTop: 4, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 7px" }}>
            {data.eligible_agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.id}</option>)}
          </select>
        </label>
        <button type="button" className="btn-ghost" disabled={!selectedAgent || !!busyAgent || data.grants.some(item => item.agent_id === selectedAgent)} onClick={() => void grant()}>
          {busyAgent === selectedAgent ? "Saving…" : data.grants.some(item => item.agent_id === selectedAgent) ? "Granted" : "Allow proposals"}
        </button>
      </div>}
      {data.grants.length > 0 && <ul aria-label="Agents allowed to propose settings" style={{ paddingLeft: 20, fontSize: 11.5 }}>
        {data.grants.map(grant => <li key={grant.agent_id} style={{ marginTop: 6 }}>
          {data.eligible_agents.find(agent => agent.id === grant.agent_id)?.name ?? grant.agent_id} · revision {grant.revision}
          <button type="button" className="btn-ghost" style={{ marginLeft: 8, fontSize: 11 }} disabled={!!busyAgent} onClick={() => void revoke(grant.agent_id, grant.revision)}>
            {busyAgent === grant.agent_id ? "Revoking…" : "Revoke"}
          </button>
        </li>)}
      </ul>}
    </>}
  </details>;
}
