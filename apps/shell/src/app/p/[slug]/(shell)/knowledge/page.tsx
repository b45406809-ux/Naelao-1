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
  previewKbPdf,
  getRestoredKbDocumentContent,
  reindexRestoredKbDocument,
  deleteKbDocument,
  searchKb,
  type KbDocument,
  type KbSearchResult,
} from "@/lib/api";
import { knowledgeContentByteLength, SPACE_KNOWLEDGE_MAX_CONTENT_BYTES } from "@/lib/knowledge-upload-limits";
import { readKnowledgePdfFile } from "@/lib/knowledge-pdf-preview";
import { KnowledgeCsvPreview } from "@/components/KnowledgeCsvPreview";

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
  const [csvPreviewActive, setCsvPreviewActive] = React.useState(false);
  const [xlsxPreviewActive, setXlsxPreviewActive] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [pdfPreview, setPdfPreview] = React.useState<{ base64: string; receipt: Awaited<ReturnType<typeof previewKbPdf>> } | null>(null);
  const [previewingPdf, setPreviewingPdf] = React.useState(false);
  const createIdempotencyKeyRef = React.useRef<string | null>(null);

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
      const idempotencyKey = createIdempotencyKeyRef.current ?? (createIdempotencyKeyRef.current = crypto.randomUUID());
      const previewFormat = pdfPreview && /\.docx$/i.test(pdfPreview.receipt.source_file_name) ? "docx"
        : pdfPreview && /\.xlsx$/i.test(pdfPreview.receipt.source_file_name) ? "xlsx"
          : pdfPreview && /\.pptx$/i.test(pdfPreview.receipt.source_file_name) ? "pptx"
            : pdfPreview && /\.(?:png|jpe?g)$/i.test(pdfPreview.receipt.source_file_name) ? "image" : "pdf";
      const created = await createKbDocument(activeSpaceId, creds, pdfPreview ? {
        title: title.trim(), content: pdfPreview.base64, content_type: previewFormat, idempotency_key: idempotencyKey,
        ...(pdfPreview.receipt.source_file_name ? { source_file_name: pdfPreview.receipt.source_file_name } : {}),
        preview_content: submittedContent, preview_token: pdfPreview.receipt.preview_token,
        preview_extraction_sha256: pdfPreview.receipt.extraction_sha256,
      } : { title: title.trim(), content: submittedContent, content_type: "text", idempotency_key: idempotencyKey });
      if (created.status === "failed") {
        createIdempotencyKeyRef.current = null;
        show("This earlier upload attempt failed. Submit again to start a new attempt.");
        await refresh();
        return;
      }
      createIdempotencyKeyRef.current = null;
      setTitle("");
      setContent("");
      setCsvPreviewActive(false);
      setXlsxPreviewActive(false);
      setPdfPreview(null);
      setFileError(null);
      setShowAdd(false);
      show("Added — it'll show as \"indexed\" once embedding finishes.");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't add that document");
    } finally {
      setSaving(false);
    }
  }

  // Text stays a direct bounded upload. PDF uses the scoped parser preview and the original file
  // bytes remain bound to the later approval request.
  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file) return;
    createIdempotencyKeyRef.current = null;
    setPdfPreview(null);
    setCsvPreviewActive(false);
    setXlsxPreviewActive(false);
    if (/\.(pdf|docx|xlsx|pptx|png|jpe?g)$/i.test(file.name)) {
      if (!creds) return;
      setFileError(null);
      setPreviewingPdf(true);
      try {
        const base64 = await readKnowledgePdfFile(file);
        const receipt = await previewKbPdf(activeSpaceId, creds, { content: base64, source_file_name: file.name });
        setTitle((current) => current || file.name.replace(/\.(pdf|docx|xlsx|pptx|png|jpe?g)$/i, ""));
        setContent(receipt.content);
        setPdfPreview({ base64, receipt });
        setXlsxPreviewActive(/\.xlsx$/i.test(file.name));
      } catch (err) {
        setFileError(err instanceof Error ? err.message : "Could not preview that document.");
      } finally {
        setPreviewingPdf(false);
      }
      return;
    }
    const looksText = /^text\//.test(file.type) || file.type === "" || /\.(md|txt|csv|json|ts|tsx|js|jsx|py|yaml|yml|log)$/i.test(file.name);
    if (!looksText || file.size > SPACE_KNOWLEDGE_MAX_CONTENT_BYTES) {
      setFileError(`Can't read "${file.name}" — Space-wide Knowledge accepts text files up to 1 MiB.`);
      return;
    }
    setFileError(null);
    setPdfPreview(null);
    file.text().then((text) => {
      setTitle((t) => t || file.name);
      setContent(text);
      setCsvPreviewActive(/\.csv$/i.test(file.name));
      setXlsxPreviewActive(false);
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
            <FormInput placeholder="Title" value={title} onChange={(e) => { createIdempotencyKeyRef.current = null; setTitle(e.target.value); }} />
            <textarea
              className="msg-input"
              placeholder="Paste the content — a policy, a price list, product notes…"
              value={content}
              onChange={(e) => { createIdempotencyKeyRef.current = null; setContent(e.target.value); }}
              rows={8}
              style={{ resize: "vertical" }}
            />
            {csvPreviewActive && <KnowledgeCsvPreview content={content} />}
            {xlsxPreviewActive && <KnowledgeCsvPreview content={content} delimiter="\t" kind="XLSX worksheet" />}
            <div style={{ fontSize: 12, color: "var(--text3)" }}>
              Space-wide text limit: 1 MiB ({knowledgeContentByteLength(content.trim()).toLocaleString()} bytes entered). Project Knowledge supports up to 5 MiB.
            </div>
            {pdfPreview && <div role="status" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, fontSize: 12 }}>
              <strong>{/\.docx$/i.test(pdfPreview.receipt.source_file_name) ? "DOCX" : /\.xlsx$/i.test(pdfPreview.receipt.source_file_name) ? "XLSX" : /\.pptx$/i.test(pdfPreview.receipt.source_file_name) ? "PPTX" : /\.(?:png|jpe?g)$/i.test(pdfPreview.receipt.source_file_name) ? "IMAGE OCR" : "PDF"} extraction preview · {pdfPreview.receipt.parser_version}</strong>
              <div>Source SHA-256: <code>{pdfPreview.receipt.source_sha256}</code></div>
              <div>{pdfPreview.receipt.source_bytes.toLocaleString()} source bytes · {pdfPreview.receipt.extracted_bytes.toLocaleString()} extracted bytes (1 MiB Space-wide limit)</div>
              <p>Review and edit the extracted text below before saving. This selected file is bound to the preview for 15 minutes.</p>
              <ul>{pdfPreview.receipt.extraction_warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </div>}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Button onClick={() => void handleAdd()} disabled={saving || previewingPdf || !title.trim() || !content.trim() || knowledgeContentByteLength(content.trim()) > SPACE_KNOWLEDGE_MAX_CONTENT_BYTES}>
                {saving ? "Adding…" : "Add"}
              </Button>
              <input ref={fileInputRef} type="file" accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.yaml,.yml,.log,text/*" style={{ display: "none" }} onChange={(event) => void handleFilePick(event)} />
              <Button variant="ghost" onClick={() => fileInputRef.current?.click()} disabled={previewingPdf}>{previewingPdf ? "Preparing document preview…" : "Upload text, PDF, DOCX, XLSX, PPTX, PNG or JPEG"}</Button>
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
