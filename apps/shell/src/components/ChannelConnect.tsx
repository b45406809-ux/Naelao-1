"use client";

/**
 * Connecting a channel.
 *
 * This used to ask a business owner to go and build a bot: open a developer console, create an
 * app, find a signing secret, paste it here, then copy a webhook URL back into the provider. Every
 * one of those steps is somewhere a non-technical owner stops, and none of it was work they should
 * ever have been doing — it existed only because the platform had no app of its own.
 *
 * So the default is now a link and a QR of it. Naelao has one app per channel; the owner taps or
 * scans, and their business is connected. The old path is still here, one click away under "Set up
 * your own app", for a business that wants its own branded bot or a workspace we aren't installed
 * in — it's the advanced option, not the only one.
 */

import * as React from "react";
import { QrCode } from "@naelao/ui";
import { ALLOWED_MODELS } from "@naelao/billing-core";
import type { ChannelExtensionInstallation, ChannelExtensionInboxEvent, ChannelExtensionInboxNote, ChannelLink, ChannelPairing, ContainerInstallation, ExtensionProviderConnection, ExtensionPublisherKey, ExtensionRelease, RuntimeCatalogueEntry, SessionCredentials } from "@/lib/api";
import { updateAssistantChannel, pairAssistantChannel, listChannelExtensionInstallations, listChannelExtensionInbox, assignChannelExtensionInboxEvent, takeOverChannelExtensionInboxEvent, deleteChannelExtensionConversation, replyToChannelExtensionEvent, exportChannelExtensionConversation, listProjectExtensionReleases, rollbackProjectExtension, installProjectChannelExtension, installProjectCanvasExtension, getChannelExtensionSessionSummary, clearChannelExtensionSessionState, removeChannelExtension, listContainerInstallations, setProjectExtensionEnabled, listExtensionPublisherKeys, registerExtensionPublisherKey, revokeExtensionPublisherKey, getExtensionProviderConnection, startExtensionSlackOAuth, disconnectExtensionProvider, listProjectMembers, listChannelExtensionInboxNotes, addChannelExtensionInboxNote, listExtensionSlackRoutes, saveExtensionSlackRoutes, connectExtensionTelegram, connectExtensionWhatsApp, getChannelExtensionInboxSla, setChannelExtensionInboxSla, listRuntimeCatalogue, installRuntime } from "@/lib/api";
import { modelLabel } from "@/components/ModelSelector";

type ChannelId = "telegram" | "slack" | "discord" | "whatsapp" | "email";

export const CHANNELS: Array<{
  id: ChannelId;
  name: string;
  /** Why an owner would pick this one, in their terms. */
  pitch: string;
  /** Whether Naelao can host the connection, or the owner must bring their own app. */
  pairable: boolean;
  /** What the owner is looking for on the BYO path, in the provider's own words. */
  secretLabel: string;
  where: string;
}> = [
  {
    // First on purpose: free, no business verification, no per-message billing and no 24-hour
    // reply window — the easiest channel for a business with no budget to actually start on.
    id: "telegram",
    name: "Telegram",
    pitch: "Free, instant, works anywhere. The quickest way to start.",
    pairable: true,
    secretLabel: "Webhook Secret Token",
    where: "a token you choose yourself, then pass as secret_token when you call Telegram's setWebhook",
  },
  {
    id: "slack",
    name: "Slack",
    pitch: "For a team that already lives in Slack.",
    pairable: true,
    secretLabel: "Signing Secret",
    where: "Slack app → Basic Information → App Credentials → Signing Secret",
  },
  {
    id: "discord",
    name: "Discord",
    pitch: "For a community server.",
    pairable: true,
    secretLabel: "Public Key",
    where: "Discord Developer Portal → your app → General Information → Public Key",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    pitch: "Where most customers already are, in most of the world.",
    pairable: true,
    secretLabel: "App Secret",
    where: "Meta for Developers → your app → Settings → Basic → App Secret",
  },
  {
    id: "email",
    name: "Email",
    pitch: "Your business already has an address — nothing to set up.",
    pairable: false,
    secretLabel: "Webhook Signing Key",
    where: "Your inbound email provider's webhook settings (e.g. Mailgun signing key)",
  },
];

function ExtensionSessionControls({ spaceId, projectId, session, installation }: {
  spaceId: string; projectId: string; session: SessionCredentials; installation: ChannelExtensionInstallation;
}) {
  const enabled = installation.channels.some(channel => channel.session?.enabled);
  const [summary, setSummary] = React.useState<{ activeConversations: number; storedBytes: number; nextExpiryAt: number | null } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const refresh = React.useCallback(async () => {
    const value = await getChannelExtensionSessionSummary(spaceId, projectId, installation.instance_id, session);
    setSummary(value);
  }, [spaceId, projectId, installation.instance_id, session]);
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getChannelExtensionSessionSummary(spaceId, projectId, installation.instance_id, session)
      .then(value => { if (!cancelled) setSummary(value); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load retention status."); });
    return () => { cancelled = true; };
  }, [enabled, spaceId, projectId, installation.instance_id, session]);
  if (!enabled) return null;
  async function clear() {
    if (busy || !window.confirm("Delete all saved conversation state for this extension in this project? Message history is not deleted.")) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await clearChannelExtensionSessionState(spaceId, projectId, installation.instance_id, session);
      await refresh();
      setNotice(`Deleted saved state for ${result.deletedConversations} conversation${result.deletedConversations === 1 ? "" : "s"}.`);
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't clear saved state."); }
    finally { setBusy(false); }
  }
  return <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--text2)" }}>
    <span>Conversation state: {summary ? `${summary.activeConversations} active · ${summary.storedBytes} bytes` : "loading…"}</span>
    {summary?.nextExpiryAt && <span> · earliest expiry {new Date(summary.nextExpiryAt).toLocaleDateString()}</span>}
    <button type="button" className="btn-ghost" style={{ marginLeft: 8, fontSize: 11 }} disabled={busy || !summary?.activeConversations} onClick={() => void clear()}>
      {busy ? "Clearing…" : "Clear saved state"}
    </button>
    {error && <span role="alert" style={{ display: "block", color: "var(--danger, #b42318)" }}>{error}</span>}
    {notice && <span role="status" style={{ display: "block" }}>{notice}</span>}
  </div>;
}

