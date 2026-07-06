"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button, Badge, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { getProject, listThreads, createThread, type Project, type ThreadSummary } from "@/lib/api";

export default function ProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const product = useProduct();
  const { activeSpaceId } = useActiveSpace();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const [project, setProject] = React.useState<Project | null>(null);
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      const [p, t] = await Promise.all([
        getProject(activeSpaceId, params.projectId, creds),
        listThreads(activeSpaceId, creds, { projectId: params.projectId }),
      ]);
      setProject(p);
      setThreads(t);
    } catch {
      show("Couldn't load project");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, params.projectId, session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleNewThread() {
    if (!creds) return;
    setCreating(true);
    try {
      await createThread(activeSpaceId, creds, { project_id: params.projectId, title: "New thread" });
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to create thread");
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <div className="page-view">Loading…</div>;
  if (!project) return <div className="page-view">Project not found.</div>;

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">{project.name}</div>
        {project.description && <div className="page-subtitle">{project.description}</div>}
      </div>

      <div className="section-label">Configuration</div>
      <div className="settings-block">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Default agent</div>
            <div className="settings-row-sub">Used when a thread doesn't pick one explicitly</div>
          </div>
          <span>{project.default_agent_id ?? "Space default"}</span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Max threads</div>
          </div>
          <span>{project.max_threads > 0 ? project.max_threads : "Unlimited"}</span>
        </div>
      </div>

      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24 }}>
        <div className="section-label" style={{ marginBottom: 0 }}>
          Threads
        </div>
        <Button size="sm" onClick={handleNewThread} disabled={creating}>
          {creating ? "Creating…" : "New Thread"}
        </Button>
      </div>
      {threads.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>No threads yet.</p>
      ) : (
        threads.map((t) => (
          <Link key={t.id} href={`/p/${product.slug}/threads/${t.id}`} style={{ textDecoration: "none" }}>
            <div className="workflow-item">
              <div className="workflow-icon">
                <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="var(--accent)">
                  <path d="M4 2H10L13 5V14H4V2Z" />
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <div className="workflow-name">{t.title ?? "Untitled thread"}</div>
                <div className="workflow-meta">{new Date(t.created_at).toLocaleString()}</div>
              </div>
              <Badge color={t.status === "active" ? "green" : "blue"}>{t.status}</Badge>
            </div>
          </Link>
        ))
      )}
      <Toast toast={toast} />
    </div>
  );
}
