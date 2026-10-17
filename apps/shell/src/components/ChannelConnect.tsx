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
import type { ChannelExtensionInstallation, ChannelLink, ChannelPairing, SessionCredentials } from "@/lib/api";
import { updateAssistantChannel, pairAssistantChannel, listChannelExtensionInstallations } from "@/lib/api";
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
  const [extensionLoadError, setExtensionLoadError] = React.useState<string | null>(null);
  const [extensionsLoading, setExtensionsLoading] = React.useState(false);

  React.useEffect(() => {
    if (!projectId || !canManage) { setExtensionInstallations([]); setExtensionLoadError(null); setExtensionsLoading(false); return; }
    let cancelled = false;
    setExtensionsLoading(true);
    setExtensionLoadError(null);
    listChannelExtensionInstallations(spaceId, projectId, session)
      .then((items) => { if (!cancelled) setExtensionInstallations(items); })
      .catch((err) => { if (!cancelled) { setExtensionInstallations([]); setExtensionLoadError(err instanceof Error ? err.message : "Couldn't load project channel handlers."); } })
      .finally(() => { if (!cancelled) setExtensionsLoading(false); });
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

  return (
    <div>
      {extensionLoadError && <div role="alert" style={{ marginBottom: 10, color: "var(--danger, #b42318)", fontSize: 12 }}>{extensionLoadError}</div>}
      {CHANNELS.map((ch) => {
        const link = byId.get(ch.id);
        const connected = !!link;
        const on = !!link?.enabled;
        const boundInstallation = extensionInstallations.find((installation) => installation.instance_id === link?.extension_instance_id);
        const connectionRequirements = (boundInstallation?.connections ?? []).filter((connection) => connection.required);
        const showing = open === ch.id;
        return (
          <div key={ch.id} className="settings-row" style={{ display: "block" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, color: "var(--text)" }}>{ch.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>
                  {connected ? (on ? "Receiving messages" : "Connected but turned off") : ch.pitch}
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
                {extensionInstallations.filter((installation) => installation.channels.some((declaration) => declaration.provider === ch.id)).map((installation) => (
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
