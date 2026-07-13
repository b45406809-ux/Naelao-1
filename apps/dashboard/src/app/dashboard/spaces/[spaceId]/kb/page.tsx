"use client";

export const runtime = "edge";

import { useEffect, useState, FormEvent, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { listKbDocs, uploadKbDoc, deleteKbDoc, getSpace } from "@/lib/api";
import type { KbDocument, Space } from "@/lib/api";

// G-BE30: KB management — upload, list, delete, status polling

const STATUS_CONFIG: Record<
  string,
  { label: string; className: string }
> = {
  pending: { label: "Pending", className: "bg-gray-100 text-gray-600" },
  processing: { label: "Processing", className: "bg-blue-100 text-blue-700" },
  indexed: { label: "Indexed", className: "bg-green-100 text-green-700" },
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
];

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
      (d) => d.status === "processing" || d.status === "pending"
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
    if (content.length > 1_000_000) {
      setUploadError("Content exceeds 1MB limit");
      return;
    }

    setUploading(true);
    try {
      const doc = await uploadKbDoc(spaceId, {
        title: title.trim(),
        content: content.trim(),
        content_type: contentType,
      });
      setDocs((prev) => [doc, ...prev]);
      setTitle("");
      setContent("");
      setContentType("text");
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

  async function handleDelete(docId: string) {
    if (!confirm("Delete this document? This action cannot be undone.")) return;
    setDeletingId(docId);
    try {
      await deleteKbDoc(spaceId, docId);
      setDocs((prev) => prev.filter((d) => d.id !== docId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  const hasProcessing = docs.some(
    (d) => d.status === "processing" || d.status === "pending"
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
            Processing... (auto-refreshing)
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
                        disabled={deletingId === doc.id}
                        className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50 whitespace-nowrap transition-colors"
                      >
                        {deletingId === doc.id ? "Deleting..." : "Delete"}
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
                    onChange={(e) => setTitle(e.target.value)}
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
                    onChange={(e) => setContentType(e.target.value)}
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
                      onChange={(e) => setContent(e.target.value)}
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
                    {content.length.toLocaleString()} / 1,000,000 chars
                  </p>
                </div>

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
                  disabled={uploading}
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
