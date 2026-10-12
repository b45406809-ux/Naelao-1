"use client";

import * as React from "react";
import { decidePullRequestCard, type SessionCredentials } from "@/lib/api";

interface Props {
  spaceId: string;
  projectId: string;
  review: { id: string; status?: string; card?: Record<string, unknown> };
  session?: SessionCredentials;
}

export function InlinePullRequestCard({ spaceId, projectId, review, session }: Props) {
  const [status, setStatus] = React.useState(review.status ?? "review_required");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const card = review.card ?? {};
  const files = Array.isArray(card.files) ? card.files as Array<Record<string, unknown>> : [];
  React.useEffect(() => setStatus(review.status ?? "review_required"), [review.status]);
  const decide = async (decision: "merge" | "request_changes" | "reject") => {
    setBusy(true); setError("");
    try {
      const result = await decidePullRequestCard(spaceId, projectId, review.id, decision, session);
      setStatus(result.status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review action failed");
    } finally { setBusy(false); }
  };
  const resolved = ["merged", "revisions_requested", "rejected"].includes(status);
  return <section aria-label="Pull request review" style={{ marginTop: 8, maxWidth: 520, padding: 12, border: "1px solid var(--border, #444)", borderRadius: 10 }}>
    <strong>{String(card.title ?? "Worker changes")}</strong>
    <div style={{ opacity: 0.78, fontSize: 12, marginTop: 4 }}>{String(card.baseBranch ?? "main")} ← {String(card.forkBranch ?? "candidate")} · {status.replaceAll("_", " ")}</div>
    {typeof card.reasoning === "string" && <p style={{ margin: "8px 0", whiteSpace: "pre-wrap" }}>{card.reasoning}</p>}
    {files.length > 0 && <ul style={{ margin: "8px 0", paddingLeft: 20, fontSize: 12 }}>{files.slice(0, 30).map((file, index) => <li key={`${String(file.path ?? "file")}-${index}`}>{String(file.status ?? "changed")} {String(file.path ?? "")}</li>)}</ul>}
    {!resolved && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button type="button" disabled={busy} onClick={() => void decide("merge")}>Merge</button>
      <button type="button" disabled={busy} onClick={() => void decide("request_changes")}>Request changes</button>
      <button type="button" disabled={busy} onClick={() => void decide("reject")}>Reject</button>
    </div>}
    {error && <div role="alert" style={{ color: "#c33", marginTop: 8 }}>{error}</div>}
  </section>;
}
