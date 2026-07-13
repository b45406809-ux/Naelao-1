"use client";

export const runtime = "edge";

import * as React from "react";
import { Card, CardTitle, CardDesc } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { listAgentDefinitions, type AgentDefinitionSummary } from "@/lib/api";

export default function AgentsPage() {
  const product = useProduct();
  const { session } = useProductAuth();
  const [agents, setAgents] = React.useState<AgentDefinitionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!session) return;
    void listAgentDefinitions(product.space_id, { sessionToken: session.session_token, endUserId: session.end_user_id })
      .then(setAgents)
      .catch(() => {})
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.space_id, session]);

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Agents</div>
        <div className="page-subtitle">Read-only library — configuring agents is a builder capability.</div>
      </div>
      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : agents.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>No agents configured for this business yet.</p>
      ) : (
        <div className="grid-3">
          {agents.map((a) => (
            <Card key={a.id} interactive={false}>
              <CardTitle>{a.name ?? a.id}</CardTitle>
              {a.description && <CardDesc>{a.description}</CardDesc>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
