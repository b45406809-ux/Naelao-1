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
  filesystemMode: string;
};
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
  const [providerMessage, setProviderMessage] = React.useState(
    "Checking provider availability…"
  );
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const [inventory, provider] = await Promise.all([
        apiFetch<{ computers: Computer[] }>("/v1/computers", {
          session: stableSession,
          cache: "no-store",
        }),
        apiFetch<{
          providers: Array<{ id: string; status: string; reason: string }>;
        }>("/v1/providers", { session: stableSession, cache: "no-store" }),
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
          provider: "auto",
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
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void remove(computer.id)}
              >
                Remove config
              </button>
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
