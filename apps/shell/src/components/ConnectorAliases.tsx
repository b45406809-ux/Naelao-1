"use client";

import {
  type ConnectorAlias,
  type ConnectorInfo,
  type SessionCredentials,
  createConnectorAlias,
  deleteConnectorAlias,
  getConnectorAliases,
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

  React.useEffect(() => void refresh(), [refresh]);
  const connected = connectors.filter((item) => item.connected);

  async function create() {
    if (!name || !connector) return;
    setBusy(true);
    try {
      await createConnectorAlias(
        spaceId,
        { alias: name, scope: "space", connector_name: connector },
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
          <Button
            size="sm"
            disabled={busy || name.length < 2 || !connector}
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
                {alias.scope} connector · {alias.server_id}
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
