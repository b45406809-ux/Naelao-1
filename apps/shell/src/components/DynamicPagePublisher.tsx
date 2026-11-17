"use client";

import * as React from "react";
import { Button, Card, CardDesc, CardTitle } from "@naelao/ui";
import { publishReviewedSpaceSharedDynamicPage, reviewSpaceSharedDynamicPage, unpublishSpaceSharedDynamicPage,
  type PublicDynamicPageDraft, type PublicDynamicPageReview, type SessionCredentials } from "@/lib/api";

const STARTER_DRAFT = JSON.stringify({
  slug: "welcome",
  html: "<main><h1>Welcome</h1><form><label>Email <input name=\"email\" type=\"email\"></label><button>Join</button><input type=\"hidden\" value=\"{{NAELAO_ACTION_TOKEN:signup}}\"></form></main>",
  actions: { signup: { key: "signup", fields: ["email"] } },
}, null, 2);

export function DynamicPagePublisher({ spaceId, appId, session }: { spaceId: string; appId: string; session: SessionCredentials }) {
  const [source, setSource] = React.useState(STARTER_DRAFT);
  const [review, setReview] = React.useState<PublicDynamicPageReview | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");

  function invalidate() { setReview(null); setConfirmed(false); setNotice(""); }
  async function createReview() {
    setBusy(true); setNotice("");
    try {
      const draft = JSON.parse(source) as PublicDynamicPageDraft;
      const result = await reviewSpaceSharedDynamicPage(spaceId, appId, session, draft);
      setReview(result); setConfirmed(false);
    } catch (error) { setReview(null); setNotice(error instanceof Error ? error.message : "Could not prepare a page review."); }
    finally { setBusy(false); }
  }
  async function publish() {
    if (!review || !confirmed || review.expires_at <= Date.now()) return;
    setBusy(true); setNotice("");
    try {
      const draft = JSON.parse(source) as PublicDynamicPageDraft;
      const result = await publishReviewedSpaceSharedDynamicPage(spaceId, appId, session, review.review_id, draft);
      setReview(null); setConfirmed(false);
      setNotice(`Published ${result.slug} with reviewed artifact ${result.artifact_sha256.slice(0, 16)}…`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not publish the reviewed page."); }
    finally { setBusy(false); }
  }
  async function takeDown() {
    setBusy(true); setNotice("");
    try {
      const draft = JSON.parse(source) as PublicDynamicPageDraft;
      const result = await unpublishSpaceSharedDynamicPage(spaceId, appId, session, draft.slug);
      invalidate(); setNotice(result.removed ? `Page ${result.slug} was taken down.` : `No published page exists at ${result.slug}.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not take down the page."); }
    finally { setBusy(false); }
  }
  const previewHtml = review?.draft.html.replace(/\{\{NAELAO_ACTION_TOKEN:[a-z0-9_-]+\}\}/g, "[secure action token]");

  return <Card style={{ margin: "12px 0", padding: 16 }}>
    <CardTitle>Public page review</CardTitle>
    <CardDesc>Space owners and admins can review the exact page artifact before publication. Review receipts expire after ten minutes. Public delivery remains gated until the host rollout is enabled.</CardDesc>
    <label style={{ display: "block", marginTop: 12, fontWeight: 600 }} htmlFor="dynamic-page-draft">Page draft (JSON)</label>
    <textarea id="dynamic-page-draft" aria-label="Public page draft JSON" value={source} onChange={event => { setSource(event.target.value); invalidate(); }}
      spellCheck={false} rows={12} style={{ width: "100%", marginTop: 6, fontFamily: "monospace", fontSize: 12 }} />
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
      <Button variant="secondary" disabled={busy} onClick={() => void createReview()}>{busy ? "Working…" : "Review exact draft"}</Button>
      <Button disabled={busy || !review || !confirmed || review.expires_at <= Date.now()} onClick={() => void publish()}>Publish reviewed page</Button>
      <Button variant="secondary" disabled={busy} onClick={() => void takeDown()}>Take down this slug</Button>
    </div>
    {review && <section aria-label="Reviewed page preview" style={{ marginTop: 14, padding: 12, border: "1px solid var(--border, #ddd)", borderRadius: 8 }}>
      <p><strong>Reviewed artifact:</strong> <code>{review.artifact_sha256}</code></p>
      <p style={{ fontSize: 12, color: "var(--text3)" }}>Slug: <code>{review.draft.slug}</code> · expires {new Date(review.expires_at).toLocaleTimeString()} · owner review grants no runtime capabilities.</p>
      <iframe title="Sandboxed public page preview" sandbox="" srcDoc={previewHtml} style={{ width: "100%", minHeight: 180, border: "1px solid var(--border, #ddd)" }} />
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10 }}>
        <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
        <span>I reviewed this exact artifact and authorize its publication.</span>
      </label>
    </section>}
    {notice && <p role="status" style={{ marginTop: 10, color: "var(--text2)" }}>{notice}</p>}
  </Card>;
}
