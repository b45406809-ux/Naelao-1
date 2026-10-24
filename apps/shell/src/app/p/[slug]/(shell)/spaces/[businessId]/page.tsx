"use client";


import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, Badge, Modal, FormInput, FormSelect, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import {
  listBusinessMembers,
  removeBusinessMember,
  inviteToBusiness,
  listMyBusinesses,
  listLocalGrants,
  createLocalGrant,
  deleteLocalGrant,
  mintLocalTunnelConnectToken,
  getConnectorStatus,
  connectPlatform,
  startOAuthConnect,
  startProviderConnect,
  type BusinessMember,
  type Business,
  type LocalGrant,
  getOnboarding,
  type OnboardingState,
  type ConnectorInfo,
} from "@/lib/api";

const GRANT_TYPES = ["read", "write", "readwrite", "exec"] as const;

export default function BusinessDetailPage() {
  const params = useParams<{ slug: string; businessId: string }>();
  const router = useRouter();
  const product = useProduct();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const [business, setBusiness] = React.useState<Business | null>(null);
  const [members, setMembers] = React.useState<BusinessMember[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<"member" | "admin">("member");
  const [inviting, setInviting] = React.useState(false);
  const [lastInviteToken, setLastInviteToken] = React.useState<string | null>(null);
  const [localGrants, setLocalGrants] = React.useState<LocalGrant[]>([]);
  const [grantType, setGrantType] = React.useState<(typeof GRANT_TYPES)[number]>("read");
  const [grantDirectory, setGrantDirectory] = React.useState("");
  const [grantCommands, setGrantCommands] = React.useState("");
  const [creatingGrant, setCreatingGrant] = React.useState(false);
  const [connectInfo, setConnectInfo] = React.useState<{ token: string; connect_path: string; expires_in_seconds: number } | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const [connectors, setConnectors] = React.useState<ConnectorInfo[]>([]);
  const [onboarding, setOnboarding] = React.useState<OnboardingState | null>(null);
  // Growth-layer "Connect Apps" panel: all available connectors use the same provider-aware
  // connection flow. manualKeyOpenFor tracks which connector's inline
  // key-paste form is open; dismissedApps is a client-only "skip for now" per the onboarding ask
  // ("or can skip and do later") — not persisted server-side, just this browser.
  const [appBusy, setAppBusy] = React.useState<string | null>(null);
  const [manualKeyOpenFor, setManualKeyOpenFor] = React.useState<string | null>(null);
  const [manualKeyValue, setManualKeyValue] = React.useState("");
  const [dismissedApps, setDismissedApps] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`naelao:dismissed-connectors:${params.businessId}`);
      if (raw) setDismissedApps(new Set(JSON.parse(raw) as string[]));
    } catch { /* best-effort */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismissApp(id: string) {
    const next = new Set(dismissedApps);
    next.add(id);
    setDismissedApps(next);
    try {
      window.localStorage.setItem(`naelao:dismissed-connectors:${params.businessId}`, JSON.stringify([...next]));
    } catch { /* best-effort */ }
  }

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      const [mine, mem, grants, conns, onboard] = await Promise.all([
        listMyBusinesses(product.space_id, creds),
        listBusinessMembers(params.businessId, creds),
        listLocalGrants(params.businessId, creds).catch(() => []),
        getConnectorStatus(params.businessId, creds).catch(() => []),
        // Member-level read; a 403 here just means the caller lost membership mid-load.
        getOnboarding(params.businessId, creds).catch(() => null),
      ]);
      setBusiness(mine.find((b) => b.id === params.businessId) ?? null);
      setMembers(mem);
      setLocalGrants(grants);
      setConnectors(conns);
      setOnboarding(onboard);
    } catch {
      show("Couldn't load this business — you may not be a member");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.space_id, params.businessId, session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!creds || !inviteEmail.trim()) return;
    setInviting(true);
    try {
      const result = await inviteToBusiness(params.businessId, creds, { email: inviteEmail.trim(), role: inviteRole });
      setLastInviteToken(result.token);
      setInviteEmail("");
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setInviting(false);
    }
  }

  async function handleRemove(endUserId: string) {
    if (!creds) return;
    try {
      await removeBusinessMember(params.businessId, endUserId, creds);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to remove member");
    }
  }

  async function handleCreateGrant() {
    if (!creds) return;
    setCreatingGrant(true);
    try {
      if (grantType === "exec") {
        const list = grantCommands.split("\n").map((c) => c.trim()).filter(Boolean);
        if (list.length === 0) throw new Error("Enter at least one exact command");
        const created = await createLocalGrant(params.businessId, creds, { grant_type: "exec", commands: list });
        setLocalGrants((prev) => [...prev, created]);
      } else {
        if (!grantDirectory.trim()) throw new Error("Enter a directory");
        const created = await createLocalGrant(params.businessId, creds, { grant_type: grantType, directory: grantDirectory.trim() });
        setLocalGrants((prev) => [...prev, created]);
      }
      setGrantDirectory("");
      setGrantCommands("");
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to add grant");
    } finally {
      setCreatingGrant(false);
    }
  }

  async function handleDeleteGrant(grantId: string) {
    if (!creds) return;
    try {
      await deleteLocalGrant(params.businessId, grantId, creds);
      setLocalGrants((prev) => prev.filter((g) => g.id !== grantId));
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to revoke grant");
    }
  }

  async function handleConnectLocalMachine() {
    if (!creds) return;
    setConnecting(true);
    try {
      setConnectInfo(await mintLocalTunnelConnectToken(params.businessId, creds));
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to mint a connect token");
    } finally {
      setConnecting(false);
    }
  }

  // Growth-layer "click Install" connect (G-1/G-3): branches on how the connector reaches the
  // real app — a Composio-hosted redirect, a provider OAuth redirect, or the inline manual-key
  // form (opened via setManualKeyOpenFor).
  async function handleConnectApp(connector: ConnectorInfo) {
    if (!creds) return;
    if (connector.composio) {
      setAppBusy(connector.id);
      try {
        const { connect_url } = await startProviderConnect(params.businessId, creds, connector.id, window.location.href);
        window.location.href = connect_url;
      } catch (err) {
        show(err instanceof Error ? err.message : `Failed to start the ${connector.name} connection`);
        setAppBusy(null);
      }
      return;
    }
    if (connector.oauth) {
      setAppBusy(connector.id);
      try {
        const { authorize_url } = await startOAuthConnect(params.businessId, creds, connector.id, window.location.href);
        window.location.href = authorize_url;
      } catch (err) {
        show(err instanceof Error ? err.message : `Failed to start the ${connector.name} connection`);
        setAppBusy(null);
      }
      return;
    }
    setManualKeyOpenFor(connector.id);
    setManualKeyValue("");
  }

  async function handleManualAppConnect(platform: string) {
    if (!creds || !manualKeyValue.trim()) return;
    setAppBusy(platform);
    try {
      await connectPlatform(params.businessId, creds, platform, manualKeyValue.trim());
      setManualKeyOpenFor(null);
      setManualKeyValue("");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setAppBusy(null);
    }
  }

  // Handle return markers from generic connector OAuth/Composio flows.
  React.useEffect(() => {
    const params2 = new URLSearchParams(window.location.search);
    let touched = false;
    for (const c of connectors) {
      const connectedKey = `${c.id}_connected`;
      const errorKey = `${c.id}_oauth_error`;
      if (params2.get(connectedKey)) { show(`${c.name} connected.`); params2.delete(connectedKey); touched = true; }
      if (params2.get(errorKey)) { show(`${c.name} connection failed: ${params2.get(errorKey)}`); params2.delete(errorKey); touched = true; }
    }
    if (touched) {
      const clean = `${window.location.pathname}${params2.toString() ? `?${params2}` : ""}`;
      window.history.replaceState({}, "", clean);
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectors.length]);

  const myRole = business?.role;
  const canManage = myRole === "owner" || myRole === "admin";

  if (loading) return <div className="page-view">Loading…</div>;
  if (!business) return <div className="page-view">You don&rsquo;t have access to this business.</div>;

  return (
    <div className="page-view">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="page-title">{business.name}</div>
          <div className="page-subtitle">
            <Badge color={business.space_status === "active" ? "green" : "amber"}>{business.space_status}</Badge>{" "}
            Your role: {business.role}
          </div>
        </div>
        {canManage && <Button onClick={() => setInviteOpen(true)}>Invite</Button>}
      </div>

      {/* Setup that was started but never finished is the difference between a business that
          exists and one that actually runs: until it completes, the assistant has no account to
          read and no way to reach its owner. Prominent and persistent, not a dismissible nudge. */}
      {onboarding && onboarding.status !== "complete" && onboarding.prompts.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            padding: "14px 16px",
            marginBottom: 18,
            borderRadius: 10,
            background: "var(--accent-soft, #eef2ff)",
            border: "1px solid var(--accent, #5b52f0)",
            fontSize: 13,
          }}
        >
          <span>
            <strong>Finish setting up {business.name}.</strong>{" "}
            {onboarding.prompts.filter((p) => !p.satisfied).length} step
            {onboarding.prompts.filter((p) => !p.satisfied).length === 1 ? "" : "s"} left — your
            assistant can&rsquo;t start running this business until it&rsquo;s done.
          </span>
          <Button onClick={() => router.push(`/p/${params.slug}/spaces/${params.businessId}/onboarding`)}>
            Finish setup
          </Button>
        </div>
      )}

      <div className="section-label">Members</div>
      <div className="settings-block">
        {members.map((m) => (
          <div className="settings-row" key={m.end_user_id}>
            <div>
              <div className="settings-row-label">{m.end_user_id}</div>
              <div className="settings-row-sub">
                {m.role} · joined {new Date(m.joined_at).toLocaleDateString()}
              </div>
            </div>
            {canManage && m.role !== "owner" && (
              <button className="btn btn-secondary" type="button" onClick={() => handleRemove(m.end_user_id)}>
                Remove
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="section-label">My Local Machine</div>
      <p style={{ fontSize: 12, color: "var(--text3)", marginBottom: 8 }}>
        Let this business&rsquo;s agents read/write files or run exact commands on YOUR OWN
        machine. No access is granted by default — you see only your own grants here.
      </p>
      <div className="settings-block">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Connection</div>
            <div className="settings-row-sub">Mint a connect token, then run the Naelao Local Agent with it.</div>
          </div>
          <Button onClick={handleConnectLocalMachine} disabled={connecting}>
            {connecting ? "Minting…" : "Connect"}
          </Button>
        </div>
        {connectInfo && (
          <div style={{ padding: "0 12px 12px" }}>
            <code style={{ fontSize: 11, wordBreak: "break-all", display: "block", padding: 10, background: "var(--bg2)", borderRadius: 8 }}>
              node naelao-local-agent.mjs --token {connectInfo.token} --path {connectInfo.connect_path}
            </code>
            <div className="settings-row-sub" style={{ marginTop: 4 }}>Expires in {connectInfo.expires_in_seconds}s.</div>
          </div>
        )}
        {localGrants.length === 0 && <div className="settings-row-sub" style={{ padding: 12 }}>No grants yet.</div>}
        {localGrants.map((g) => (
          <div className="settings-row" key={g.id}>
            <div>
              <Badge color="blue">{g.grant_type}</Badge>{" "}
              <span className="settings-row-label">{g.grant_type === "exec" ? g.commands.join(", ") : g.directory}</span>
              <div className="settings-row-sub">Added {new Date(g.created_at).toLocaleDateString()}</div>
            </div>
            <button className="btn btn-secondary" type="button" onClick={() => handleDeleteGrant(g.id)}>
              Revoke
            </button>
          </div>
        ))}
      </div>
      {canManage && (
        <form
          onSubmit={(e) => { e.preventDefault(); void handleCreateGrant(); }}
          style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap", alignItems: "flex-end" }}
        >
          <FormSelect value={grantType} onChange={(e) => setGrantType(e.target.value as (typeof GRANT_TYPES)[number])} style={{ maxWidth: 140 }}>
            {GRANT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </FormSelect>
          {grantType === "exec" ? (
            <FormInput placeholder="npm test" value={grantCommands} onChange={(e) => setGrantCommands(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          ) : (
            <FormInput placeholder="/Users/you/projects/my-repo" value={grantDirectory} onChange={(e) => setGrantDirectory(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          )}
          <Button type="submit" disabled={creatingGrant}>
            {creatingGrant ? "Adding…" : "Add grant"}
          </Button>
        </form>
      )}

      {/* Growth-layer "Connect Apps" (G-1/G-3): a real click-to-install experience, same idea as
          adding a connector in Claude or ChatGPT — connected apps are managed through MCP connectors. Choose only the apps this space needs;
          "Skip for now" is a client-only dismissal (this ask explicitly allows skipping) — the
          panel disappears once every recommended app is either connected or dismissed. */}
      {canManage && (() => {
        const appConnectors = connectors.filter((c) => c.status === "available");
        const visible = appConnectors.filter((c) => !c.connected && !dismissedApps.has(c.id));
        if (appConnectors.length === 0 || visible.length === 0) return null;
        return (
          <>
            <div className="section-label">Connect Apps</div>
            <p style={{ fontSize: 12, color: "var(--text3)", marginBottom: 8 }}>
              Connect real apps so the assistant can actually post, generate, and sync on this
              business&rsquo;s behalf — no API keys to hunt down for most of these, just click
              Connect and sign in. Skip any of these for now; the assistant will ask again when it
              actually needs one.
            </p>
            <div className="settings-block">
              {visible.map((c) => (
                <React.Fragment key={c.id}>
                  <div className="settings-row">
                    <div>
                      <div className="settings-row-label">{c.name}</div>
                      <div className="settings-row-sub">{c.summary}</div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {manualKeyOpenFor !== c.id && (
                        <>
                          <Button onClick={() => handleConnectApp(c)} disabled={appBusy === c.id}>
                            {appBusy === c.id ? "Connecting…" : "Connect"}
                          </Button>
                          <button
                            className="btn btn-secondary"
                            type="button"
                            onClick={() => dismissApp(c.id)}
                            disabled={appBusy === c.id}
                            style={{ fontSize: 12 }}
                          >
                            Skip for now
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {manualKeyOpenFor === c.id && (
                    <div style={{ padding: "0 12px 12px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                      <FormInput
                        type="password"
                        placeholder={`${c.name} API key`}
                        value={manualKeyValue}
                        onChange={(e) => setManualKeyValue(e.target.value)}
                        style={{ flex: 1, minWidth: 220 }}
                      />
                      <Button onClick={() => handleManualAppConnect(c.id)} disabled={appBusy === c.id || !manualKeyValue.trim()}>
                        {appBusy === c.id ? "Connecting…" : "Connect"}
                      </Button>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => { setManualKeyOpenFor(null); setManualKeyValue(""); }}
                        disabled={appBusy === c.id}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
          </>
        );
      })()}

      {/* My Connections (§A1.18 connector scope model) — personal connectors, distinct from the
          shared "Connect Apps" above: connecting one is YOUR own account, never visible to or
          usable by another member (like connecting your own Gmail/Slack identity in Claude or
          ChatGPT, vs. an admin installing a workspace-wide integration). Any member can connect
          their own, no admin needed. Nothing in the catalogue is scope_model='user' yet — see
          catalogue.ts's own header — so this section simply doesn't render until one exists; the
          mechanism (backend storage/resolution + this UI) is real and ready for when one does. */}
      {(() => {
        const personal = connectors.filter((c) => c.scope_model === "user" && c.status === "available");
        if (personal.length === 0) return null;
        return (
          <>
            <div className="section-label">My Connections</div>
            <p style={{ fontSize: 12, color: "var(--text3)", marginBottom: 8 }}>
              Your own personal accounts — connecting one only affects your agent conversations,
              never anyone else on this business.
            </p>
            <div className="settings-block">
              {personal.map((c) => (
                <React.Fragment key={c.id}>
                  <div className="settings-row">
                    <div>
                      <div className="settings-row-label">{c.name}</div>
                      <div className="settings-row-sub">{c.summary}</div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {c.connected ? (
                        <Badge color="green">Connected</Badge>
                      ) : manualKeyOpenFor !== c.id ? (
                        <Button onClick={() => handleConnectApp(c)} disabled={appBusy === c.id}>
                          {appBusy === c.id ? "Connecting…" : "Connect"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {manualKeyOpenFor === c.id && (
                    <div style={{ padding: "0 12px 12px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                      <FormInput
                        type="password"
                        placeholder={`Your ${c.name} API key`}
                        value={manualKeyValue}
                        onChange={(e) => setManualKeyValue(e.target.value)}
                        style={{ flex: 1, minWidth: 220 }}
                      />
                      <Button onClick={() => handleManualAppConnect(c.id)} disabled={appBusy === c.id || !manualKeyValue.trim()}>
                        {appBusy === c.id ? "Connecting…" : "Connect"}
                      </Button>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => { setManualKeyOpenFor(null); setManualKeyValue(""); }}
                        disabled={appBusy === c.id}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
          </>
        );
      })()}

      <Modal
        open={inviteOpen}
        onClose={() => {
          setInviteOpen(false);
          setLastInviteToken(null);
        }}
        title="Invite a collaborator"
        footer={
          <>
            <Button variant="secondary" type="button" onClick={() => setInviteOpen(false)}>
              Close
            </Button>
            {!lastInviteToken && (
              <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
                {inviting ? "Sending…" : "Send Invite"}
              </Button>
            )}
          </>
        }
      >
        {lastInviteToken ? (
          <div>
            <p style={{ fontSize: 13, color: "var(--text2)", marginBottom: 8 }}>
              Invite created. Share this link with the invitee (shown once — it isn&rsquo;t stored anywhere retrievable):
            </p>
            <code style={{ fontSize: 12, wordBreak: "break-all", display: "block", padding: 10, background: "var(--bg2)", borderRadius: 8 }}>
              /p/{product.slug}/spaces/{params.businessId}/accept-invite/{lastInviteToken}
            </code>
          </div>
        ) : (
          <form onSubmit={handleInvite} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FormInput type="email" placeholder="email@example.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required autoFocus />
            <FormSelect value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </FormSelect>
          </form>
        )}
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}
