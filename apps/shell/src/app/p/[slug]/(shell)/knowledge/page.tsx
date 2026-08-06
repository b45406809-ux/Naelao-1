"use client";

export const runtime = "edge";

// Knowledge Base — the curated, searchable document store for the active business or product.
//
// Deliberately a DIFFERENT mechanism from the input bar's chat uploads (ComposerDock's Uploads
// panel): a KB entry is chunked, embedded, and searchable across every conversation in this
// space/project going forward; a chat upload is a raw file scoped to the ONE conversation that
// attached it, read directly by the agent's own filesystem tools. This page used to be reachable
// only through a since-removed "Attach a file" button buried in the input bar, which silently
// capped every entry at 2MB of plain text — genuine document management belongs here instead.

import * as React from "react";
import { Button, FormInput, Card, CardTitle, CardDesc, Badge, useToast, Toast } from "@naelao/ui";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  listKbDocuments,
  createKbDocument,
  deleteKbDocument,
  searchKb,
  type KbDocument,
  type KbSearchResult,
} from "@/lib/api";

const STATUS_COLOR: Record<KbDocument["status"], "green" | "amber" | "red"> = {
  indexed: "green",
  pending: "amber",
  processing: "amber",
  flagged: "amber",
  failed: "red",
};

export default function KnowledgePage() {
  const { session } = useProductAuth();
  const { activeSpaceId } = useActiveSpace();
  const { toast, show } = useToast();
  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const [docs, setDocs] = React.useState<KbDocument[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [showAdd, setShowAdd] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [content, setContent] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const [query, setQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [results, setResults] = React.useState<KbSearchResult[] | null>(null);

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      setDocs(await listKbDocuments(activeSpaceId, creds));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleAdd() {
    if (!creds || !title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      await createKbDocument(activeSpaceId, creds, { title: title.trim(), content: content.trim(), content_type: "text" });
      setTitle("");
      setContent("");
      setShowAdd(false);
      show("Added — it'll show as \"indexed\" once embedding finishes.");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't add that document");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(doc: KbDocument) {
    if (!creds) return;
    setBusyId(doc.id);
    try {
      await deleteKbDocument(activeSpaceId, doc.id, creds);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't delete that document");
    } finally {
      setBusyId(null);
    }
  }

  async function handleSearch() {
    if (!creds || !query.trim()) { setResults(null); return; }
    setSearching(true);
    try {
      setResults(await searchKb(activeSpaceId, creds, query.trim()));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  const docTitle = (docId: string) => docs.find((d) => d.id === docId)?.title ?? docId;

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Knowledge</div>
        <div className="page-subtitle">
          What the assistant can look up while it works — curated documents, not a chat attachment.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <FormInput
            placeholder="Search the knowledge base…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
          />
        </div>
        <Button variant="secondary" onClick={() => void handleSearch()} disabled={searching || !query.trim()}>
          {searching ? "Searching…" : "Search"}
        </Button>
        <Button onClick={() => setShowAdd((v) => !v)}>{showAdd ? "Cancel" : "Add document"}</Button>
      </div>

      {results !== null && (
        <div style={{ marginBottom: 20 }}>
          <div className="section-label">Search results</div>
          {results.length === 0 ? (
            <p style={{ color: "var(--text3)", fontSize: 13 }}>No matches — try different words, or the document may not have finished indexing yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {results.map((r) => (
                <Card key={r.chunk_id}>
                  <CardTitle>{docTitle(r.doc_id)}</CardTitle>
                  <CardDesc>{r.content.replace(/<\/?kb_content>/g, "").slice(0, 240)}{r.content.length > 240 ? "…" : ""}</CardDesc>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {showAdd && (
        <Card style={{ marginBottom: 16 }}>
          <CardTitle>Add a document</CardTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
            <FormInput placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea
              className="msg-input"
              placeholder="Paste the content — a policy, a price list, product notes…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={8}
              style={{ resize: "vertical" }}
            />
            <div>
              <Button onClick={() => void handleAdd()} disabled={saving || !title.trim() || !content.trim()}>
                {saving ? "Adding…" : "Add"}
              </Button>
            </div>
          </div>
        </Card>
      )}

      <div className="section-label">Documents</div>
      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : failed ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
          <span style={{ color: "#dc2626" }} role="alert">Couldn&rsquo;t load the knowledge base.</span>
          <Button variant="secondary" onClick={() => void refresh()}>Retry</Button>
        </div>
      ) : docs.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          Nothing here yet. Add a document the assistant should know about — it becomes searchable
          across every conversation, not just one.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {docs.map((d) => (
            <Card key={d.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <CardTitle>{d.title}</CardTitle>
                  <CardDesc>{d.chunk_count} chunk{d.chunk_count === 1 ? "" : "s"} · added {new Date(d.created_at).toLocaleDateString()}</CardDesc>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <Badge color={STATUS_COLOR[d.status]}>{d.status}</Badge>
                  <Button variant="secondary" onClick={() => void handleDelete(d)} disabled={busyId === d.id}>
                    {busyId === d.id ? "…" : "Delete"}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Toast toast={toast} />
    </div>
  );
}
