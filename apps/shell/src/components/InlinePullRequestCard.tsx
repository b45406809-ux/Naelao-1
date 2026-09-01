"use client";

import * as React from "react";
import type { PullRequestRecord, FileDiffItem } from "@naelao/types";

export interface InlinePullRequestCardProps {
  spaceId: string;
  projectId?: string;
  pullRequest: PullRequestRecord;
  onMerge?: (prId: string) => Promise<void>;
  onReject?: (prId: string, reason?: string) => Promise<void>;
  onRequestChanges?: (prId: string, notes: string) => Promise<void>;
}

export function InlinePullRequestCard({
  spaceId,
  projectId,
  pullRequest,
  onMerge,
  onReject,
  onRequestChanges,
}: InlinePullRequestCardProps) {
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState(pullRequest.status);
  const [showDiff, setShowDiff] = React.useState(false);
  const [actionMessage, setActionMessage] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState("");
  const [isCommenting, setIsCommenting] = React.useState(false);

  const diffItems: FileDiffItem[] = React.useMemo(() => {
    if (pullRequest.diff_manifest && pullRequest.diff_manifest.length > 0) {
      return pullRequest.diff_manifest;
    }
    try {
      return JSON.parse(pullRequest.diff_manifest_json || "[]");
    } catch {
      return [];
    }
  }, [pullRequest]);

  const totalAdditions = diffItems.reduce((acc, f) => acc + (f.additions || 0), 0);
  const totalDeletions = diffItems.reduce((acc, f) => acc + (f.deletions || 0), 0);

  const handleMerge = async () => {
    if (busy || status !== "OPEN") return;
    setBusy(true);
    try {
      if (onMerge) {
        await onMerge(pullRequest.id);
      }
      setStatus("MERGED");
      setActionMessage("✔ Merged into Main branch. Cloudflare Pages edge preview updating.");
    } catch (err: any) {
      setActionMessage(`Failed to merge: ${err.message || "Unknown error"}`);
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (busy || status !== "OPEN") return;
    setBusy(true);
    try {
      if (onReject) {
        await onReject(pullRequest.id, notes);
      }
      setStatus("REJECTED");
      setActionMessage("Pull request rejected.");
    } catch (err: any) {
      setActionMessage(`Failed to reject: ${err.message || "Unknown error"}`);
    } finally {
      setBusy(false);
      setIsCommenting(false);
    }
  };

  const handleRequestChanges = async () => {
    if (!notes.trim() || busy) return;
    setBusy(true);
    try {
      if (onRequestChanges) {
        await onRequestChanges(pullRequest.id, notes);
      }
      setStatus("CHANGES_REQUESTED");
      setActionMessage("Changes requested sent to scratchpad agent.");
    } catch (err: any) {
      setActionMessage(`Failed to request changes: ${err.message || "Unknown error"}`);
    } finally {
      setBusy(false);
      setIsCommenting(false);
    }
  };

  return (
    <div className="my-3 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
            PR #{pullRequest.id.replace("pr_", "").slice(0, 8)}
          </span>
          <h4 className="font-semibold text-sm leading-tight text-foreground">{pullRequest.title}</h4>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            status === "MERGED" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" :
            status === "REJECTED" ? "bg-rose-500/15 text-rose-600 dark:text-rose-400" :
            status === "CHANGES_REQUESTED" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" :
            "bg-blue-500/15 text-blue-600 dark:text-blue-400"
          }`}>
            {status}
          </span>
        </div>
      </div>

      {/* Author & Branch info */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>👤 Author: <strong className="text-foreground">{pullRequest.author_user_id}</strong></span>
        <span>🌿 Source: <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{pullRequest.source_branch}</code></span>
        <span>🎯 Target: <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{pullRequest.target_branch || "main"}</code></span>
      </div>

      {/* AI Reasoning Summary */}
      <div className="mt-3 rounded-lg bg-muted/50 p-3 text-xs">
        <div className="font-semibold text-foreground mb-1 flex items-center gap-1">
          <span>🤖 AI Reasoning & Summary:</span>
        </div>
        <p className="text-muted-foreground whitespace-pre-wrap leading-relaxed">{pullRequest.reasoning_summary}</p>
      </div>

      {/* Changed Files & Diffs */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="font-medium text-foreground">
            🔍 Changed Files ({diffItems.length}):
          </span>
          <div className="flex items-center gap-2">
            <span className="text-emerald-600 font-mono font-medium">+{totalAdditions}</span>
            <span className="text-rose-600 font-mono font-medium">-{totalDeletions}</span>
            <button
              type="button"
              onClick={() => setShowDiff((v) => !v)}
              className="text-xs text-primary hover:underline ml-1"
            >
              {showDiff ? "Hide Diffs" : "View Diffs"}
            </button>
          </div>
        </div>

        <ul className="space-y-1 text-xs">
          {diffItems.map((item, idx) => (
            <li key={idx} className="flex items-center justify-between rounded bg-background/80 px-2.5 py-1.5 border border-border/50">
              <span className="font-mono text-foreground truncate max-w-[70%]">{item.path}</span>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className={`px-1 rounded text-[10px] uppercase font-bold ${
                  item.status === "CREATED" ? "bg-emerald-500/20 text-emerald-600" :
                  item.status === "DELETED" ? "bg-rose-500/20 text-rose-600" :
                  "bg-amber-500/20 text-amber-600"
                }`}>
                  {item.status}
                </span>
                <span className="text-emerald-600 font-mono">+{item.additions || 0}</span>
                <span className="text-rose-600 font-mono">-{item.deletions || 0}</span>
              </div>
            </li>
          ))}
        </ul>

        {showDiff && (
          <div className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-zinc-950 p-3 font-mono text-[11px] text-zinc-200">
            {diffItems.map((item, idx) => (
              <div key={idx} className="mb-3 last:mb-0">
                <div className="text-zinc-400 font-bold border-b border-zinc-800 pb-1 mb-1">
                  --- a/{item.path} <br />
                  +++ b/{item.path}
                </div>
                {item.newContent && (
                  <pre className="whitespace-pre-wrap text-emerald-400">{item.newContent.slice(0, 500)}...</pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reviewer Action Bar */}
      {status === "OPEN" && (
        <div className="mt-4 pt-3 border-t border-border/60">
          {isCommenting ? (
            <div className="space-y-2">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Enter revision requests or rejection reason..."
                className="w-full rounded-md border border-input bg-background p-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                rows={2}
              />
              <div className="flex items-center gap-2 justify-end">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setIsCommenting(false)}
                  className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy || !notes.trim()}
                  onClick={handleRequestChanges}
                  className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
                >
                  Request Changes
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleReject}
                  className="rounded-md bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-700"
                >
                  Reject PR
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={handleMerge}
                className="inline-flex items-center rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                ✅ Accept & Merge to Main
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setIsCommenting(true)}
                className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
              >
                💬 Request Revisions
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setIsCommenting(true)}
                className="inline-flex items-center rounded-lg border border-rose-200 dark:border-rose-900/50 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-50"
              >
                ❌ Reject
              </button>
            </div>
          )}
        </div>
      )}

      {actionMessage && (
        <div className="mt-2 text-xs font-medium text-muted-foreground">
          {actionMessage}
        </div>
      )}
    </div>
  );
}
