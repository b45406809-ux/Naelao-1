"use client";

/**
 * Connecting a channel, from the Channels panel.
 *
 * The panel used to list connected channels and offer no way to add one — the only connect route
 * was builder-only, so a business owner could see the section and never use it.
 *
 * Two things this deliberately does NOT hide: the signing secret has to come from the provider's
 * own dashboard (there is no OAuth for these — they are webhook signatures), and connecting on our
 * side is only half of it. The webhook URL has to go back into the provider before a single message
 * arrives, so it is shown prominently after connecting rather than buried in a docs link.
 */

import * as React from "react";
import type { ChannelLink, SessionCredentials } from "@/lib/api";
import { updateAssistantChannel } from "@/lib/api";

type ChannelId = "telegram" | "slack" | "discord" | "whatsapp" | "email";

const CHANNELS: Array<{
  id: ChannelId;
  name: string;
  /** What the owner is actually looking for, in the provider's own words. */
  secretLabel: string;
  where: string;
}> = [
  {
    // First on purpose: free, no business verification, no per-message billing and no 24-hour
    // reply window — the easiest channel for a business with no budget to actually start on.
    id: "telegram",
    name: "Telegram",
    secretLabel: "Webhook Secret Token",
    where: "a token you choose yourself, then pass as secret_token when you call Telegram's setWebhook",
  },
  {
    id: "slack",
    name: "Slack",
    secretLabel: "Signing Secret",
    where: "Slack app → Basic Information → App Credentials → Signing Secret",
  },
  {
    id: "discord",
    name: "Discord",
    secretLabel: "Public Key",
    where: "Discord Developer Portal → your app → General Information → Public Key",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    secretLabel: "App Secret",
    where: "Meta for Developers → your app → Settings → Basic → App Secret",
  },
  {
    id: "email",
    name: "Email",
    secretLabel: "Webhook Signing Key",
    where: "Your inbound email provider's webhook settings (e.g. Mailgun signing key)",
  },
];

export function ChannelConnect({
  spaceId,
  session,
  channels,
  canManage,
  onChanged,
}: {
  spaceId: string;
  session: SessionCredentials;
  channels: ChannelLink[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = React.useState<ChannelId | null>(null);
  const [secret, setSecret] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = React.useState<{ channel: string; url: string } | null>(null);

  const byId = new Map(channels.map((c) => [c.channel, c]));

  async function act(channel: ChannelId, action: "connect" | "disconnect" | "enable") {
    setBusy(true);
    setError(null);
    try {
      const res = await updateAssistantChannel(spaceId, session, {
        action,
        channel,
        ...(action === "connect" ? { secret } : {}),
      });
      if (action === "connect") {
        setSecret("");
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

  return (
    <div>
      {CHANNELS.map((ch) => {
        const link = byId.get(ch.id);
        const connected = !!link;
        const on = !!link?.enabled;
        return (
          <div key={ch.id} className="settings-row" style={{ display: "block" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, color: "var(--text)" }}>{ch.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>
                  {connected ? (on ? "Receiving messages" : "Connected but turned off") : "Not connected"}
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
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() => {
                      setOpen(open === ch.id ? null : ch.id);
                      setSecret("");
                      setError(null);
                    }}
                  >
                    {connected ? "Replace key" : "Connect"}
                  </button>
                </div>
              ) : (
                <span style={{ fontSize: 12, color: "var(--text3)" }}>{on ? "On" : connected ? "Off" : "—"}</span>
              )}
            </div>

            {open === ch.id && canManage && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
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
                  Find it in {ch.where}. It is encrypted and stored in the credential vault — the assistant never
                  sees it.
                </p>
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
