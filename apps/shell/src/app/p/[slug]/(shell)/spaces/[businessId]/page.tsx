"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Button, Badge, Modal, FormInput, FormSelect, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import {
  listBusinessMembers,
  removeBusinessMember,
  inviteToBusiness,
  listMyBusinesses,
  type BusinessMember,
  type Business,
} from "@/lib/api";

export default function BusinessDetailPage() {
  const params = useParams<{ businessId: string }>();
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

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      const [mine, mem] = await Promise.all([
        listMyBusinesses(product.space_id, creds),
        listBusinessMembers(params.businessId, creds),
      ]);
      setBusiness(mine.find((b) => b.id === params.businessId) ?? null);
      setMembers(mem);
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
