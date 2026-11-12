"use client";

import {
  type ConnectorAlias,
  type ConnectorInfo,
  type SessionCredentials,
  createConnectorAlias,
  deleteConnectorAlias,
  getConnectorAliases,
  assistantMailApi,
  listProjects,
  type Project,
} from "@/lib/api";
import { Button, FormInput } from "@naelao/ui";
import * as React from "react";

export function ConnectorAliases({
  spaceId,
  session,
  connectors,
  onError,
}: {
  spaceId: string;
  session: SessionCredentials;
  connectors: ConnectorInfo[];
  onError(message: string): void;
}) {
  const [aliases, setAliases] = React.useState<ConnectorAlias[]>([]);
  const [name, setName] = React.useState("");
  const [connector, setConnector] = React.useState("");
  const [scope, setScope] = React.useState<"space" | "project" | "user">("space");
  const [projectId, setProjectId] = React.useState("");
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [agentPortTools, setAgentPortTools] = React.useState<Record<string, string[]>>({});
  const [agentPortSelected, setAgentPortSelected] = React.useState<Record<string, string[]>>({});
  const [agentPortBusy, setAgentPortBusy] = React.useState("");
  const [agentPortNotice, setAgentPortNotice] = React.useState("");

  const refresh = React.useCallback(async () => {
    try {
      setAliases(await getConnectorAliases(spaceId, session));
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Couldn't load connector aliases"
      );
    }
  }, [spaceId, session, onError]);

  React.useEffect(() => {
    void refresh();
    listProjects(spaceId, session).then((items) => setProjects(items.filter((item) => item.status !== "archived"))).catch(() => setProjects([]));
  }, [refresh, spaceId, session]);
  const connected = connectors.filter((item) => item.connected);

  async function create() {
    if (!name || !connector || (scope === "project" && !projectId)) return;
    setBusy(true);
    try {
      await createConnectorAlias(
        spaceId,
        { alias: name, scope, connector_name: connector, ...(scope === "project" ? { project_id: projectId } : {}) },
        session
      );
      setName("");
      await refresh();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Couldn't create connector alias"
      );
    } finally {
      setBusy(false);
    }
  }

  async function discoverAgentPortTools(alias: ConnectorAlias) {
    setAgentPortBusy(alias.id);
    try {
      const result = await assistantMailApi<{ tools: Array<{ name: string }> }>(spaceId, session,
        { action: "userport-agentport-discover", alias_id: alias.id,
          ...(alias.scope === "project" && alias.project_id ? { projectId: alias.project_id } : {}) }, true);
      const names = result.tools.map((tool) => tool.name);
      setAgentPortTools((current) => ({ ...current, [alias.id]: names }));
      setAgentPortSelected((current) => ({ ...current,
        [alias.id]: (current[alias.id] ?? names).filter((name) => names.includes(name)) }));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Couldn't discover AgentPort actions");
    } finally { setAgentPortBusy(""); }
  }

  async function syncAgentPort(alias: ConnectorAlias) {
    const toolNames = agentPortSelected[alias.id] ?? [];
    if (!toolNames.length) return;
    setAgentPortBusy(alias.id);
    try {
      await assistantMailApi(spaceId, session, { action: "userport-agentport-sync", alias_id: alias.id, tool_names: toolNames,
        ...(alias.scope === "project" && alias.project_id ? { projectId: alias.project_id } : {}) }, true);
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Couldn't sync this connector with AgentPort");
    } finally { setAgentPortBusy(""); }
  }

  async function revokeAgentPort(alias: ConnectorAlias) {
    setAgentPortBusy(alias.id);
    setAgentPortNotice("");
    try {
      await assistantMailApi(spaceId, session, { action: "userport-agentport-revoke", alias_id: alias.id,
        ...(alias.scope === "project" && alias.project_id ? { projectId: alias.project_id } : {}) }, true);
      await refresh();
    } catch (error) {
      const message=error instanceof Error ? error.message : "Couldn't revoke the AgentPort connector link";
      onError(message === "userport_agentport_sync_cleanup_pending"
        ? "AgentPort access is blocked while scheduled cleanup finishes. Retry the revoke after the connector status refreshes."
        : message);
    } finally { setAgentPortBusy(""); }
  }

  async function unlinkAgentPortOwner(ownerLinkId: string) {
    if (!window.confirm("Disconnect this owner from AgentPort? This revokes every UserPort connector link that uses this owner link across Spaces.")) return;
    setAgentPortBusy("organization");
    setAgentPortNotice("");
    try {
      const result=await assistantMailApi<{ cleanupPending?: number }>(spaceId, session,
        { action: "userport-agentport-owner-unlink", owner_link_id: ownerLinkId }, true);
      if (result.cleanupPending) setAgentPortNotice(`Owner link disconnected. ${result.cleanupPending} connector cleanup operation${result.cleanupPending === 1 ? " is" : "s are"} queued; AgentPort access is blocked until cleanup completes.`);
      await refresh();
    } catch (error) {
      const message=error instanceof Error ? error.message : "Couldn't disconnect the organization from AgentPort";
      onError(message === "userport_agentport_sync_pending"
        ? "A connector sync is still being reconciled. AgentPort remains linked until that operation is safe to finish; try again shortly."
        : message);
    } finally { setAgentPortBusy(""); }
  }

  return (
    <section
      className="settings-block"
      aria-labelledby="connector-alias-heading"
    >
      <div
        className="settings-row"
        style={{ alignItems: "flex-start", gap: 12 }}
      >
        <div style={{ flex: 1 }}>
          <div id="connector-alias-heading" className="settings-row-label">
            Logical aliases
          </div>
          <div className="settings-row-sub">
            Give automations stable names such as primary_inbox. Rebinding an
            app never changes workflow source code.
          </div>
        </div>
        {aliases.find((alias) => alias.agentport_owner_link_status === "active" && alias.agentport_owner_link_id)?.agentport_owner_link_id &&
          <Button size="sm" variant="secondary" disabled={agentPortBusy === "organization"}
            onClick={() => void unlinkAgentPortOwner(aliases.find((alias) => alias.agentport_owner_link_status === "active" && alias.agentport_owner_link_id)!.agentport_owner_link_id!)}>
            Disconnect AgentPort owner link
          </Button>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <FormInput
            aria-label="Alias name"
            placeholder="primary_inbox"
            value={name}
            onChange={(event) =>
              setName(
                event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "")
              )
            }
          />
          <select
            aria-label="Connected app"
            value={connector}
            onChange={(event) => setConnector(event.target.value)}
          >
            <option value="">Choose connected app</option>
            {connected.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <select aria-label="Connector availability scope" value={scope} onChange={(event) => setScope(event.target.value as "space" | "project" | "user")}>
            <option value="space">Space assistant and permitted projects</option>
            <option value="project">One project</option>
            <option value="user">My account only</option>
          </select>
          {scope === "project" && <select aria-label="Connector project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Choose project</option>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>}
          <Button
            size="sm"
            disabled={busy || name.length < 2 || !connector || (scope === "project" && !projectId)}
            onClick={() => void create()}
          >
            {busy ? "Saving…" : "Add alias"}
          </Button>
        </div>
      </div>
      {agentPortNotice && <p role="status" className="settings-row-sub">{agentPortNotice}</p>}
      {aliases.length === 0 ? (
        <p className="settings-row-sub">No aliases yet.</p>
      ) : (
        aliases.map((alias) => (
          <div className="settings-row" key={alias.id} style={{ flexWrap: "wrap" }}>
            <div>
              <div className="settings-row-label">
                <code>{alias.alias}</code>
              </div>
              <div className="settings-row-sub">
                {alias.scope === "space" ? "Space assistant and permitted projects" : alias.scope === "project" ? `Project · ${projects.find((project) => project.id === alias.project_id)?.name ?? "selected project"}` : "Only your account"}
                <span data-technical-detail="identifiers"> · {alias.server_id}</span>
                {alias.agentport_status ? <span> · AgentPort {alias.agentport_owner_link_status === "revoked" && alias.agentport_status === "active"
                  ? "revocation pending" : alias.agentport_status}</span> : null}
              </div>
              {alias.agentport_operations?.length ? <div className="settings-row-sub">Shared operations: {alias.agentport_operations.join(", ")}</div> : null}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Button size="sm" variant="secondary" disabled={agentPortBusy === alias.id} onClick={() => void discoverAgentPortTools(alias)}>
                {agentPortBusy === alias.id ? "Loading…" : "Discover AgentPort actions"}
              </Button>
              {alias.agentport_status === "active" && alias.agentport_owner_link_status === "active" && <Button size="sm" variant="secondary" disabled={agentPortBusy === alias.id} onClick={() => void revokeAgentPort(alias)}>
                Disconnect AgentPort
              </Button>}
              <Button size="sm" variant="secondary" onClick={() => void deleteConnectorAlias(spaceId, alias.id, session)
                .then(refresh).catch((error) => {
                  const message=error instanceof Error ? error.message : "Couldn't remove alias";
                  onError(message === "userport_agentport_sync_cleanup_pending"
                    ? "AgentPort access is blocked while scheduled cleanup finishes. Retry removing this alias after the connector status refreshes."
                    : message);
                })}>
                Remove alias
              </Button>
            </div>
            {agentPortTools[alias.id] && <div style={{ flexBasis: "100%", padding: "4px 10px 10px" }}>
              <div className="settings-row-sub">Select the exact tools this assistant may use. Provider credentials stay in the existing UserPort connector vault.</div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "8px 0" }}>
                {agentPortTools[alias.id]!.map((toolName) => <label key={toolName} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                  <input type="checkbox" checked={(agentPortSelected[alias.id] ?? []).includes(toolName)} onChange={(event) => setAgentPortSelected((current) => {
                    const selected = new Set(current[alias.id] ?? []);
                    if (event.target.checked) selected.add(toolName); else selected.delete(toolName);
                    return { ...current, [alias.id]: [...selected] };
                  })} />
                  {toolName}
                </label>)}
              </div>
              <Button size="sm" disabled={agentPortBusy === alias.id || !(agentPortSelected[alias.id]?.length)} onClick={() => void syncAgentPort(alias)}>
                {agentPortBusy === alias.id ? "Syncing…" : "Share selected tools with this assistant"}
              </Button>
            </div>}
          </div>
        ))
      )}
    </section>
  );
}
