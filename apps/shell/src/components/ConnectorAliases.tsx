"use client";

import {
  type ConnectorAlias,
  type ConnectorInfo,
  type SessionCredentials,
  createConnectorAlias,
  deleteConnectorAlias,
  getConnectorAliases,
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
      {aliases.length === 0 ? (
        <p className="settings-row-sub">No aliases yet.</p>
      ) : (
        aliases.map((alias) => (
          <div className="settings-row" key={alias.id}>
            <div>
              <div className="settings-row-label">
                <code>{alias.alias}</code>
              </div>
              <div className="settings-row-sub">
                {alias.scope === "space" ? "Space assistant and permitted projects" : alias.scope === "project" ? `Project · ${projects.find((project) => project.id === alias.project_id)?.name ?? "selected project"}` : "Only your account"}
                <span data-technical-detail="identifiers"> · {alias.server_id}</span>
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void deleteConnectorAlias(spaceId, alias.id, session)
                  .then(refresh)
                  .catch((error) =>
                    onError(
                      error instanceof Error
                        ? error.message
                        : "Couldn't remove alias"
                    )
                  )
              }
            >
              Remove
            </Button>
          </div>
        ))
      )}
    </section>
  );
}
