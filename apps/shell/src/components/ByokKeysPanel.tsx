"use client";

// Space-owner model credentials. Values are posted once to the vault and are never rendered
// back into the application; metadata supports multiple independently rotatable keys/provider.

import * as React from "react";
import { Button, Badge, FormInput, useToast, Toast } from "@naelao/ui";
import {
  getByokStatus,
  setByokKey,
  selectByokKey,
  deleteByokKey,
  getOpenRouterModels,
  type ByokProviderStatus,
  type OpenRouterModelCandidate,
  type SessionCredentials,
} from "@/lib/api";

const PROVIDERS = [
  { id: "openrouter", label: "OpenRouter", hint: "Use an OpenRouter API key. Model availability will be checked against the connected account." },
] as const;

function providerLabel(provider: string): string {
  return PROVIDERS.find((item) => item.id === provider)?.label ?? provider;
}

export function ByokKeysPanel({
  spaceId,
  creds,
  canEdit,
}: {
  spaceId: string;
  creds: SessionCredentials;
  canEdit: boolean;
}) {
  const { toast, show } = useToast();
  const [status, setStatus] = React.useState<ByokProviderStatus[]>([]);
  const [models, setModels] = React.useState<OpenRouterModelCandidate[]>([]);
  const [provider, setProvider] = React.useState<string>(PROVIDERS[0].id);
  const [label, setLabel] = React.useState("");
  const [keyInput, setKeyInput] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [modelsError, setModelsError] = React.useState<string | null>(null);

  const refreshModels = React.useCallback(async () => {
    setModelsError(null);
    try {
      const result = await getOpenRouterModels(spaceId, creds);
      setModels(result.models ?? []);
      if (result.configured && result.availability_note) setModelsError(result.availability_note);
    } catch {
      setModels([]);
      setModelsError("OpenRouter model inventory is unavailable. The saved key remains in the vault; try refreshing later.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const nextStatus = await getByokStatus(spaceId, creds);
      setStatus(nextStatus);
      if (nextStatus.some(item => item.provider === "openrouter" && item.keys.length > 0)) await refreshModels();
      else setModels([]);
    } catch {
      setLoadError("Couldn't load the saved provider keys. Try refreshing this section.");
    } finally {
      setLoading(false);
    }
    // Session credentials are stable for this mounted settings surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, refreshModels]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  async function add() {
    const value = keyInput.trim();
    if (!value) return;
    setBusy(true);
    try {
      await setByokKey(spaceId, creds, provider, value, label);
      setKeyInput("");
      setLabel("");
      show(`${providerLabel(provider)} key saved and selected as preferred.`);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't save the provider key.");
    } finally {
      setBusy(false);
    }
  }

  async function select(providerId: string, keyId: string) {
    setBusy(true);
    try {
      await selectByokKey(spaceId, creds, providerId, keyId);
      show("Preferred key updated.");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't select that key.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(providerId: string, keyId: string) {
    setBusy(true);
    try {
      await deleteByokKey(spaceId, creds, providerId, keyId);
      show("Provider key removed.");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't remove the provider key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p className="settings-row-sub">Add one or more OpenRouter keys. The selected key is tried first; eligible failures can rotate to another saved key.</p>
      {canEdit && (
        <div className="settings-block" style={{ display: "grid", gap: 8 }}>
          <label className="settings-row-sub" htmlFor="byok-provider">Provider</label>
          <select id="byok-provider" value={provider} onChange={(event) => setProvider(event.target.value)} style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "9px 10px" }}>
            {PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <p className="settings-row-sub">{PROVIDERS.find((item) => item.id === provider)?.hint}</p>
          <FormInput aria-label="Key label" placeholder="Label (optional, e.g. Production)" value={label} onChange={(event) => setLabel(event.target.value)} autoComplete="off" />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <FormInput aria-label="Provider API key" placeholder={`Paste a ${providerLabel(provider)} API key`} value={keyInput} onChange={(event) => setKeyInput(event.target.value)} type="password" autoComplete="new-password" style={{ flex: 1 }} />
            <Button size="sm" onClick={() => void add()} disabled={busy || !keyInput.trim()}>{busy ? "Saving…" : "Add key"}</Button>
          </div>
        </div>
      )}

      {loading ? <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading provider keys…</p> : null}
      {loadError ? <p role="alert" style={{ color: "var(--text3)", fontSize: 13 }}>{loadError}</p> : null}
      {!loading && status.map((item) => (
        <div key={item.provider} className="settings-block" style={{ display: "grid", gap: 8 }}>
          <div className="settings-row-label">{providerLabel(item.provider)} <Badge color={item.keys.length ? "green" : "amber"}>{item.keys.length ? `${item.keys.length} key${item.keys.length === 1 ? "" : "s"}` : "Platform key"}</Badge></div>
          {item.keys.map((entry) => (
            <div key={entry.id} className="settings-row" style={{ alignItems: "center", gap: 8 }}>
              <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{entry.label || "Unnamed key"}</span>
              {entry.active ? <Badge color="green">Preferred</Badge> : canEdit && item.provider === "openrouter" ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void select(item.provider, entry.id)}>Use first</Button> : null}
              {canEdit ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void remove(item.provider, entry.id)}>Remove</Button> : null}
            </div>
          ))}
        </div>
      ))}
      {!canEdit && <p style={{ fontSize: 11.5, color: "var(--text3)" }}>Only the owner or an admin can change these keys.</p>}
      {models.length > 0 && <details className="settings-block">
        <summary className="settings-row-label">OpenRouter catalog ({models.length} models)</summary>
        <p className="settings-row-sub">These are public catalog entries, not a guarantee that this key can use them. The provider confirms access when a request is sent.</p>
        <div style={{ display: "grid", gap: 5, maxHeight: 280, overflow: "auto" }}>
          {models.slice(0, 100).map((item) => <div key={item.id} className="settings-row-sub">{item.name} <span style={{ opacity: 0.7 }}>({item.id})</span>{item.contextLength ? ` · ${item.contextLength.toLocaleString()} context` : ""}</div>)}
        </div>
      </details>}
      {modelsError && <p role="status" className="settings-row-sub">{modelsError}</p>}
      <p style={{ fontSize: 11.5, color: "var(--text3)" }}>Keys are encrypted in the Space vault and never shown again. Previously saved Gemini or Groq keys can be removed below; new BYOK keys use OpenRouter.</p>
      <Toast toast={toast} />
    </div>
  );
}
