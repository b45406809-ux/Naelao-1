"use client";


// Approvals — the things your agents are waiting on you for.
//
// A gated action opens a request and does NOT run: the agent parks it, carries on with the rest
// of the task, and picks that action back up the moment it's answered. Until this page existed
// there was no way to answer one from the product, so every parked action simply sat there until
// it expired — the whole feature was real end to end except the one step that needs a person.

import * as React from "react";
import { Button, Badge, Card, CardTitle, CardDesc, useToast, Toast } from "@naelao/ui";
import { useProductAuth } from "@/lib/auth-provider";
import { useProduct } from "@/lib/product-context";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  listAllApprovals,
  listMySpaces,
  approveAction,
  rejectAction,
  type PendingApprovalWithSpace,
} from "@/lib/api";

/** Arguments are shown, not hidden behind a name: approving "commerce.payout" without seeing the
 *  amount and destination is not an informed decision. */
function readableParams(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed);
    if (entries.length === 0) return "";
    return entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
  } catch {
    return raw;
  }
}

function timeLeft(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h left`;
  const mins = Math.max(1, Math.floor(ms / 60_000));
  return `${mins}m left`;
}

export default function ApprovalsPage() {
  const { session } = useProductAuth();
  const product = useProduct();
  // Kept for "jump to this space" on an item card — no longer used to SCOPE the list itself.
  // See listAllApprovals's own header: an approval is per-space, and only checking whichever
  // one happens to be active is the exact bug this page exists to not have.
  const { setActiveSpace } = useActiveSpace();
  const { toast, show } = useToast();
  const [items, setItems] = React.useState<PendingApprovalWithSpace[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      const spaces = await listMySpaces(product.space_id, creds);
      setItems(await listAllApprovals(product.space_id, product.product_name, spaces, creds));
      setFailed(false);
    } catch {
      // Distinct from "nothing pending" — telling someone there's nothing to approve when the
      // list simply failed to load is how a payout quietly never happens.
      setFailed(true);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.space_id, product.product_name, session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function decide(approval: PendingApprovalWithSpace, approve: boolean) {
    if (!creds) return;
    setBusyId(approval.id);
    try {
      // The approval's OWN space, not whatever happens to be active in the switcher right now
      // — see listAllApprovals's header for why that distinction is the whole point of this page.
      if (approve) await approveAction(approval.space_id, approval.id, creds);
      else await rejectAction(approval.space_id, approval.id, "Declined by the owner", creds);
      show(approve ? "Approved — the agent is picking it back up now." : "Declined.");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't record that");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Approvals</div>
        <div className="page-subtitle">
          Actions your agents have paused on until you say yes. Nothing here has run.
        </div>
      </div>

      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : failed ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
          <span style={{ color: "#dc2626" }} role="alert">
            Couldn&rsquo;t load your approvals — this is a loading problem, not an empty list.
          </span>
          <Button variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          Nothing waiting on you. Your agents will ask here before doing anything that spends money
          or touches the outside world.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {items.map((a) => {
            const params = readableParams(a.tool_input);
            return (
              <Card key={a.id}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <button
                      type="button"
                      onClick={() => setActiveSpace(a.space_id, a.space_name)}
                      style={{
                        border: "none", background: "none", padding: 0, cursor: "pointer",
                        fontSize: 11, letterSpacing: "0.03em", textTransform: "uppercase",
                        color: "var(--accent)", marginBottom: 4, display: "block",
                      }}
                      title="Switch to this space"
                    >
                      {a.space_name}
                    </button>
                    <CardTitle>{a.tool_name}</CardTitle>
                    <CardDesc>{a.action_description}</CardDesc>
                  </div>
                  <Badge color="amber">{timeLeft(a.expires_at)}</Badge>
                </div>

                {params && (
                  <pre
                    style={{
                      marginTop: 10,
                      padding: "10px 12px",
                      borderRadius: 8,
                      background: "var(--surface2, #f6f7f9)",
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 180,
                      overflowY: "auto",
                    }}
                  >
                    {params}
                  </pre>
                )}

                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <Button onClick={() => void decide(a, true)} disabled={busyId === a.id}>
                    {busyId === a.id ? "Saving…" : "Approve"}
                  </Button>
                  <Button variant="secondary" onClick={() => void decide(a, false)} disabled={busyId === a.id}>
                    Decline
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <Toast toast={toast} />
    </div>
  );
}
