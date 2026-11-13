"use client";
import * as React from "react";
import { FormSelect } from "@naelao/ui";
import { DEFAULT_ASSISTANT_VOICE, type AssistantVoicePreferences } from "@naelao/agent-sdk";
import { getAssistantVoice, listProjects, saveAssistantVoice, type AssistantVoiceSettings, type Project, type SessionCredentials } from "@/lib/api";

export function AssistantVoicePanel({ spaceId, session, canManage = false, onboarding = false }: {
  spaceId: string; session: SessionCredentials; canManage?: boolean; onboarding?: boolean;
}) {
  const [target, setTarget] = React.useState("space");
  const [settings, setSettings] = React.useState<AssistantVoiceSettings | null>(null);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [draft, setDraft] = React.useState<AssistantVoicePreferences>({ ...DEFAULT_ASSISTANT_VOICE });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const projectId = target.startsWith("project:") ? target.slice(8) : undefined;
  const selectedVoice = settings?.voiceCatalog?.find(voice => voice.id === draft.voiceProfileId && voice.modelClass === draft.modelClass)
    ?? settings?.voiceCatalog?.find(voice => voice.modelClass === draft.modelClass);
  const speechPerMinute = selectedVoice ? 375 * selectedVoice.speechRateUsdPerMillionCharacters / 1_000_000 : null;
  const transcriptionPerMinute = selectedVoice ? 30 * selectedVoice.transcriptionRateUsdPerSecond : null;

  React.useEffect(() => {
    let active = true;
    setSettings(null);
    getAssistantVoice(spaceId, session, projectId).then(value => {
      if (!active) return;
      setSettings(value);
      setDraft(value.preferences);
      setError("");
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : "Could not load voice settings"); });
    return () => { active = false; };
  }, [spaceId, session, projectId]);
  React.useEffect(() => { void listProjects(spaceId, session).then(setProjects).catch(() => setProjects([])); }, [spaceId, session]);

  async function save() {
    if (!settings || busy) return;
    setBusy(true); setError("");
    try {
      const updated = await saveAssistantVoice(spaceId, session, draft, settings.revision, projectId);
      setSettings(updated); setDraft(updated.preferences);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save voice settings"); }
    finally { setBusy(false); }
  }
  function update<K extends keyof AssistantVoicePreferences>(key: K, value: AssistantVoicePreferences[K]) {
    setDraft(current => ({ ...current, [key]: value }));
  }

  return <section className="settings-section">
    <h3>{onboarding ? "Assistant voice" : "Assistant voice settings"}</h3>
    <p>Choose whether this assistant can speak on calls. Voice uses the shared OpenRouter route and the configured call limits. Custom voice recordings and provider previews are not available until their consent and storage controls are enabled.</p>
    <FormSelect aria-label="Voice assistant scope" value={target} onChange={e => setTarget(e.target.value)}>
      <option value="space">Space assistant</option>
      {projects.map(project => <option key={project.id} value={`project:${project.id}`}>{project.name} assistant</option>)}
    </FormSelect>
    {settings && <>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
        <input type="checkbox" checked={draft.enabled} onChange={e => update("enabled", e.target.checked)} /> Enable voice calls for this assistant
      </label>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", marginTop: 14 }}>
        <label>Voice model class<FormSelect value={draft.modelClass} onChange={e => { const modelClass = e.target.value as AssistantVoicePreferences["modelClass"]; update("modelClass", modelClass); if (settings.voiceCatalog?.some(v => v.id === draft.voiceProfileId && v.modelClass !== modelClass)) update("voiceProfileId", null); }}><option value="economy">Economy</option><option value="balanced">Balanced</option><option value="advanced">Advanced</option></FormSelect></label>
        <label>Voice<FormSelect value={draft.voiceProfileId ?? ""} onChange={e => update("voiceProfileId", e.target.value || null)}><option value="">Default for model class</option>{(settings.voiceCatalog ?? []).filter(v => v.modelClass === draft.modelClass).map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</FormSelect></label>
        <label>Language (or auto)<input className="input" value={draft.language} maxLength={24} onChange={e => update("language", e.target.value)} /></label>
        <label>Speaking speed<input className="input" type="number" min={0.5} max={2} step={0.1} value={draft.speed} onChange={e => update("speed", Number(e.target.value))} /></label>
        <label>Call limit (minutes)<input className="input" type="number" min={1} max={240} step={1} value={draft.maxCallMinutes} onChange={e => update("maxCallMinutes", Number(e.target.value))} /></label>
        <label>Call spend limit (USD)<input className="input" type="number" min={0.01} max={100} step={0.01} value={draft.maxCallCostUsd} onChange={e => update("maxCallCostUsd", Number(e.target.value))} /></label>
      </div>
      <label style={{ display: "block", marginTop: 14 }}>Speaking style<textarea className="input" value={draft.deliveryInstructions} maxLength={1000} rows={3} onChange={e => update("deliveryInstructions", e.target.value)} placeholder="Optional guidance for concise spoken replies" /></label>
      {!projectId && <>
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}><input type="checkbox" checked={draft.allowProjectOverrides} onChange={e => update("allowProjectOverrides", e.target.checked)} /> Allow Project assistants to use tighter voice settings</label>
      </>}
      <p>Voice cloning and provider failover are unavailable until the host has consent, lifecycle and fallback controls. Calls fail closed if their selected model is unavailable.</p>
      {selectedVoice && <aside style={{ marginTop: 14, padding: 12, border: "1px solid var(--border, #ddd)", borderRadius: 8 }}>
        <strong>Selected voice catalog and list-rate estimate</strong>
        <p>{selectedVoice.speechProvider} speech: <code>{selectedVoice.speechModel}</code> / <code>{selectedVoice.speechVoice}</code> at {selectedVoice.sampleRate} Hz; ${selectedVoice.speechRateUsdPerMillionCharacters} {selectedVoice.speechRateUnit}. Transcription: {selectedVoice.transcriptionProvider} <code>{selectedVoice.transcriptionModel}</code> at ${selectedVoice.transcriptionRateUsdPerSecond} {selectedVoice.transcriptionRateUnit}.</p>
        <p>Supported catalog languages: {selectedVoice.languages.join(", ")}. Illustrative speech subtotal: ${(speechPerMinute! + transcriptionPerMinute!).toFixed(6)} per minute equivalent, assuming 375 generated characters and 30 seconds of transcription. This is a published list-rate estimate, not a quote, invoice or measured cost. Catalog research snapshot: {settings.voiceCatalogResearch?.date ?? "date unavailable"}.</p>
        <p>Excluded: telephony and number rental, planner/LLM and tools, retrieval, runtime/compute/networking, retries, taxes and provider-specific routing or fallback charges. Provider availability, actual billed rates and regional eligibility have not been verified.</p>
        {settings.voiceCatalogResearch?.sources?.length ? <p>Rate references: {settings.voiceCatalogResearch.sources.map((source, index) => <React.Fragment key={source.url}>{index > 0 ? "; " : ""}<a href={source.url} target="_blank" rel="noreferrer">{source.label}</a></React.Fragment>)}</p> : null}
      </aside>}
      {settings.inherited && <p>These settings inherit from the Space. Saving creates Project overrides; Space limits still apply.</p>}
      <button type="button" className="btn btn-primary" disabled={busy || !canManage && !projectId} onClick={() => void save()} style={{ marginTop: 14 }}>{busy ? "Saving…" : "Save voice settings"}</button>
    </>}
    {error && <p role="alert" style={{ color: "var(--danger, #c33)" }}>{error}</p>}
  </section>;
}
