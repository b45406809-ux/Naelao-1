"use client";

// Step 28: business-wide BYOK LLM keys. An admin enters their business's OWN Gemini/Groq key so
// the business's runs draw on ITS provider quota instead of the platform's shared allowance. The
// key is vaulted server-side and never shown again — the UI only ever reports "connected" or not.

import * as React from "react";
import { Button, Badge, FormInput, useToast, Toast } from "@naelao/ui";
import {
  getByokStatus,
  setByokKey,
  deleteByokKey,
  type ByokProviderStatus,
  type SessionCredentials,
} from "@/lib/api";

const PROVIDER_LABEL: Record<string, string> = {
  "google-ai-studio": "Google AI Studio (Gemini)",
  groq: "Groq",
};
const PROVIDER_HINT: Record<string, string> = {
  "google-ai-studio": "Get a free key at aistudio.google.com → API keys.",
  groq: "Get a free key at console.groq.com → API Keys.",
};

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
  const [loading, setLoading] = React.useState(true);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [keyInput, setKeyInput] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getByokStatus(spaceId, creds));
    } catch {
      // A load failure just hides the state — never an error the user must act on.
      setStatus([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(provider: string) {
    if (!keyInput.trim()) return;
    setSaving(true);
    try {
      await setByokKey(spaceId, creds, provider, keyInput.trim());
      setEditing(null);
      setKeyInput("");
      show(`${PROVIDER_LABEL[provider] ?? provider} key saved.`);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't save the key.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(provider: string) {
    try {
      await deleteByokKey(spaceId, creds, provider);
      show(`${PROVIDER_LABEL[provider] ?? provider} key removed.`);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't remove the key.");
    }
  }

  if (loading) return <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {status.map((p) => (
        <div key={p.provider} className="settings-block" style={{ padding: 0 }}>
          <div className="settings-row" style={{ alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <div className="settings-row-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {PROVIDER_LABEL[p.provider] ?? p.provider}
                {p.configured ? <Badge color="green">Using your key</Badge> : <Badge color="amber">Platform key</Badge>}
              </div>
              <div className="settings-row-sub">
                {p.configured
                  ? "This business's runs on this provider use your own key and quota."
                  : PROVIDER_HINT[p.provider] ?? "Not configured — using the shared platform quota."}
              </div>
            </div>
            {canEdit && (
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <Button size="sm" variant="secondary" onClick={() => { setEditing(editing === p.provider ? null : p.provider); setKeyInput(""); }}>
                  {p.configured ? "Replace" : "Add key"}
                </Button>
                {p.configured && (
                  <Button size="sm" variant="secondary" onClick={() => void remove(p.provider)}>
                    Remove
                  </Button>
                )}
              </div>
            )}
          </div>
          {editing === p.provider && canEdit && (
            <div className="settings-row" style={{ gap: 8, alignItems: "center" }}>
              <FormInput
                placeholder={`Paste your ${PROVIDER_LABEL[p.provider] ?? p.provider} API key`}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                type="password"
                autoFocus
                style={{ flex: 1 }}
              />
              <Button size="sm" onClick={() => void save(p.provider)} disabled={saving || !keyInput.trim()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          )}
        </div>
      ))}
      {!canEdit && (
        <p style={{ fontSize: 11.5, color: "var(--text3)" }}>
          Only the owner or an admin can change these keys.
        </p>
      )}
      <Toast toast={toast} />
    </div>
  );
}