function ExtensionConnectionControls({ spaceId, projectId, session, installation, connection, canManage }: {
  spaceId: string; projectId: string; session: SessionCredentials; installation: ChannelExtensionInstallation;
  connection: NonNullable<ChannelExtensionInstallation["connections"]>[number]; canManage: boolean;
}) {
  const [status, setStatus] = React.useState<ExtensionProviderConnection | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [availableRoutes, setAvailableRoutes] = React.useState<Array<{ id: string; name: string; private: boolean }>>([]);
  const [routingKeys, setRoutingKeys] = React.useState<string[]>([]);
  const [telegramToken, setTelegramToken] = React.useState("");
  const [whatsAppToken, setWhatsAppToken] = React.useState("");
  const [whatsAppPhoneId, setWhatsAppPhoneId] = React.useState("");
  const refresh = React.useCallback(async () => {
    const value = await getExtensionProviderConnection(spaceId, projectId, installation.instance_id, connection.id, session);
    setStatus(value);
    setRoutingKeys(value?.routing_keys ?? []);
  }, [spaceId, projectId, installation.instance_id, connection.id, session]);
  React.useEffect(() => {
    let cancelled = false;
    getExtensionProviderConnection(spaceId, projectId, installation.instance_id, connection.id, session)
      .then(value => { if (!cancelled) { setStatus(value); setRoutingKeys(value?.routing_keys ?? []); } })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load connection status."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [spaceId, projectId, installation.instance_id, connection.id, session]);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const query = new URLSearchParams(window.location.search);
    if (query.has("extension_connection_error")) setError(`Slack setup did not finish (${query.get("extension_connection_error")}).`);
    if (query.get("extension_connection_connected") === "slack") {
      void refresh().then(() => setNotice("Slack workspace connected to this extension.")).catch(err => setError(err instanceof Error ? err.message : "Couldn't refresh connection status."));
    }
  }, [refresh]);
  async function connect() {
    setBusy(true); setError(null);
    try {
      const result = await startExtensionSlackOAuth(spaceId, projectId, installation.instance_id, connection.id, window.location.href, session);
      window.location.assign(result.authorize_url);
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't start Slack setup."); setBusy(false); }
  }
  async function disconnect() {
    if (!window.confirm(`Disconnect ${status?.account_label ?? "this Slack workspace"} from ${installation.name}?`)) return;
    setBusy(true); setError(null);
    try { await disconnectExtensionProvider(spaceId, projectId, installation.instance_id, connection.id, session); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't disconnect this provider."); }
    finally { setBusy(false); }
  }
  async function loadRoutes() {
    setBusy(true); setError(null);
    try { setAvailableRoutes(await listExtensionSlackRoutes(spaceId, projectId, installation.instance_id, connection.id, session)); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't load Slack conversations."); }
    finally { setBusy(false); }
  }
  async function saveRoutes() {
    setBusy(true); setError(null); setNotice(null);
    try { await saveExtensionSlackRoutes(spaceId, projectId, installation.instance_id, connection.id, routingKeys, session); await refresh(); setNotice("Slack conversation routing saved."); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't save Slack routing."); }
    finally { setBusy(false); }
  }
  async function connectTelegram() {
    setBusy(true); setError(null); setNotice(null);
    try { const result = await connectExtensionTelegram(spaceId, projectId, installation.instance_id, connection.id, telegramToken, session); setTelegramToken(""); await refresh(); setNotice(`Telegram ${result.account_label} connected to this extension.`); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't connect this Telegram bot."); }
    finally { setBusy(false); }
  }
  async function connectWhatsApp() {
    setBusy(true); setError(null); setNotice(null);
    try { const result = await connectExtensionWhatsApp(spaceId, projectId, installation.instance_id, connection.id, whatsAppToken, whatsAppPhoneId, session); setWhatsAppToken(""); await refresh(); setNotice(`WhatsApp ${result.account_label} connected. Configure Meta's app webhook at ${result.webhook_url} with the verify token supplied by your administrator.`); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't connect this WhatsApp number."); }
    finally { setBusy(false); }
  }
  return <div style={{ margin: "6px 0 4px 12px", fontSize: 11.5, color: "var(--text2)" }}>
    <span>{connection.id} · {connection.provider}: {loading ? "checking…" : status?.status === "active" ? `connected to ${status.account_label ?? status.account_id}` : status?.status === "error" || status?.status === "expired" ? "needs reconnect" : "not connected"}</span>
    {canManage && connection.provider === "slack" && <button type="button" className="btn-ghost" style={{ marginLeft: 8, fontSize: 11 }} disabled={busy || loading} onClick={() => void (status?.status === "active" ? disconnect() : connect())}>
      {busy ? "Working…" : status?.status === "active" ? "Disconnect" : "Connect Slack workspace"}
    </button>}
    {canManage && connection.provider === "telegram" && <>
      {status?.status === "active" ? <button type="button" className="btn-ghost" style={{ marginLeft: 8, fontSize: 11 }} disabled={busy || loading} onClick={() => void disconnect()}>{busy ? "Disconnecting…" : "Disconnect Telegram bot"}</button>
        : <form onSubmit={event => { event.preventDefault(); void connectTelegram(); }} style={{ display: "flex", gap: 5, marginTop: 5 }}>
          <input type="password" autoComplete="new-password" aria-label={`Telegram bot token for ${connection.id}`} placeholder="Paste the token from BotFather" value={telegramToken} onChange={change => setTelegramToken(change.target.value)} style={{ minWidth: 220, flex: 1, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, padding: 5 }} />
          <button type="submit" className="btn-ghost" disabled={busy || !telegramToken.trim()}>{busy ? "Connecting…" : "Connect Telegram bot"}</button>
        </form>}
      {status?.status !== "active" && <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text3)" }}>Create a bot with BotFather. The token is sent directly to Naelao’s credential vault and is not shown again.</div>}
    </>}
    {canManage && connection.provider === "whatsapp" && <>
      {status?.status === "active" ? <button type="button" className="btn-ghost" style={{ marginLeft: 8, fontSize: 11 }} disabled={busy || loading} onClick={() => void disconnect()}>{busy ? "Disconnecting…" : "Disconnect WhatsApp"}</button>
        : <form onSubmit={event => { event.preventDefault(); void connectWhatsApp(); }} style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
          <input type="password" autoComplete="new-password" aria-label={`Meta system-user token for ${connection.id}`} placeholder="Meta system-user access token" value={whatsAppToken} onChange={change => setWhatsAppToken(change.target.value)} style={{ minWidth: 220, flex: 1, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, padding: 5 }} />
          <input inputMode="numeric" autoComplete="off" aria-label={`WhatsApp phone-number ID for ${connection.id}`} placeholder="WhatsApp phone-number ID" value={whatsAppPhoneId} onChange={change => setWhatsAppPhoneId(change.target.value)} style={{ minWidth: 180, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, padding: 5 }} />
          <button type="submit" className="btn-ghost" disabled={busy || !whatsAppToken.trim() || !/^\d{5,32}$/.test(whatsAppPhoneId.trim())}>{busy ? "Connecting…" : "Connect WhatsApp"}</button>
        </form>}
      {status?.status !== "active" && <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text3)" }}>Use a Meta system-user token with WhatsApp Business Messaging access. It is verified against Meta and stored in Naelao’s credential vault. The shared Meta app webhook must also be configured by an administrator.</div>}
    </>}
    {canManage && connection.provider === "slack" && status?.status === "active" && <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 11, color: "var(--text3)" }}>Choose where this extension responds. Each Slack conversation can route to only one extension in this Space.</div>
      <button type="button" className="btn-ghost" style={{ marginTop: 4, fontSize: 10.5 }} disabled={busy} onClick={() => void loadRoutes()}>{busy ? "Loading…" : availableRoutes.length ? "Refresh Slack conversations" : "Load Slack conversations"}</button>
      {availableRoutes.length > 0 && <><select multiple aria-label={`Slack conversation routing for ${connection.id}`} value={routingKeys} onChange={change => setRoutingKeys(Array.from(change.target.selectedOptions, option => option.value))} style={{ display: "block", width: "100%", maxWidth: 360, minHeight: 84, marginTop: 5, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, padding: 5 }}>
        {availableRoutes.map(item => <option key={item.id} value={item.id}>{item.name}{item.private ? " · private" : ""}</option>)}
      </select><button type="button" className="btn-ghost" style={{ marginTop: 5, fontSize: 10.5 }} disabled={busy || !routingKeys.length} onClick={() => void saveRoutes()}>{busy ? "Saving…" : `Route ${routingKeys.length} conversation${routingKeys.length === 1 ? "" : "s"}`}</button></>}
      {availableRoutes.length === 0 && !busy && <span style={{ display: "block", marginTop: 3 }}>Select a conversation the bot has joined before routing messages to this extension.</span>}
    </div>}
    {error && <span role="alert" style={{ display: "block", color: "var(--danger, #b42318)" }}>{error}</span>}
    {notice && <span role="status" style={{ display: "block" }}>{notice}</span>}
  </div>;
}

function ExtensionInboxNotes({ spaceId, projectId, installationId, eventId, session }: { spaceId: string; projectId: string; installationId: string; eventId: string; session: SessionCredentials }) {
  const [notes, setNotes] = React.useState<ChannelExtensionInboxNote[]>([]);
  const [draft, setDraft] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function load() {
    setBusy(true); setError(null);
    try { setNotes(await listChannelExtensionInboxNotes(spaceId, projectId, installationId, eventId, session)); setLoaded(true); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't load team notes."); }
    finally { setBusy(false); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true); setError(null);
    try { const note = await addChannelExtensionInboxNote(spaceId, projectId, installationId, eventId, text, session); setNotes(current => [...current, note]); setLoaded(true); setDraft(""); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't save team note."); }
    finally { setBusy(false); }
  }
  return <details style={{ marginTop: 6 }} onToggle={event => { if (event.currentTarget.open && !loaded && !busy) void load(); }}>
    <summary style={{ cursor: "pointer", color: "var(--text2)" }}>Team-only notes ({loaded ? notes.length : "view"})</summary>
    {notes.map(note => <div key={note.note_id} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: "5px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ color: "var(--text3)" }}>{note.actor_id} · {new Date(note.created_at).toLocaleString()}</span><br />{note.note_text}
    </div>)}
    {busy && <div role="status">Loading or saving…</div>}
    {error && <div role="alert" style={{ color: "var(--danger, #b42318)" }}>{error}<button type="button" className="btn-ghost" onClick={() => void load()}>Retry</button></div>}
    <form onSubmit={submit} style={{ display: "flex", gap: 5, marginTop: 6 }}>
      <input aria-label="Internal team note" value={draft} onChange={change => setDraft(change.target.value)} maxLength={2000} placeholder="Add a private note for your team" style={{ flex: 1, minWidth: 0, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, padding: 5 }} />
      <button type="submit" className="btn-ghost" disabled={busy || !draft.trim()}>Add note</button>
    </form>
  </details>;
}

function ExtensionInbox({ spaceId, projectId, session, installation }: { spaceId: string; projectId: string; session: SessionCredentials; installation: ChannelExtensionInstallation }) {
  const [events, setEvents] = React.useState<ChannelExtensionInboxEvent[]>([]);
  const [projectMembers, setProjectMembers] = React.useState<Array<{ user_id: string; role: string }>>([]);
  const [slaMinutes, setSlaMinutes] = React.useState("60");
  const [slaConfigured, setSlaConfigured] = React.useState(false);
  const [savingSla, setSavingSla] = React.useState(false);
  const [pausedEvents, setPausedEvents] = React.useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = React.useState<{ before: number; beforeId: string } | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [takingOver, setTakingOver] = React.useState<string | null>(null);
  const [assigning, setAssigning] = React.useState<string | null>(null);
  const [deletingConversation, setDeletingConversation] = React.useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = React.useState<Record<string, string>>({});
  const [replyingTo, setReplyingTo] = React.useState<string | null>(null);
  const [exportingConversation, setExportingConversation] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    Promise.all([listChannelExtensionInbox(spaceId, projectId, installation.instance_id, session), listProjectMembers(spaceId, projectId, session), getChannelExtensionInboxSla(spaceId, projectId, installation.instance_id, session)])
      .then(([page, members, policy]) => { if (!cancelled) { setEvents(page.events); setProjectMembers(members); setSlaConfigured(!!policy); if (policy) setSlaMinutes(String(policy.first_response_seconds / 60)); setCursor(page.next_before !== null && page.next_before_id ? { before: page.next_before, beforeId: page.next_before_id } : null); } })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load extension inbox events."); });
    return () => { cancelled = true; };
  }, [spaceId, projectId, installation.instance_id, session]);
  async function saveSla() {
    if (savingSla) return;
    setSavingSla(true); setError(null);
    try { const policy = await setChannelExtensionInboxSla(spaceId, projectId, installation.instance_id, Number(slaMinutes) * 60, session); setSlaConfigured(true); setSlaMinutes(String(policy.first_response_seconds / 60)); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't update the first-response target."); }
    finally { setSavingSla(false); }
  }
  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true); setError(null);
    try {
      const page = await listChannelExtensionInbox(spaceId, projectId, installation.instance_id, session, cursor);
      setEvents(current => [...current, ...page.events]);
      setCursor(page.next_before !== null && page.next_before_id ? { before: page.next_before, beforeId: page.next_before_id } : null);
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't load older inbox events."); }
    finally { setLoadingMore(false); }
  }
  async function takeOver(eventId: string) {
    if (takingOver || !window.confirm("Pause the automatic handler for this customer's conversation so a team member can take over?")) return;
    setTakingOver(eventId); setError(null);
    try {
      const result = await takeOverChannelExtensionInboxEvent(spaceId, projectId, installation.instance_id, eventId, session);
      setPausedEvents(current => new Set(current).add(eventId));
      if (result.paused_pending_reply) setError("Automatic handling is paused; the pending event needs a team member reply.");
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't pause this conversation."); }
    finally { setTakingOver(null); }
  }
  async function setAssignment(event: ChannelExtensionInboxEvent, nextAssignee: string | null) {
    if (assigning) return;
    if (event.assigned_to === nextAssignee) return;
    setAssigning(event.event_id); setError(null);
    try {
      await assignChannelExtensionInboxEvent(spaceId, projectId, installation.instance_id, event.event_id, nextAssignee, event.assigned_to ?? null, session);
      setEvents(current => current.map(item => item.event_id === event.event_id ? { ...item, assigned_to: nextAssignee, assigned_by: session.endUserId, assigned_at: nextAssignee ? Date.now() : null } : item));
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't update inbox assignment."); }
    finally { setAssigning(null); }
  }
  async function deleteConversation(eventId: string) {
    if (deletingConversation || !window.confirm("Permanently delete this conversation's stored inbox history and extension session data? This does not delete messages held by the external provider.")) return;
    setDeletingConversation(eventId); setError(null);
    try {
      await deleteChannelExtensionConversation(spaceId, projectId, installation.instance_id, eventId, session);
      const page = await listChannelExtensionInbox(spaceId, projectId, installation.instance_id, session);
      setEvents(page.events); setCursor(page.next_before !== null && page.next_before_id ? { before: page.next_before, beforeId: page.next_before_id } : null);
      setPausedEvents(new Set());
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't delete this conversation's stored data."); }
    finally { setDeletingConversation(null); }
  }
  async function sendHumanReply(eventId: string) {
    const text = replyDrafts[eventId]?.trim() ?? "";
    if (replyingTo || !text) return;
    setReplyingTo(eventId); setError(null);
    try {
      await replyToChannelExtensionEvent(spaceId, projectId, installation.instance_id, eventId, text, session);
      setReplyDrafts(current => ({ ...current, [eventId]: "" }));
      const page = await listChannelExtensionInbox(spaceId, projectId, installation.instance_id, session);
      setEvents(page.events); setCursor(page.next_before !== null && page.next_before_id ? { before: page.next_before, beforeId: page.next_before_id } : null);
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't send the reply. Check the provider inbox before retrying an uncertain delivery."); }
    finally { setReplyingTo(null); }
  }
  async function exportConversation(eventId: string) {
    if (exportingConversation) return;
    setExportingConversation(eventId); setError(null);
    try {
      const transcript = await exportChannelExtensionConversation(spaceId, projectId, installation.instance_id, eventId, session);
      const url = URL.createObjectURL(new Blob([JSON.stringify(transcript, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `conversation-${new Date().toISOString().slice(0, 10)}.json`;
      link.click(); URL.revokeObjectURL(url);
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't export this conversation."); }
    finally { setExportingConversation(null); }
  }
  return <details style={{ marginTop: 8 }}>
    <summary style={{ cursor: "pointer", fontSize: 11.5 }}>Customer inbox ({events.length}{events.some(event => event.response_due_at !== null && event.response_due_at !== undefined && event.response_due_at < Date.now()) ? ` · ${events.filter(event => event.response_due_at !== null && event.response_due_at !== undefined && event.response_due_at < Date.now()).length} overdue` : ""})</summary>
    {error && <div role="alert" style={{ color: "var(--danger, #b42318)", fontSize: 11, marginTop: 6 }}>{error}</div>}
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7, fontSize: 11 }}>
      <label htmlFor={`inbox-sla-${installation.instance_id}`}>First response target</label>
      <select id={`inbox-sla-${installation.instance_id}`} value={slaMinutes} onChange={e => setSlaMinutes(e.target.value)} style={{ background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, padding: "3px 5px" }}>
        {[5, 15, 30, 60, 240, 1440, 10080].map(minutes => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} minutes` : minutes < 1440 ? `${minutes / 60} hours` : `${minutes / 1440} days`}</option>)}
      </select>
      <button type="button" className="btn-ghost" disabled={savingSla} onClick={() => void saveSla()}>{savingSla ? "Saving…" : slaConfigured ? "Update" : "Set target"}</button>
      {!slaConfigured && <span style={{ color: "var(--text3)" }}>Not configured</span>}
    </div>
    {!error && events.length === 0 && <div style={{ color: "var(--text3)", fontSize: 11, marginTop: 6 }}>No events for this installation yet.</div>}
    {events.map(event => <article key={event.event_id} style={{ marginTop: 7, padding: 8, border: "1px solid var(--border)", borderRadius: 6, fontSize: 11 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span>{event.channel} · {event.status}{event.response_due_at !== null && event.response_due_at !== undefined && <strong style={{ color: event.response_due_at < Date.now() ? "var(--danger, #b42318)" : "var(--text3)", marginLeft: 6 }}>{event.response_due_at < Date.now() ? "Overdue" : `Due ${new Date(event.response_due_at).toLocaleString()}`}</strong>}</span><time>{new Date(event.created_at).toLocaleString()}</time></div>
      <div style={{ marginTop: 4, color: "var(--text2)" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>Assignee
          <select aria-label={`Assign inbox event ${event.event_id}`} value={event.assigned_to ?? ""} disabled={!!assigning} onChange={change => void setAssignment(event, change.target.value || null)} style={{ maxWidth: 180, marginLeft: 4, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, padding: "3px 5px" }}>
            <option value="">Unassigned</option>
            {projectMembers.map(member => <option key={member.user_id} value={member.user_id}>{member.user_id}{member.role === "owner" ? " · owner" : ""}</option>)}
          </select>
        </label>
      </div>
      <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 5 }}>{event.text}</div>
      {event.reply_text && <div style={{ color: "var(--text2)", marginTop: 5 }}>Reply: {event.reply_text}</div>}
      {event.human_reply_text && <div style={{ color: "var(--text2)", marginTop: 5 }}>Team reply ({event.human_reply_status}): {event.human_reply_text}</div>}
      {event.error_code && <div role="status" style={{ color: "var(--danger, #b42318)", marginTop: 5 }}>Issue: {event.error_code}</div>}
      <ExtensionInboxNotes spaceId={spaceId} projectId={projectId} installationId={installation.instance_id} eventId={event.event_id} session={session} />
      <button type="button" className="btn-ghost" style={{ marginTop: 6, fontSize: 10.5 }} disabled={!!exportingConversation} onClick={() => void exportConversation(event.event_id)}>
        {exportingConversation === event.event_id ? "Exporting…" : "Export stored conversation"}
      </button>
      {(event.human_takeover || pausedEvents.has(event.event_id)) && <div role="status" style={{ marginTop: 5 }}>Automatic handling paused for this conversation. Reply through your connected provider inbox.</div>}
      <button type="button" className="btn-ghost" style={{ marginTop: 6, fontSize: 10.5 }} disabled={!!takingOver || event.human_takeover || pausedEvents.has(event.event_id) || event.status === "running" || event.status === "delivering"} onClick={() => void takeOver(event.event_id)}>
        {takingOver === event.event_id ? "Pausing…" : event.human_takeover || pausedEvents.has(event.event_id) ? "Bot paused" : "Pause bot for this conversation"}
      </button>
      <button type="button" className="btn-ghost" style={{ margin: "6px 0 0 6px", fontSize: 10.5 }} disabled={!!deletingConversation || event.status === "running" || event.status === "processing" || event.status === "delivering"} onClick={() => void deleteConversation(event.event_id)}>
        {deletingConversation === event.event_id ? "Deleting…" : "Delete stored conversation data"}
      </button>
      {event.human_takeover && <div style={{ display: "grid", gap: 5, marginTop: 7 }}>
        <label htmlFor={`extension-reply-${event.event_id}`}>Team reply</label>
        <textarea id={`extension-reply-${event.event_id}`} maxLength={2000} rows={3} value={replyDrafts[event.event_id] ?? ""} disabled={!!event.human_reply_status || !!replyingTo}
          onChange={e => setReplyDrafts(current => ({ ...current, [event.event_id]: e.target.value }))} placeholder="Write a reply to send through the connected channel" style={{ width: "100%", boxSizing: "border-box", background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: 7, font: "inherit" }} />
        <button type="button" className="btn-ghost" style={{ justifySelf: "start", fontSize: 10.5 }} disabled={!!replyingTo || !!event.human_reply_status || !replyDrafts[event.event_id]?.trim()} onClick={() => void sendHumanReply(event.event_id)}>
          {replyingTo === event.event_id ? "Sending…" : event.human_reply_status === "sent" ? "Team reply sent" : event.human_reply_status === "uncertain" ? "Delivery uncertain — check provider" : "Send team reply"}
        </button>
      </div>}
    </article>)}
    {cursor && <button type="button" className="btn-ghost" style={{ marginTop: 8, fontSize: 11 }} disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load older events"}</button>}
  </details>;
}

function ExtensionReleaseControls({ spaceId, projectId, session, installation }: { spaceId: string; projectId: string; session: SessionCredentials; installation: { extension_id: string; version?: string } }) {
  const [releases, setReleases] = React.useState<ExtensionRelease[]>([]);
  const [selected, setSelected] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const refresh = React.useCallback(() => listProjectExtensionReleases(spaceId, projectId, installation.extension_id, session).then(setReleases), [spaceId, projectId, installation.extension_id, session]);
  React.useEffect(() => { let live = true; void refresh().catch(err => { if (live) setError(err instanceof Error ? err.message : "Release history unavailable."); }); return () => { live = false; }; }, [refresh]);
  async function rollback() {
    if (!selected || !window.confirm(`Roll back ${installation.extension_id} to version ${selected}? This changes the active package version in this Space.`)) return;
    setBusy(true); setError(null);
    try { await rollbackProjectExtension(spaceId, projectId, installation.extension_id, selected, session); setSelected(""); await refresh(); window.location.reload(); }
    catch (err) { setError(err instanceof Error ? err.message : "Rollback failed."); }
    finally { setBusy(false); }
  }
  return <div style={{ marginTop: 7, fontSize: 11.5 }}>
    <span>Active package version: {installation.version ?? "legacy"}</span>
    <select aria-label={`Rollback version for ${installation.extension_id}`} value={selected} onChange={event => setSelected(event.target.value)} style={{ marginLeft: 8, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 6px" }}>
      <option value="">Choose verified release…</option>
      {releases.filter(release => release.signatureValid && release.version !== installation.version).map(release => <option key={release.version} value={release.version}>{release.version}</option>)}
    </select>
    <button type="button" className="btn-ghost" disabled={busy || !selected} onClick={() => void rollback()}>{busy ? "Rolling back…" : "Rollback"}</button>
    {error && <span role="alert" style={{ display: "block", color: "var(--danger, #b42318)" }}>{error}</span>}
  </div>;
}

export function ChannelConnect({
  spaceId,
  session,
  projectId,
  channels,
  canManage,
  onChanged,
}: {
  spaceId: string;
  session: SessionCredentials;
  projectId?: string | null;
  channels: ChannelLink[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = React.useState<ChannelId | null>(null);
  const [advanced, setAdvanced] = React.useState<ChannelId | null>(null);
  const [pairing, setPairing] = React.useState<ChannelPairing | null>(null);
  const [secret, setSecret] = React.useState("");
  const [mediaAccessToken, setMediaAccessToken] = React.useState("");
  const [whatsappPhoneNumberId, setWhatsappPhoneNumberId] = React.useState("");
  const [whatsappAccessToken, setWhatsappAccessToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = React.useState<{ channel: string; url: string } | null>(null);
  const [extensionInstallations, setExtensionInstallations] = React.useState<ChannelExtensionInstallation[]>([]);
  const [publisherKeys, setPublisherKeys] = React.useState<ExtensionPublisherKey[]>([]);
  const [newPublisherId, setNewPublisherId] = React.useState("pub_my_team");
  const [newPublisherPublicKey, setNewPublisherPublicKey] = React.useState("");
  const [otherProjectInstallations, setOtherProjectInstallations] = React.useState<ContainerInstallation[]>([]);
  const [runtimeCatalogue, setRuntimeCatalogue] = React.useState<RuntimeCatalogueEntry[]>([]);
  const [runtimeSlotLimit, setRuntimeSlotLimit] = React.useState<number | null>(null);
  const [runtimeCatalogueError, setRuntimeCatalogueError] = React.useState<string | null>(null);
  const [installingRuntime, setInstallingRuntime] = React.useState<string | null>(null);
  const [extensionLoadError, setExtensionLoadError] = React.useState<string | null>(null);
  const [extensionsLoading, setExtensionsLoading] = React.useState(false);
  const [installDialogOpen, setInstallDialogOpen] = React.useState(false);
  const [installManifestDraft, setInstallManifestDraft] = React.useState("");
  const [installSourcesDraft, setInstallSourcesDraft] = React.useState("");
  const [installingExtension, setInstallingExtension] = React.useState(false);
  const [removingExtension, setRemovingExtension] = React.useState<string | null>(null);
  const [changingExtension, setChangingExtension] = React.useState<string | null>(null);
  const [installScope, setInstallScope] = React.useState<"PROJECT_BOUND" | "PROJECT_SHARED">("PROJECT_BOUND");
  const [confirmUpgrade, setConfirmUpgrade] = React.useState(false);
  const [canvasManifestDraft, setCanvasManifestDraft] = React.useState("");
  const [canvasArtifactsDraft, setCanvasArtifactsDraft] = React.useState("");
  const [canvasInstallConfirmed, setCanvasInstallConfirmed] = React.useState(false);
  const [canvasInstanceKey, setCanvasInstanceKey] = React.useState("default");
  const [canvasPublisherKeyId, setCanvasPublisherKeyId] = React.useState("");
  const [canvasPublisherSignature, setCanvasPublisherSignature] = React.useState("");

  // Give the installer a readable map of the package graph before the owner approves raw JSON.
  // Deliberately project only public manifest fields; never echo arbitrary manifest values here.
  const bundlePreview = React.useMemo(() => {
    if (!canvasManifestDraft.trim()) return null;
    try {
      const root = JSON.parse(canvasManifestDraft) as Record<string, unknown>;
      const bundle = root && typeof root.bundle === "object" && root.bundle !== null ? root.bundle as Record<string, unknown> : null;
      if (!bundle) return { error: "No versioned bundle found." };
      const primitives = Array.isArray(bundle.primitives) ? bundle.primitives.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
      const roles = Array.isArray(bundle.workerRoles) ? bundle.workerRoles.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
      const connections = Array.isArray(bundle.connections) ? bundle.connections.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
      const knowledge = Array.isArray(bundle.knowledge) ? bundle.knowledge.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
      return {
        id: typeof bundle.id === "string" ? bundle.id : "Unknown extension",
        version: typeof bundle.version === "string" ? bundle.version : "Unknown version",
        primitives: primitives.map(item => ({ id: typeof item.id === "string" ? item.id : "unnamed", kind: typeof item.kind === "string" ? item.kind : "unknown",
          detail: item.kind === "workflow" && typeof item.entry === "string" ? item.entry : item.kind === "canvas" && typeof item.component === "string" ? item.component : undefined })),
        roles: roles.map(role => ({ id: typeof role.id === "string" ? role.id : "unnamed role", principal: typeof role.principal === "string" ? role.principal : "principal missing",
          invocation: typeof role.invocation === "string" ? role.invocation : "invocation missing", execution: typeof role.execution === "string" ? role.execution : "execution missing",
          parts: Array.isArray(role.primitiveIds) ? role.primitiveIds.filter((id): id is string => typeof id === "string") : [],
          grants: primitives.filter(part => part.kind === "workflow" && Array.isArray(role.primitiveIds) && role.primitiveIds.includes(part.id))
            .flatMap(part => Array.isArray(part.toolNames) ? part.toolNames.filter((name): name is string => typeof name === "string") : []) })),
        connections: connections.map(item => `${typeof item.id === "string" ? item.id : "connection"} · ${typeof item.provider === "string" ? item.provider : "provider missing"}${item.required === true ? " · required" : " · optional"}`),
        knowledge: knowledge.map(item => `${typeof item.id === "string" ? item.id : "collection"} · ${typeof item.access === "string" ? item.access : "access missing"}`),
      };
    } catch { return { error: "Manifest JSON is incomplete or invalid." }; }
  }, [canvasManifestDraft]);

  React.useEffect(() => {
    if (!projectId || !canManage) { setExtensionInstallations([]); setOtherProjectInstallations([]); setExtensionLoadError(null); setExtensionsLoading(false); return; }
    let cancelled = false;
    setExtensionInstallations([]); setOtherProjectInstallations([]);
    setExtensionsLoading(true);
    setExtensionLoadError(null);
    Promise.all([listChannelExtensionInstallations(spaceId, projectId, session), listContainerInstallations(spaceId, session, projectId, true), listExtensionPublisherKeys(spaceId, session)])
      .then(([items, installed, publishers]) => {
        if (cancelled) return;
        setExtensionInstallations(items);
        setPublisherKeys(publishers.publishers);
        const channelInstances = new Set(items.map(item => item.instance_id));
        setOtherProjectInstallations(installed.installations.filter(item => item.instance.project_id === projectId
          && ["active", "disabled", "staging"].includes(item.instance.status) && !!item.instance.instance_id && !channelInstances.has(item.instance.instance_id)));
      })
      .catch((err) => { if (!cancelled) { setExtensionInstallations([]); setOtherProjectInstallations([]); setPublisherKeys([]); setExtensionLoadError(err instanceof Error ? err.message : "Couldn't load project extensions."); } })
      .finally(() => { if (!cancelled) setExtensionsLoading(false); });
    return () => { cancelled = true; };
  }, [spaceId, projectId, session, canManage]);

  React.useEffect(() => {
    if (!projectId || !canManage) { setRuntimeCatalogue([]); setRuntimeSlotLimit(null); setRuntimeCatalogueError(null); return; }
    let cancelled = false;
    listRuntimeCatalogue(spaceId, session).then(result => { if (!cancelled) { setRuntimeCatalogue(result.images); setRuntimeSlotLimit(result.installed_slots_per_workspace); setRuntimeCatalogueError(null); } })
      .catch(error => { if (!cancelled) { setRuntimeCatalogue([]); setRuntimeSlotLimit(null); setRuntimeCatalogueError(error instanceof Error ? error.message : "Runtime catalogue is unavailable."); } });
    return () => { cancelled = true; };
  }, [spaceId, projectId, session, canManage]);

  const byId = new Map(channels.map((c) => [c.channel, c]));

  async function startPair(channel: ChannelId) {
    setBusy(true);
    setError(null);
    setPairing(null);
    setAdvanced(null);
    setOpen(channel);
    try {
      const res = await pairAssistantChannel(spaceId, session, channel, projectId ?? undefined);
      setPairing(res);
      // A redirect flow finishes in a browser tab, so send them there directly rather than making
      // them scan a code on the same screen they're already looking at.
      if (res.mode === "redirect") window.location.href = res.pair_url;
    } catch (err) {
      // The honest failure here is "we haven't set this channel up yet" — say that, and leave the
      // advanced path visible rather than pretending nothing is possible.
      setError(err instanceof Error ? err.message : "Couldn't start connecting just now.");
      setAdvanced(channel);
    } finally {
      setBusy(false);
    }
  }

  async function act(channel: ChannelId, action: "connect" | "disconnect" | "enable") {
    setBusy(true);
    setError(null);
    try {
      const res = await updateAssistantChannel(spaceId, session, {
        action,
        channel,
        ...(action === "connect" && projectId ? { project_id: projectId } : {}),
        ...(action === "connect" ? { secret } : {}),
        ...(action === "connect" && channel === "whatsapp" && mediaAccessToken.trim() ? { media_access_token: mediaAccessToken.trim() } : {}),
        ...(action === "connect" && channel === "whatsapp" && whatsappPhoneNumberId.trim() && whatsappAccessToken.trim()
          ? { whatsapp_phone_number_id: whatsappPhoneNumberId.trim(), whatsapp_access_token: whatsappAccessToken.trim() } : {}),
      });
      if (action === "connect") {
        setSecret("");
        setMediaAccessToken("");
        setWhatsappAccessToken("");
        setAdvanced(null);
        setOpen(null);
        if (res.webhook_url) setWebhookUrl({ channel, url: res.webhook_url });
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't do that just now.");
    } finally {
      setBusy(false);
    }
  }

  async function setChannelModel(channel: ChannelId, model: string) {
    setBusy(true); setError(null);
    try {
      await updateAssistantChannel(spaceId, session, { action: "set_model", channel, model_override: model || null });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change this channel's model.");
    } finally { setBusy(false); }
  }

  async function bindExtension(channel: ChannelId, instanceId: string) {
    if (!projectId) return;
    setBusy(true); setError(null);
    try {
      await updateAssistantChannel(spaceId, session, {
        action: instanceId ? "bind_extension" : "unbind_extension",
        channel, project_id: projectId, ...(instanceId ? { extension_instance_id: instanceId } : {}),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't bind this channel handler.");
    } finally { setBusy(false); }
  }

  async function installChannelExtension(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || installingExtension || !installManifestDraft.trim()) return;
    setInstallingExtension(true); setError(null);
    try {
      const manifest = JSON.parse(installManifestDraft) as unknown;
      const handlerSources = installSourcesDraft.trim()
        ? JSON.parse(installSourcesDraft) as Record<string, string>
        : undefined;
      const installed = await installProjectChannelExtension(spaceId, projectId, session, manifest, installScope, handlerSources, confirmUpgrade);
      if (!installed.installed) throw new Error(installed.message ?? installed.error_code ?? "Channel package installation failed");
      const updated = await listChannelExtensionInstallations(spaceId, projectId, session);
      setExtensionInstallations(updated);
      setInstallManifestDraft(""); setInstallSourcesDraft(""); setConfirmUpgrade(false); setInstallDialogOpen(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't install this channel package.");
    } finally { setInstallingExtension(false); }
  }

  async function installCanvasBundle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || installingExtension || !canvasManifestDraft.trim() || !canvasInstallConfirmed || !canvasPublisherKeyId || !canvasPublisherSignature.trim()) return;
    setInstallingExtension(true); setError(null);
    try {
      const manifest = JSON.parse(canvasManifestDraft) as unknown;
      const artifacts = JSON.parse(canvasArtifactsDraft) as Record<string, string>;
      const installed = await installProjectCanvasExtension(spaceId, projectId, session, manifest, artifacts, confirmUpgrade, canvasInstanceKey.trim(), { key_id: canvasPublisherKeyId, signature: canvasPublisherSignature.trim() });
      if (!installed.installed) throw new Error(installed.message ?? installed.error_code ?? "Canvas/Gadget package installation failed");
      const [channels, all] = await Promise.all([listChannelExtensionInstallations(spaceId, projectId, session), listContainerInstallations(spaceId, session, projectId, true)]);
      setExtensionInstallations(channels);
      const channelInstances = new Set(channels.map(item => item.instance_id));
      setOtherProjectInstallations(all.installations.filter(item => item.instance.project_id === projectId
        && ["active", "disabled", "staging"].includes(item.instance.status) && !!item.instance.instance_id && !channelInstances.has(item.instance.instance_id)));
      setCanvasManifestDraft(""); setCanvasArtifactsDraft(""); setCanvasPublisherSignature(""); setCanvasInstallConfirmed(false); setConfirmUpgrade(false); setCanvasInstanceKey("default");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't install this Canvas/Gadget package.");
    } finally { setInstallingExtension(false); }
  }

  async function registerPublisherKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newPublisherId.trim() || !newPublisherPublicKey.trim()) return;
    setBusy(true); setError(null);
    try {
      await registerExtensionPublisherKey(spaceId, session, newPublisherId.trim(), newPublisherPublicKey.trim());
      const result = await listExtensionPublisherKeys(spaceId, session);
      setPublisherKeys(result.publishers);
      setNewPublisherPublicKey("");
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't trust this publisher key."); }
    finally { setBusy(false); }
  }

  async function revokePublisherKey(keyId: string) {
    if (busy || !window.confirm("Revoke this publisher key? Releases signed by it will stop running in this Space.")) return;
    setBusy(true); setError(null);
    try {
      await revokeExtensionPublisherKey(spaceId, session, keyId);
      const result = await listExtensionPublisherKeys(spaceId, session);
      setPublisherKeys(result.publishers);
      if (canvasPublisherKeyId === keyId) { setCanvasPublisherKeyId(""); setCanvasPublisherSignature(""); }
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't revoke this publisher key."); }
    finally { setBusy(false); }
  }

  async function uninstallChannelExtension(instanceId: string) {
    if (!projectId || removingExtension || !window.confirm("Uninstall this extension instance? Any channel binding will be removed and its saved conversation state will be deleted.")) return;
    setRemovingExtension(instanceId); setError(null);
    try {
      await removeChannelExtension(spaceId, projectId, instanceId, session);
      const [channels, installed] = await Promise.all([listChannelExtensionInstallations(spaceId, projectId, session), listContainerInstallations(spaceId, session, projectId, true)]);
      setExtensionInstallations(channels);
      const channelInstances = new Set(channels.map(item => item.instance_id));
      setOtherProjectInstallations(installed.installations.filter(item => item.instance.project_id === projectId
        && ["active", "disabled", "staging"].includes(item.instance.status) && !!item.instance.instance_id && !channelInstances.has(item.instance.instance_id)));
      onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't uninstall this channel handler."); }
    finally { setRemovingExtension(null); }
  }

  async function changeProjectExtensionLifecycle(instanceId: string, enabled: boolean) {
    if (!projectId || changingExtension) return;
    const installation = extensionInstallations.find(item => item.instance_id === instanceId);
    const instance = otherProjectInstallations.find(item => item.instance.instance_id === instanceId);
    const label = installation?.name ?? instance?.manifest.id ?? "this extension";
    if (!enabled && !window.confirm(`Pause ${label}? New invocations will stop. Running work may finish; saved data and grants will be retained.`)) return;
    setChangingExtension(instanceId); setError(null);
    try {
      await setProjectExtensionEnabled(spaceId, projectId, instanceId, session, enabled);
      const [channels, all] = await Promise.all([listChannelExtensionInstallations(spaceId, projectId, session), listContainerInstallations(spaceId, session, projectId, true)]);
      setExtensionInstallations(channels);
      const channelInstances = new Set(channels.map(item => item.instance_id));
      setOtherProjectInstallations(all.installations.filter(item => item.instance.project_id === projectId && ["active", "disabled", "staging"].includes(item.instance.status) && !!item.instance.instance_id && !channelInstances.has(item.instance.instance_id)));
      onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't update extension status."); }
    finally { setChangingExtension(null); }
  }

  async function installProjectRuntime(imageId: string) {
    if (!projectId || installingRuntime) return;
    const image = runtimeCatalogue.find(item => item.id === imageId);
    const runtime = image?.install_manifest?.containers?.[0];
    if (!image?.available || image.plan_available === false || !runtime) return;
    if (!window.confirm(`Install ${image.name} for this project? It will run with ${runtime.resources.cpuCores} CPU cores and ${runtime.resources.memoryMb} MiB memory. The deployment and subscription plan will be checked again by Naelao.`)) return;
    setInstallingRuntime(imageId); setError(null);
    try {
      const result = await installRuntime(spaceId, session, imageId, { scope: "PROJECT_SHARED", projectId });
      if (result.status === "promotion_confirmation_required") throw new Error(result.warning ?? "This runtime is already installed in another scope. Install it from the Space runtime settings.");
      const all = await listContainerInstallations(spaceId, session, projectId, true);
      const channelInstances = new Set(extensionInstallations.map(item => item.instance_id));
      setOtherProjectInstallations(all.installations.filter(item => item.instance.project_id === projectId
        && ["active", "disabled", "staging"].includes(item.instance.status) && !!item.instance.instance_id && !channelInstances.has(item.instance.instance_id)));
      onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "Runtime installation was rejected."); }
    finally { setInstallingRuntime(null); }
  }

  return (
    <div>
      {extensionLoadError && <div role="alert" style={{ marginBottom: 10, color: "var(--danger, #b42318)", fontSize: 12 }}>{extensionLoadError}</div>}
      {projectId && canManage && <details style={{ marginBottom: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Install an approved project runtime</summary>
        <p style={{ fontSize: 11.5, color: "var(--text3)", margin: "8px 0" }}>Only deployment-approved images are installable. Naelao checks your current plan before installation and again before execution. A capability listed by a template does not mean its runtime is installed.</p>
        {runtimeSlotLimit !== null && <p style={{ fontSize: 11.5, color: "var(--text3)" }}>Runtime slots used: {otherProjectInstallations.reduce((total, item) => total + (item.manifest.containers?.length ?? 0), 0)} / {runtimeSlotLimit} for this project. Paused runtimes retain their slots; uninstall one to free capacity.</p>}
        {runtimeCatalogueError && <p role="alert" style={{ color: "var(--danger, #b42318)", fontSize: 11.5 }}>{runtimeCatalogueError}</p>}
        {!runtimeCatalogueError && runtimeCatalogue.filter(image => image.available).length === 0 && <p style={{ fontSize: 11.5, color: "var(--text3)" }}>No approved runtimes are deployed for installation in this environment.</p>}
        {runtimeCatalogue.filter(image => image.available).map(image => {
          const runtime = image.install_manifest?.containers?.[0];
          const installed = otherProjectInstallations.some(item => item.instance.extension_id === image.install_manifest?.id && item.instance.status === "active");
          const planBlocked = image.plan_available === false;
          return <div key={image.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border)", fontSize: 11.5 }}>
            <span><strong>{image.name}</strong> · {runtime ? `${runtime.resources.cpuCores} CPU · ${runtime.resources.memoryMb} MiB` : "runtime requirements unavailable"}{planBlocked ? ` · unavailable on this plan (${image.plan_reason ?? "plan limit"})` : ""}</span>
            <button type="button" className="btn-ghost" disabled={!!installingRuntime || installed || planBlocked || !runtime} onClick={() => void installProjectRuntime(image.id)}>{installed ? "Installed" : installingRuntime === image.id ? "Installing…" : "Install"}</button>
          </div>;
        })}
      </details>}
      {projectId && canManage && <details open={installDialogOpen} onToggle={event => setInstallDialogOpen(event.currentTarget.open)} style={{ marginBottom: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Install a channel extension package</summary>
        <p style={{ fontSize: 11.5, color: "var(--text3)", margin: "8px 0" }}>
          Paste a versioned channel-only manifest and, optionally, its handler source files as a JSON path-to-source map. Uploaded handlers are stored as immutable package source, separate from the general Skill Library. This installer does not accept Canvas, Gadget, member tools, or provider secrets. Connect the provider below, then bind the installed extension.
        </p>
        <form onSubmit={installChannelExtension} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 11.5, color: "var(--text2)" }}>Installation scope
            <select value={installScope} onChange={event => setInstallScope(event.target.value as "PROJECT_BOUND" | "PROJECT_SHARED")} style={{ display: "block", marginTop: 4, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7, padding: "6px 8px" }}>
              <option value="PROJECT_BOUND">This project</option>
              <option value="PROJECT_SHARED">Shared across project members</option>
            </select>
          </label>
          <label style={{ fontSize: 11.5, color: "var(--text2)" }} htmlFor="channel-extension-manifest">Install manifest JSON</label>
          <textarea id="channel-extension-manifest" value={installManifestDraft} onChange={event => setInstallManifestDraft(event.target.value)} rows={8} spellCheck={false}
            placeholder={'{\n  "id": "ext_student_helper",\n  "bundle": { "kind": "extension_bundle", "...": "..." }\n}'}
            style={{ width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "monospace", fontSize: 11, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7, padding: 8 }} />
          <label style={{ fontSize: 11.5, color: "var(--text2)" }} htmlFor="channel-extension-sources">Handler source files (optional JSON map)</label>
          <textarea id="channel-extension-sources" value={installSourcesDraft} onChange={event => setInstallSourcesDraft(event.target.value)} rows={8} spellCheck={false}
            placeholder={'{\n  "./student-answer.ts": "export async function run(args, ctx) { ... }"\n}'}
            style={{ width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "monospace", fontSize: 11, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7, padding: 8 }} />
          <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 11.5 }}><input type="checkbox" checked={confirmUpgrade} onChange={event => setConfirmUpgrade(event.target.checked)} />Approve a forward version upgrade for this extension ID</label>
          <div><button type="submit" className="btn-ghost" disabled={installingExtension || !installManifestDraft.trim()}>{installingExtension ? "Installing…" : "Validate and install"}</button></div>
        </form>
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6 }}>Installed project handlers</div>
          {extensionsLoading && <div role="status" style={{ fontSize: 11, color: "var(--text3)" }}>Loading installed handlers…</div>}
          {!extensionsLoading && extensionInstallations.length === 0 && <div style={{ fontSize: 11, color: "var(--text3)" }}>No channel handlers installed.</div>}
          {extensionInstallations.map(installation => <div key={installation.instance_id} style={{ padding: "7px 0", borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 11.5 }}>{installation.name} · {installation.scope === "PROJECT_SHARED" ? "shared" : "project"} · {installation.status === "active" ? "enabled" : "paused"}</div>
              <div style={{ display: "flex", gap: 5 }}>
              <button type="button" className="btn-ghost" style={{ fontSize: 11 }} disabled={!!changingExtension || !!removingExtension} onClick={() => void changeProjectExtensionLifecycle(installation.instance_id, installation.status !== "active")}>
                {changingExtension === installation.instance_id ? "Updating…" : installation.status === "active" ? "Pause" : "Resume"}
              </button>
              <button type="button" className="btn-ghost" style={{ fontSize: 11 }} disabled={!!removingExtension} onClick={() => void uninstallChannelExtension(installation.instance_id)}>
                {removingExtension === installation.instance_id ? "Uninstalling…" : "Uninstall"}
              </button>
              </div>
            </div>
            {installation.status === "disabled" && <div style={{ color: "var(--text3)", fontSize: 11 }}>New handler invocations are paused. Existing work may finish; data and grants are retained.</div>}
            {installation.status === "active" && <>{installation.connections?.map(connection => <ExtensionConnectionControls key={connection.id} spaceId={spaceId} projectId={projectId} session={session} installation={installation} connection={connection} canManage={canManage} />)}
            <ExtensionSessionControls spaceId={spaceId} projectId={projectId} session={session} installation={installation} />
            <ExtensionReleaseControls spaceId={spaceId} projectId={projectId} session={session} installation={installation} />
            <ExtensionInbox spaceId={spaceId} projectId={projectId} session={session} installation={installation} /></>}
          </div>)}
        </div>
      </details>}
      {projectId && canManage && <details style={{ marginBottom: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Install a project Canvas/Gadget extension</summary>
        <p style={{ fontSize: 11.5, color: "var(--text3)", margin: "8px 0" }}>This release can combine CanvasMount HTML, project-bound Gadget databases, external channel handlers, and Durable Workflow worker steps under one versioned extension ID. Canvas parts appear in the project Canvas selector and keep their own installed-instance scope. Channel handlers receive only the restricted external channel context. Workflow steps can call only the operation names declared in the bundle and enabled for the acting user by the host. Provider credentials are not package-bound here; connect channels through the existing provider controls. Review the manifest and every artifact before installing.</p>
        <section aria-label="Trusted extension publishers" style={{ margin: "10px 0", padding: 10, border: "1px solid var(--border)", borderRadius: 7 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600 }}>Trusted publishers for this Space</div>
          <p style={{ fontSize: 11, color: "var(--text3)", margin: "4px 0 8px" }}>Register a publisher public key separately from its packages. Private signing keys stay with the publisher; a revoked key blocks its releases and is not automatically restored.</p>
          <form onSubmit={registerPublisherKey} style={{ display: "grid", gap: 6, marginBottom: 8 }}>
            <input aria-label="Publisher ID" value={newPublisherId} onChange={event => setNewPublisherId(event.target.value)} pattern="pub_[a-z0-9_-]{1,48}" maxLength={52} required placeholder="pub_my_team" />
            <input aria-label="Publisher P-256 public key" value={newPublisherPublicKey} onChange={event => setNewPublisherPublicKey(event.target.value)} required placeholder="Base64url uncompressed P-256 public key" />
            <button type="submit" className="btn-ghost" disabled={busy || !newPublisherPublicKey.trim()}>{busy ? "Saving…" : "Trust publisher key"}</button>
          </form>
          {publisherKeys.map(key => <div key={key.key_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 10.5, borderTop: "1px solid var(--border)", padding: "5px 0" }}>
            <span>{key.publisher_id} · {key.key_id.slice(0, 12)}… · {key.status}</span>
            {key.status === "active" && <button type="button" className="btn-ghost" disabled={busy} onClick={() => void revokePublisherKey(key.key_id)}>Revoke</button>}
          </div>)}
          {publisherKeys.length === 0 && <div style={{ fontSize: 10.5, color: "var(--text3)" }}>No trusted publisher keys.</div>}
        </section>
        <form onSubmit={installCanvasBundle} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 11.5, color: "var(--text2)" }} htmlFor="canvas-extension-instance">Independent instance key
            <input id="canvas-extension-instance" value={canvasInstanceKey} onChange={event => setCanvasInstanceKey(event.target.value)} pattern="[a-z][a-z0-9_-]{1,31}" maxLength={32} required style={{ display: "block", marginTop: 4, width: "100%", boxSizing: "border-box", background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7, padding: 7 }} />
          </label>
          <label style={{ fontSize: 11.5, color: "var(--text2)" }} htmlFor="canvas-extension-manifest">Composed bundle manifest</label>
          <textarea id="canvas-extension-manifest" value={canvasManifestDraft} onChange={event => setCanvasManifestDraft(event.target.value)} rows={10} spellCheck={false} placeholder={'{"id":"ext_trading_mentor","type":"extension","declaredPermissions":[],"capabilityRequirements":["extension.project_canvas"],"gadgets":[],"daemons":[],"commands":[],"bundle":{"schemaVersion":"1.0","kind":"extension_bundle","id":"ext_trading_mentor","version":"1.0.0","primitives":[{"schemaVersion":"1.0","kind":"canvas","id":"mentor_canvas","version":"1.0.0","permissions":[],"capabilityRequirements":[],"lifecycle":{},"layout":"CanvasMount","component":"./index.html","dynamicPage":false}]}}'} style={{ width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "monospace", fontSize: 11, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7, padding: 8 }} />
          {bundlePreview && <section aria-label="Extension package map" style={{ border: "1px solid var(--border)", borderRadius: 7, padding: 9, fontSize: 11.5 }}>
            <div style={{ fontWeight: 650, marginBottom: 5 }}>Package map{("id" in bundlePreview) ? ` · ${bundlePreview.id} v${bundlePreview.version}` : ""}</div>
            {"error" in bundlePreview ? <div role="status" style={{ color: "var(--text3)" }}>{bundlePreview.error}</div> : <>
              <div style={{ display: "grid", gap: 3 }}>{bundlePreview.primitives.map((part, index) => <div key={`${part.id}-${index}`}>Part <code>{part.id}</code> · {part.kind}{part.detail ? ` · ${part.detail}` : ""}</div>)}</div>
              {bundlePreview.roles.length > 0 && <div style={{ marginTop: 7 }}><strong>Worker bindings</strong>{bundlePreview.roles.map((role, index) => <div key={`${role.id}-${index}`} style={{ marginTop: 2 }}><code>{role.id}</code> · {role.principal} · {role.invocation} on {role.execution} · parts: {role.parts.join(", ") || "none"}{role.grants.length ? ` · declared operations: ${role.grants.join(", ")}` : ""}</div>)}</div>}
              {bundlePreview.connections.length > 0 && <div style={{ marginTop: 7 }}><strong>Host connections</strong>{bundlePreview.connections.map((item, index) => <div key={`${item}-${index}`}>{item}</div>)}</div>}
              {bundlePreview.knowledge.length > 0 && <div style={{ marginTop: 7 }}><strong>Knowledge grants</strong>{bundlePreview.knowledge.map((item, index) => <div key={`${item}-${index}`}>{item}</div>)}</div>}
              <div style={{ marginTop: 7, color: "var(--text3)" }}>All listed parts share this extension ID and release version. Each installation key creates a separate instance. This preview summarizes declarations; server validation remains authoritative.</div>
            </>}
          </section>}
          <label style={{ fontSize: 11.5, color: "var(--text2)" }} htmlFor="canvas-extension-artifacts">HTML artifacts as JSON path-to-source map</label>
          <textarea id="canvas-extension-artifacts" value={canvasArtifactsDraft} onChange={event => setCanvasArtifactsDraft(event.target.value)} rows={8} spellCheck={false} placeholder={'{"./index.html":"<main>...</main>"}'} style={{ width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "monospace", fontSize: 11, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7, padding: 8 }} />
          <label style={{ fontSize: 11.5, color: "var(--text2)" }} htmlFor="canvas-publisher-key">Publisher signing key
            <select id="canvas-publisher-key" value={canvasPublisherKeyId} onChange={event => { setCanvasPublisherKeyId(event.target.value); setCanvasPublisherSignature(""); }} required style={{ display: "block", width: "100%", marginTop: 4 }}>
              <option value="">Choose a trusted active key</option>
              {publisherKeys.filter(key => key.status === "active").map(key => <option key={key.key_id} value={key.key_id}>{key.publisher_id} · {key.key_id.slice(0, 12)}…</option>)}
            </select>
          </label>
          <label style={{ fontSize: 11.5, color: "var(--text2)" }} htmlFor="canvas-publisher-signature">Release signature (base64url)
            <input id="canvas-publisher-signature" value={canvasPublisherSignature} onChange={event => setCanvasPublisherSignature(event.target.value)} required placeholder="Sign the canonical manifest and original artifact map with @naelao/agent-sdk" />
          </label>
          <div style={{ fontSize: 10.5, color: "var(--text3)" }}>Create and retain your P-256 private key outside Naelao. Sign the host-canonical manifest and exact original path-to-source map, then paste the returned signature. Example: <code>const manifestJson = canonicalExtensionManifestForPublisher(manifest); const signed = await signExtensionPublisherRelease(signingInput); signed.signature</code>. These helpers are exported by <code>@naelao/agent-sdk</code>. Only the signature is sent to Naelao.</div>
          <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 11.5 }}><input type="checkbox" checked={canvasInstallConfirmed} onChange={event => setCanvasInstallConfirmed(event.target.checked)} />I reviewed the bundle declarations, every artifact, and each workflow toolNames grant. Gadgets are project-bound; external channel handlers cannot access planner/member tools or credentials.</label>
          <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 11.5 }}><input type="checkbox" checked={confirmUpgrade} onChange={event => setConfirmUpgrade(event.target.checked)} />Approve a forward version upgrade for this extension ID</label>
          <div><button type="submit" className="btn-ghost" disabled={installingExtension || !canvasManifestDraft.trim() || !canvasInstallConfirmed || !canvasPublisherKeyId || !canvasPublisherSignature.trim()}>{installingExtension ? "Installing…" : "Review and install Canvas bundle"}</button></div>
        </form>
      </details>}
      {projectId && canManage && otherProjectInstallations.length > 0 && <details style={{ marginBottom: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Manage Canvas, Gadget, and workflow-only extensions ({otherProjectInstallations.length})</summary>
        {otherProjectInstallations.map(item => {
          const instanceId = item.instance.instance_id;
          const extensionId = item.instance.extension_id;
          if (!instanceId || !extensionId) return null;
          return <div key={instanceId} style={{ padding: "8px 0", borderTop: "1px solid var(--border)", fontSize: 11.5 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>{extensionId} · {item.manifest.bundle?.version ?? "legacy"} · {item.instance.instance_key ?? "default"} · {item.instance.status === "active" ? "enabled" : item.instance.status === "staging" ? "setup incomplete" : "paused"}</span>
              <div style={{ display: "flex", gap: 5 }}>
              {item.instance.status !== "staging" && <button type="button" className="btn-ghost" style={{ fontSize: 11 }} disabled={!!changingExtension || !!removingExtension} onClick={() => void changeProjectExtensionLifecycle(instanceId, item.instance.status !== "active")}>
                {changingExtension === instanceId ? "Updating…" : item.instance.status === "active" ? "Pause" : "Resume"}
              </button>}
              <button type="button" className="btn-ghost" style={{ fontSize: 11 }} disabled={!!removingExtension} onClick={() => void uninstallChannelExtension(instanceId)}>
                {removingExtension === instanceId ? "Uninstalling…" : "Uninstall"}
              </button>
              </div>
            </div>
            {item.instance.status === "staging" && <div style={{ color: "var(--text3)", fontSize: 11 }}>Setup did not finish. This extension is not available to workers or channels; uninstall it or retry installation.</div>}
            {item.instance.status !== "staging" && item.manifest.bundle?.version && <ExtensionReleaseControls spaceId={spaceId} projectId={projectId} session={session} installation={{ extension_id: extensionId, version: item.manifest.bundle.version }} />}
          </div>;
        })}
      </details>}
      {CHANNELS.map((ch) => {
        const link = byId.get(ch.id);
        const connected = !!link;
        const on = !!link?.enabled;
        const boundInstallation = extensionInstallations.find((installation) => installation.instance_id === link?.extension_instance_id);
        const connectionRequirements = (boundInstallation && boundInstallation.status === "active" ? boundInstallation.connections ?? [] : []).filter((connection) => connection.required);
        const showing = open === ch.id;
        return (
          <div key={ch.id} className="settings-row" style={{ display: "block" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, color: "var(--text)" }}>{ch.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>
                  {connected ? (boundInstallation?.status === "disabled" ? "Connected; customer handler is paused" : on ? "Receiving messages" : "Connected but turned off") : ch.pitch}
                </div>
              </div>
              {canManage ? (
                <div style={{ display: "flex", gap: 8 }}>
                  {connected && (
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={busy}
                      onClick={() => void act(ch.id, on ? "disconnect" : "enable")}
                    >
                      {on ? "Turn off" : "Turn on"}
                    </button>
                  )}
                  {ch.pairable ? (
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={busy}
                      onClick={() => {
                        if (showing) {
                          setOpen(null);
                          setPairing(null);
                          setAdvanced(null);
                        } else {
                          void startPair(ch.id);
                        }
                      }}
                    >
                      {showing ? "Close" : connected ? "Add another" : "Connect"}
                    </button>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--text3)" }}>Automatic</span>
                  )}
                </div>
              ) : (
                <span style={{ fontSize: 12, color: "var(--text3)" }}>{on ? "On" : connected ? "Off" : "—"}</span>
              )}
            </div>
            {connected && canManage && <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
              <label htmlFor={`channel-model-${ch.id}`} style={{ fontSize: 11.5, color: "var(--text3)" }}>Reply model</label>
              <select id={`channel-model-${ch.id}`} aria-label={`${ch.name} reply model`} disabled={busy} value={link?.model_override ?? ""} onChange={(event) => void setChannelModel(ch.id, event.target.value)} style={{ maxWidth: 360, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7, padding: "6px 8px", fontSize: 12 }}>
                <option value="">Use Space default</option>
                {ALLOWED_MODELS.map((model) => <option key={model} value={model}>{modelLabel(model)}</option>)}
              </select>
            </div>}

            {connected && canManage && projectId && <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
              <label htmlFor={`channel-extension-${ch.id}`} style={{ fontSize: 11.5, color: "var(--text3)" }}>Customer handler</label>
              <select id={`channel-extension-${ch.id}`} aria-label={`${ch.name} customer channel handler`} disabled={busy} value={link?.extension_instance_id ?? ""} onChange={(event) => void bindExtension(ch.id, event.target.value)} style={{ maxWidth: 360, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7, padding: "6px 8px", fontSize: 12 }}>
                <option value="">No customer extension bound (hold for human review)</option>
                {extensionsLoading && <option disabled value="__loading">Loading handlers…</option>}
                {boundInstallation?.status === "disabled" && <option disabled value={boundInstallation.instance_id}>{boundInstallation.extension_id} · paused (resume before binding)</option>}
                {extensionInstallations.filter((installation) => installation.status === "active" && installation.channels.some((declaration) => declaration.provider === ch.id)).map((installation) => (
                  <option key={installation.instance_id} value={installation.instance_id}>{installation.extension_id} · {installation.scope === "PROJECT_SHARED" ? "shared" : "project"}</option>
                ))}
              </select>
            </div>}

            {connected && canManage && projectId && connectionRequirements.length > 0 && (
              <div role="status" aria-label="Required provider connections" style={{ marginTop: 8, fontSize: 11.5, color: "var(--text2)" }}>
                <span style={{ color: "var(--text3)" }}>Extension setup requirements: </span>
                {connectionRequirements.map((connection, index) => {
                  const configured = !!byId.get(connection.provider)?.enabled;
                  return <React.Fragment key={connection.id}>
                    {index > 0 ? "; " : ""}{connection.purpose} ({connection.provider}: {configured ? "configured" : "not configured"})
                  </React.Fragment>;
                })}
              </div>
            )}

            {showing && canManage && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                {busy && !pairing && (
                  <p style={{ fontSize: 12, color: "var(--text3)" }}>Getting your link ready…</p>
                )}

                {pairing && pairing.mode === "scan" && (
                  <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <QrCode value={pairing.pair_url} size={168} label={`Connect ${ch.name}`} />
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--text2)", lineHeight: 1.7 }}>
                        {pairing.steps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ol>
                      <a
                        href={pairing.pair_url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: "inline-block", marginTop: 10, fontSize: 12, color: "var(--accent)" }}
                      >
                        Open on this device instead →
                      </a>
                      <p style={{ fontSize: 11, color: "var(--text3)", marginTop: 8 }}>
                        This code works once, and expires in{" "}
                        {Math.round(pairing.expires_in_seconds / 60)} minutes.
                      </p>
                    </div>
                  </div>
                )}

                {pairing && pairing.mode === "redirect" && (
                  <p style={{ fontSize: 12, color: "var(--text2)" }}>
                    Taking you to {ch.name} to choose where the assistant should live…
                  </p>
                )}

                {/* The old flow, kept for a business that wants its own branded bot — or a
                    workspace Naelao's app isn't installed in. Collapsed, because for almost
                    everyone the answer above is the right one. */}
                <div style={{ marginTop: 14 }}>
                  {advanced !== ch.id ? (
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ fontSize: 11.5, padding: 0 }}
                      onClick={() => setAdvanced(ch.id)}
                    >
                      Set up your own {ch.name} app instead
                    </button>
                  ) : (
                    <div style={{ paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                      <label style={{ fontSize: 11.5, color: "var(--text2)", display: "block", marginBottom: 4 }}>
                        {ch.secretLabel}
                      </label>
                      <input
                        type="password"
                        className="search-bar"
                        style={{ width: "100%" }}
                        value={secret}
                        placeholder={`Paste your ${ch.secretLabel.toLowerCase()}`}
                        onChange={(e) => setSecret(e.target.value)}
                        autoComplete="off"
                      />
                      <p style={{ fontSize: 11, color: "var(--text3)", margin: "6px 0 10px", lineHeight: 1.5 }}>
                        Find it in {ch.where}. It is encrypted and stored in the credential vault — the assistant
                        never sees it.
                      </p>
                      {ch.id === "whatsapp" && (
                        <>
                          <div style={{ padding: "10px 0", marginBottom: 8, borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
                            <strong style={{ fontSize: 12 }}>Optional: send directly through Meta</strong>
                            <p style={{ fontSize: 11, color: "var(--text3)", margin: "5px 0 8px", lineHeight: 1.5 }}>
                              The simple paired setup uses Naelao’s configured Twilio sender when available. To send from your own WhatsApp Business number without Twilio, add the Meta phone-number ID and a token with WhatsApp messaging access. Meta may charge message fees; this is an advanced setup.
                            </p>
                            <label style={{ fontSize: 11.5, color: "var(--text2)", display: "block", marginBottom: 4 }}>Meta WhatsApp Business phone-number ID</label>
                            <input className="search-bar" style={{ width: "100%" }} value={whatsappPhoneNumberId} placeholder="Numeric phone-number ID" onChange={(e) => setWhatsappPhoneNumberId(e.target.value)} autoComplete="off" />
                            <label style={{ fontSize: 11.5, color: "var(--text2)", display: "block", margin: "8px 0 4px" }}>Meta WhatsApp Cloud API access token</label>
                            <input type="password" className="search-bar" style={{ width: "100%" }} value={whatsappAccessToken} placeholder="System-user or other supported access token" onChange={(e) => setWhatsappAccessToken(e.target.value)} autoComplete="new-password" />
                          </div>
                          <label style={{ fontSize: 11.5, color: "var(--text2)", display: "block", marginBottom: 4 }}>
                            WhatsApp Cloud API Access Token (for voice notes)
                          </label>
                          <input
                            type="password"
                            className="search-bar"
                            style={{ width: "100%" }}
                            value={mediaAccessToken}
                            placeholder="Optional bearer token from Meta"
                            onChange={(e) => setMediaAccessToken(e.target.value)}
                            autoComplete="off"
                          />
                          <p style={{ fontSize: 11, color: "var(--text3)", margin: "6px 0 10px", lineHeight: 1.5 }}>
                            Needed only to download voice-note media. It is stored encrypted and never sent to the agent.
                          </p>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={busy || secret.trim().length === 0}
                        onClick={() => void act(ch.id, "connect")}
                      >
                        {busy ? "Connecting…" : "Connect"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {webhookUrl?.channel === ch.id && (
              <div style={{ marginTop: 10, padding: 10, background: "var(--bg2)", borderRadius: 8 }}>
                <div style={{ fontSize: 11.5, color: "var(--text2)", marginBottom: 6 }}>
                  One more step — paste this webhook URL into {ch.name}, or nothing will arrive:
                </div>
                <code style={{ fontSize: 11, wordBreak: "break-all", color: "var(--text)" }}>{webhookUrl.url}</code>
              </div>
            )}
          </div>
        );
      })}
      {error && <p style={{ fontSize: 12, color: "var(--danger, #d33)", marginTop: 8 }}>{error}</p>}
      {!canManage && (
        <p style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 10 }}>
          Only an owner or admin of this business can connect a channel.
        </p>
      )}
    </div>
  );
}
