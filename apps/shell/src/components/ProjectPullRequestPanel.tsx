"use client";

import * as React from "react";
import { listPullRequestCards, type SessionCredentials, type PullRequestCard } from "@/lib/api";
import { InlinePullRequestCard } from "./InlinePullRequestCard";

export function ProjectPullRequestPanel({ spaceId, projectId, session }: { spaceId: string; projectId: string; session?: SessionCredentials }) {
  const [cards, setCards] = React.useState<PullRequestCard[]>([]);
  const [error, setError] = React.useState("");
  const refresh = React.useCallback(async () => {
    try { setCards(await listPullRequestCards(spaceId, projectId, session)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Reviews could not be loaded"); }
  }, [spaceId, projectId, session]);
  React.useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  if (cards.length === 0 && !error) return null;
  return <aside aria-label="Project pull request reviews" style={{ margin: "8px 0 16px", padding: "0 8px" }}>
    <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.8 }}>Project reviews</div>
    {error && <div role="alert" style={{ color: "#c33", fontSize: 12 }}>{error}</div>}
    {cards.map(card => <InlinePullRequestCard key={card.id} spaceId={spaceId} projectId={projectId}
      review={{ id: card.id, status: card.status, card: card as unknown as Record<string, unknown> }} {...(session ? { session } : {})} />)}
  </aside>;
}
