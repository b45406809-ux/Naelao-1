"use client";

export const runtime = "edge";

// The agent library for whichever space is currently active.
//
// Two things were wrong here before: it listed `product.space_id` — the product ROOT — so someone
// inside a business saw a different space's agents (or none), and it declared configuring an agent
// "a builder capability", which stopped being true once the per-agent policy routes gained a
// business-membership floor. Each card now opens that agent's own settings page.

import * as React from "react";
import Link from "next/link";
import { Card, CardTitle, CardDesc } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { listAgentDefinitions, type AgentDefinitionSummary } from "@/lib/api";

export default function AgentsPage() {
  const product = useProduct();
  const { session } = useProductAuth();
  const { activeSpaceId, activeSpaceName, isBusinessSpace } = useActiveSpace();
  const [agents, setAgents] = React.useState<AgentDefinitionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    listAgentDefinitions(activeSpaceId, { sessionToken: session.session_token, endUserId: session.end_user_id })
      .then((a) => { if (!cancelled) setAgents(a); })
      // A load failure must never render as "you have no agents" — that reads as a fact about the
      // business rather than a fact about this request.
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeSpaceId, session]);

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Agents</div>
        <div className="page-subtitle">
          The specialists working in {isBusinessSpace && activeSpaceName ? activeSpaceName : product.product_name},
          alongside your assistant. Open one to set what it may do on its own.
        </div>
      </div>

      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : failed ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          Couldn&apos;t load the agent list just now.{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.location.reload()}>
            Try again
          </button>
        </p>
      ) : agents.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          No specialist agents here yet. They arrive with the templates you add to a business — your assistant works on
          its own until then.
        </p>
      ) : (
        <div className="grid-3">
          {agents.map((a) => (
            <Link key={a.id} href={`/p/${product.slug}/agents/${encodeURIComponent(a.id)}`} style={{ textDecoration: "none" }}>
              <Card>
                <CardTitle>{a.name ?? a.id}</CardTitle>
                {a.description && <CardDesc>{a.description}</CardDesc>}
                <div style={{ marginTop: 10, fontSize: 12, color: "var(--accent)" }}>Configure →</div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
