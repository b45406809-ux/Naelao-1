"use client";

// Knowledge Base — the curated, searchable document store for the active business or product.
//
// Deliberately a DIFFERENT mechanism from the input bar's chat uploads (ComposerDock's Uploads
// panel): a KB entry is chunked, embedded, and searchable across every conversation in this
// space/project going forward; a chat upload is a raw file scoped to the ONE conversation that
// attached it, read directly by the agent's own filesystem tools. This page used to be reachable
// only through a since-removed "Attach a file" button buried in the input bar. Space-wide entries
// use the server's 1 MiB synchronous limit; larger entries belong to a project-scoped KB.

import * as React from "react";
import { Button, FormInput, Card, CardTitle, CardDesc, Badge, useToast, Toast } from "@naelao/ui";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  listKbDocuments,
  createKbDocument,
  getRestoredKbDocumentContent,
  reindexRestoredKbDocument,
  deleteKbDocument,
  searchKb,
  type KbDocument,
  type KbSearchResult,
} from "@/lib/api";
import { knowledgeContentByteLength, SPACE_KNOWLEDGE_MAX_CONTENT_BYTES } from "@/lib/knowledge-upload-limits";

const STATUS_COLOR: Record<KbDocument["status"], "green" | "amber" | "red"> = {
  indexed: "green",
  pending: "amber",
  processing: "amber",
  deleting: "amber",
  reindex_required: "amber",
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
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);

  const [query, setQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [results, setResults] = React.useState<KbSearchResult[] | null>(null);

  const refresh = React.useCallback(async (showLoading = true) => {
    if (!creds) return;
    if (showLoading) setLoading(true);
    try {
      setDocs(await listKbDocuments(activeSpaceId, creds));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      if (showLoading) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!docs.some((doc) => doc.status === "deleting")) return;
    const timer = setInterval(() => { void refresh(false); }, 5_000);
    return () => clearInterval(timer);
  }, [docs, refresh]);

  async function handleAdd() {
    if (!creds || !title.trim() || !content.trim()) return;
    const submittedContent = content.trim();
    if (knowledgeContentByteLength(submittedContent) > SPACE_KNOWLEDGE_MAX_CONTENT_BYTES) {
      show("Space-wide Knowledge content is limited to 1 MiB. Add larger documents from a project Knowledge Base, which supports up to 5 MiB.");
      return;
    }
    setSaving(true);
    try {
      await createKbDocument(activeSpaceId, creds, { title: title.trim(), content: submittedContent, content_type: "text" });
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

  // Real file-browse, alongside the manual paste — reads a selected file's TEXT client-side and
  // pre-fills title (from the filename) + content, rather than making a person retype/copy-paste
  // a document they already have as a file. Space-wide documents are limited to 1 MiB by the API;
  // real binary/PDF parsing stays a separate, larger KB-pipeline feature.
  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file) return;
    const looksText = /^text\//.test(file.type) || file.type === "" || /\.(md|txt|csv|json|ts|tsx|js|jsx|py|yaml|yml|log)$/i.test(file.name);
    if (!looksText || file.size > SPACE_KNOWLEDGE_MAX_CONTENT_BYTES) {
      setFileError(`Can't read "${file.name}" — Space-wide Knowledge accepts text files up to 1 MiB.`);
      return;
    }
    setFileError(null);
    file.text().then((text) => {
      setTitle((t) => t || file.name);
      setContent(text);
    }).catch(() => setFileError(`Couldn't read "${file.name}".`));
  }

  async function handleDelete(doc: KbDocument) {
    if (!creds) return;
    setBusyId(doc.id);
    try {
      const result = await deleteKbDocument(activeSpaceId, doc.id, creds);
      await refresh();
      if (result.state === "pending") show("Deletion is still in progress. This list will update when cleanup finishes.");
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't delete that document");
    } finally {
      setBusyId(null);
    }
  }

  async function handleReindexRestoredDocument(doc: KbDocument) {
    if (!creds || doc.status !== "reindex_required") return;
    if (!window.confirm("Rebuild search indexes for this restored document from its archived chunks? This sends the stored text through the current Knowledge indexing path and may use Workers AI, Vectorize, and optional AutoRAG resources.")) return;
    setBusyId(doc.id);
    try {
      const source = await getRestoredKbDocumentContent(activeSpaceId, doc.id, creds);
      await reindexRestoredKbDocument(activeSpaceId, doc.id, creds, { title: source.title, content: source.content });
      show("Knowledge indexes rebuilt from the restored chunks.");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not reindex the restored document");
      await refresh(false);
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
            <div style={{ fontSize: 12, color: "var(--text3)" }}>
              Space-wide text limit: 1 MiB ({knowledgeContentByteLength(content.trim()).toLocaleString()} bytes entered). Project Knowledge supports up to 5 MiB.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Button onClick={() => void handleAdd()} disabled={saving || !title.trim() || !content.trim() || knowledgeContentByteLength(content.trim()) > SPACE_KNOWLEDGE_MAX_CONTENT_BYTES}>
                {saving ? "Adding…" : "Add"}
              </Button>
              <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleFilePick} />
              <Button variant="ghost" onClick={() => fileInputRef.current?.click()}>Upload a file instead</Button>
              {fileError && <span style={{ fontSize: 12, color: "var(--danger)" }}>{fileError}</span>}
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
                  {d.status === "reindex_required" && <Button variant="secondary" onClick={() => void handleReindexRestoredDocument(d)} disabled={busyId === d.id}>
                    {busyId === d.id ? "Reindexing…" : "Rebuild search index"}
                  </Button>}
                  <Button variant="secondary" onClick={() => void handleDelete(d)} disabled={busyId === d.id || d.status === "deleting"}>
                    {busyId === d.id || d.status === "deleting" ? "Deleting…" : "Delete"}
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
