"use client";

export const runtime = "edge";

import { useEffect, useState, FormEvent, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { listKbDocs, uploadKbDoc, previewKbDocPdf, deleteKbDoc, getSpace } from "@/lib/api";
import type { KbDocument, KbPdfPreview, Space } from "@/lib/api";

// G-BE30: KB management — upload, list, delete, status polling

const STATUS_CONFIG: Record<
  string,
  { label: string; className: string }
> = {
  pending: { label: "Pending", className: "bg-gray-100 text-gray-600" },
  processing: { label: "Processing", className: "bg-blue-100 text-blue-700" },
  indexed: { label: "Indexed", className: "bg-green-100 text-green-700" },
  deleting: { label: "Deleting", className: "bg-amber-100 text-amber-700" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700" },
};

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    className: "bg-gray-100 text-gray-600",
  };
  return (
    <span
      className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}

const CONTENT_TYPE_OPTIONS = [
  { value: "text", label: "Plain Text" },
  { value: "url", label: "URL" },
  { value: "code", label: "Code" },
  { value: "pdf", label: "PDF (preview first)" },
];

async function encodePdfFile(file: File): Promise<string> {
  if (!/\.pdf$/i.test(file.name) || (file.type && file.type !== "application/pdf")) throw new TypeError("Choose a PDF file.");
  if (file.size < 5 || file.size > 1_048_576) throw new RangeError("Space-wide Knowledge PDF files are limited to 1 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new TypeError("The selected file is not a valid PDF document.");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

export default function KbPage() {
  const params = useParams();
  const spaceId = params["spaceId"] as string;

  const [space, setSpace] = useState<Space | null>(null);
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Upload form
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [contentType, setContentType] = useState("text");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<{ base64: string; receipt: KbPdfPreview } | null>(null);
  const [previewingPdf, setPreviewingPdf] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createIdempotencyKeyRef = useRef<string | null>(null);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Polling ref
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadDocs = useCallback(async () => {
    try {
      const data = await listKbDocs(spaceId);
      setDocs(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load documents");
    }
  }, [spaceId]);

  // Set up polling when any doc is in processing state
  useEffect(() => {
    const hasProcessing = docs.some(
      (d) => d.status === "processing" || d.status === "pending" || d.status === "deleting"
    );

    if (hasProcessing) {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => {
          void loadDocs();
        }, 5000);
      }
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [docs, loadDocs]);

  useEffect(() => {
    async function init() {
      setLoading(true);
      try {
        const [spaceData, docsData] = await Promise.all([
          getSpace(spaceId),
          listKbDocs(spaceId),
        ]);
        setSpace(spaceData);
        setDocs(docsData);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    }
    void init();
  }, [spaceId]);

  async function handleUpload(e: FormEvent) {
    e.preventDefault();
    setUploadError(null);
    setUploadSuccess(false);

    if (!title.trim()) {
      setUploadError("Title is required");
      return;
    }
    if (!content.trim()) {
      setUploadError("Content is required");
      return;
    }
    if (contentType === "pdf" && !pdfPreview) {
      setUploadError("Choose and preview a PDF before uploading it.");
      return;
    }
    const approvedContent = content.trim();
    if (new TextEncoder().encode(approvedContent).byteLength > 1_000_000) {
      setUploadError("Content exceeds 1MB limit");
      return;
    }

    setUploading(true);
    try {
      const idempotencyKey = createIdempotencyKeyRef.current ?? (createIdempotencyKeyRef.current = crypto.randomUUID());
      const doc = await uploadKbDoc(spaceId, pdfPreview ? {
        title: title.trim(),
        content: pdfPreview.base64,
        content_type: "pdf",
        idempotency_key: idempotencyKey,
        ...(pdfPreview.receipt.source_file_name ? { source_file_name: pdfPreview.receipt.source_file_name } : {}),
        preview_content: approvedContent,
        preview_token: pdfPreview.receipt.preview_token,
        preview_extraction_sha256: pdfPreview.receipt.extraction_sha256,
      } : {
        title: title.trim(),
        content: approvedContent,
        content_type: contentType,
        idempotency_key: idempotencyKey,
      });
      if (doc.status === "failed") {
        createIdempotencyKeyRef.current = null;
        setUploadError("This earlier upload attempt failed. Submit again to start a new attempt.");
        await loadDocs();
        return;
      }
      createIdempotencyKeyRef.current = null;
      setDocs((prev) => [doc, ...prev]);
      setTitle("");
      setContent("");
      setContentType("text");
      setPdfPreview(null);
      setUploadSuccess(true);
      setTimeout(() => setUploadSuccess(false), 3000);
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : "Upload failed"
      );
    } finally {
      setUploading(false);
    }
  }

  async function handlePdfPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    createIdempotencyKeyRef.current = null;
    setPdfPreview(null);
    setUploadError(null);
    setPreviewingPdf(true);
    try {
      const base64 = await encodePdfFile(file);
      const receipt = await previewKbDocPdf(spaceId, { content: base64, source_file_name: file.name });
      setContentType("pdf");
      setTitle((current) => current || file.name.replace(/\.pdf$/i, ""));
      setContent(receipt.content);
      setPdfPreview({ base64, receipt });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not preview that PDF.");
    } finally {
      setPreviewingPdf(false);
    }
  }

  async function handleDelete(docId: string) {
    if (!confirm("Delete this document? This action cannot be undone.")) return;
    setDeletingId(docId);
    try {
      await deleteKbDoc(spaceId, docId);
      await loadDocs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  const hasProcessing = docs.some(
    (d) => d.status === "processing" || d.status === "pending" || d.status === "deleting"
  );

  return (
    <div className="max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
        <Link href="/dashboard/spaces" className="hover:text-gray-700">
          Spaces
        </Link>
        <span>/</span>
        <span className="text-gray-700">{space?.name ?? spaceId}</span>
        <span>/</span>
        <span className="text-gray-900 font-medium">Knowledge Base</span>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Knowledge Base</h1>
          <p className="text-gray-500 mt-1">
            Documents available for AI retrieval in this Space
          </p>
        </div>
        {hasProcessing && (
          <div className="flex items-center gap-2 text-sm text-blue-600 bg-blue-50 px-3 py-1.5 rounded-lg">
            <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-600" />
            {docs.some((doc) => doc.status === "deleting") ? "Deletion in progress..." : "Processing..."} (auto-refreshing)
          </div>
        )}
      </div>

      {loading && (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-6 text-sm">
          {error}
        </div>
      )}

      {!loading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Document list */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900">
                  Documents ({docs.length})
                </h2>
              </div>

              {docs.length === 0 ? (
                <div className="px-5 py-10 text-center text-gray-400 text-sm">
                  No documents yet. Upload one to get started.
                </div>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {docs.map((doc) => (
                    <li
                      key={doc.id}
                      className="px-5 py-4 flex items-center justify-between gap-4"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-gray-900 truncate">
                          {doc.title}
                        </p>
                        <div className="flex items-center gap-3 mt-1">
                          <StatusBadge status={doc.status} />
                          {doc.chunk_count > 0 && (
                            <span className="text-xs text-gray-400">
                              {doc.chunk_count} chunks
                            </span>
                          )}
                          <span className="text-xs text-gray-400">
                            {doc.content_type}
                          </span>
                          <span className="text-xs text-gray-400">
                            {new Date(doc.created_at).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleDelete(doc.id)}
                        disabled={deletingId === doc.id || doc.status === "deleting"}
                        className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50 whitespace-nowrap transition-colors"
                      >
                        {deletingId === doc.id || doc.status === "deleting" ? "Deleting..." : "Delete"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Upload panel */}
          <div>
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="font-semibold text-gray-900 mb-4">
                Upload Document
              </h2>
              <p className="text-xs text-gray-400 mb-4">Max 1MB per document</p>

              <form onSubmit={handleUpload} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Title <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => { createIdempotencyKeyRef.current = null; setTitle(e.target.value); }}
                    required
                    placeholder="e.g. Product FAQ"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Content Type
                  </label>
                  <select
                    value={contentType}
                    onChange={(e) => { createIdempotencyKeyRef.current = null; setPdfPreview(null); setContentType(e.target.value); }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm bg-white"
                  >
                    {CONTENT_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {contentType === "url" ? "URL" : "Content"}{" "}
                    <span className="text-red-500">*</span>
                  </label>
                  {contentType === "url" ? (
                    <input
                      type="url"
                      value={content}
                      onChange={(e) => { createIdempotencyKeyRef.current = null; setContent(e.target.value); }}
                      required
                      placeholder="https://example.com/page"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
                    />
                  ) : (
                    <textarea
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      required
                      rows={6}
                      placeholder={
                        contentType === "code"
                          ? "// Paste your code here"
                          : "Paste your document content here..."
                      }
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm resize-y font-mono"
                    />
                  )}
                  <p className="text-xs text-gray-400 mt-1">
                    {new TextEncoder().encode(content).byteLength.toLocaleString()} / 1,000,000 bytes
                  </p>
                </div>

                {contentType !== "url" && <div className="flex items-center gap-3">
                  <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" onChange={(event) => void handlePdfPick(event)} className="hidden" />
                  <button type="button" onClick={() => fileInputRef.current?.click()} disabled={previewingPdf || uploading}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50">
                    {previewingPdf ? "Preparing PDF preview…" : "Choose PDF to preview"}
                  </button>
                  <span className="text-xs text-gray-400">PDFs are limited to 1 MiB.</span>
                </div>}

                {pdfPreview && <div role="status" className="border border-gray-200 rounded-lg p-3 text-xs text-gray-600">
                  <strong className="text-gray-900">PDF extraction preview · {pdfPreview.receipt.parser_version}</strong>
                  <div>Source SHA-256: <code>{pdfPreview.receipt.source_sha256}</code></div>
                  <div>{pdfPreview.receipt.source_bytes.toLocaleString()} source bytes · {pdfPreview.receipt.extracted_bytes.toLocaleString()} extracted bytes (1 MiB Space-wide limit)</div>
                  <p className="my-2">Review and edit extracted text above before upload. Preview expires after 15 minutes.</p>
                  <ul className="list-disc pl-5">{pdfPreview.receipt.extraction_warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                </div>}

                {uploadError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                    {uploadError}
                  </p>
                )}

                {uploadSuccess && (
                  <p className="text-xs text-green-600 bg-green-50 border border-green-200 rounded px-3 py-2">
                    Document uploaded successfully!
                  </p>
                )}

                <button
                  type="submit"
                  disabled={uploading || previewingPdf || new TextEncoder().encode(content.trim()).byteLength > 1_000_000}
                  className="w-full py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  {uploading ? "Uploading..." : "Upload Document"}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
