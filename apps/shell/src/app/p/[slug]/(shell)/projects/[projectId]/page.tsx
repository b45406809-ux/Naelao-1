"use client";

export const runtime = "edge";

import * as React from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button, Badge, FormInput, FormSelect, FormTextarea, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  getProject,
  updateProject,
  listThreads,
  createThread,
  listAgentDefinitions,
  listKbDocuments,
  createKbDocument,
  deleteKbDocument,
  type Project,
  type ThreadSummary,
  type AgentDefinitionSummary,
  type KbDocument,
} from "@/lib/api";
import { ProjectKindPanel } from "@/components/ProjectKindPanel";

export default function ProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const product = useProduct();
  const { activeSpaceId } = useActiveSpace();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const [project, setProject] = React.useState<Project | null>(null);
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [agents, setAgents] = React.useState<AgentDefinitionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);

  const [docs, setDocs] = React.useState<KbDocument[]>([]);
  const [docsLoading, setDocsLoading] = React.useState(true);
  const [newDocTitle, setNewDocTitle] = React.useState("");
  const [newDocContent, setNewDocContent] = React.useState("");
  const [addingDoc, setAddingDoc] = React.useState(false);

  // WS-4.2: editable draft of the rich project config (customer_bot kind, execution ceiling,
  // spend cap, max threads, agent bindings) — PATCH succeeds for an admin/owner in the target
  // business; the settings section is still shown to a plain member (read-only save attempt
  // will surface the 403 via toast rather than pre-computing role client-side).
  const [savingSettings, setSavingSettings] = React.useState(false);
  const [draftKind, setDraftKind] = React.useState<"workspace" | "customer_bot">("workspace");
  const [draftMaxThreads, setDraftMaxThreads] = React.useState("0");
  const [draftExecutionCeiling, setDraftExecutionCeiling] = React.useState("5");
  const [draftSpendCap, setDraftSpendCap] = React.useState("0");
  const [draftDefaultAgentId, setDraftDefaultAgentId] = React.useState("");

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      const [p, t, a] = await Promise.all([
        getProject(activeSpaceId, params.projectId, creds),
        listThreads(activeSpaceId, creds, { projectId: params.projectId }),
        listAgentDefinitions(activeSpaceId, creds).catch(() => []),
      ]);
      setProject(p);
      setThreads(t);
      setAgents(a);
      setDraftKind(p.kind === "customer_bot" ? "customer_bot" : "workspace");
      setDraftMaxThreads(String(p.max_threads ?? 0));
      setDraftExecutionCeiling(String(p.execution_ceiling ?? 5));
      setDraftSpendCap(String(p.daily_spend_cap_credits ?? 0));
      setDraftDefaultAgentId(p.default_agent_id ?? "");
    } catch {
      show("Couldn't load project");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, params.projectId, session]);

  const refreshDocs = React.useCallback(async () => {
    if (!creds) return;
    setDocsLoading(true);
    try {
      setDocs(await listKbDocuments(activeSpaceId, creds, params.projectId));
    } catch {
      show("Couldn't load knowledge base");
    } finally {
      setDocsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, params.projectId, session]);

  React.useEffect(() => {
    void refresh();
    void refreshDocs();
  }, [refresh, refreshDocs]);

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

  async function handleSaveSettings() {
    if (!creds) return;
    setSavingSettings(true);
    try {
      const updated = await updateProject(activeSpaceId, params.projectId, creds, {
        kind: draftKind,
        max_threads: Number(draftMaxThreads) || 0,
        execution_ceiling: Number(draftExecutionCeiling) || 1,
        daily_spend_cap_credits: Number(draftSpendCap) || 0,
        default_agent_id: draftDefaultAgentId || null,
      });
      setProject(updated);
      show("Settings saved");
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to save settings (admin role required)");
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleAddDoc(e: React.FormEvent) {
    e.preventDefault();
    if (!creds || !newDocTitle.trim() || !newDocContent.trim()) return;
    setAddingDoc(true);
    try {
      await createKbDocument(activeSpaceId, creds, {
        title: newDocTitle.trim(),
        content: newDocContent.trim(),
        project_id: params.projectId,
      });
      setNewDocTitle("");
      setNewDocContent("");
      await refreshDocs();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to add document");
    } finally {
      setAddingDoc(false);
    }
  }

  async function handleDeleteDoc(docId: string) {
    if (!creds) return;
    try {
      await deleteKbDocument(activeSpaceId, docId, creds);
      await refreshDocs();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to delete document");
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

      {/* F-40: the kind-specific panel (wallet ledger, etc.) + F-39 files viewer, above the shared
          shell's generic Settings/Threads/KB scaffolding. */}
      {creds && <ProjectKindPanel project={project} spaceId={activeSpaceId} creds={creds} />}

      <div className="section-label" style={{ marginTop: 24 }}>Settings</div>
      <div className="settings-block">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Kind</div>
            <div className="settings-row-sub">Customer-bot projects get a capped execution ceiling, a daily spend cap, and no-code rules</div>
          </div>
          <FormSelect value={draftKind} onChange={(e) => setDraftKind(e.target.value as "workspace" | "customer_bot")} style={{ maxWidth: 180 }}>
            <option value="workspace">Workspace</option>
            <option value="customer_bot">Customer bot</option>
          </FormSelect>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Default agent</div>
            <div className="settings-row-sub">Used when a thread doesn't pick one explicitly</div>
          </div>
          <FormSelect value={draftDefaultAgentId} onChange={(e) => setDraftDefaultAgentId(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">Space default</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ?? a.id}
              </option>
            ))}
          </FormSelect>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Max threads</div>
            <div className="settings-row-sub">0 = unlimited</div>
          </div>
          <FormInput
            type="number"
            min={0}
            value={draftMaxThreads}
            onChange={(e) => setDraftMaxThreads(e.target.value)}
            style={{ maxWidth: 100, textAlign: "right" }}
          />
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Execution ceiling</div>
            <div className="settings-row-sub">Tier 1-5 script execution ladder cap for this project</div>
          </div>
          <FormInput
            type="number"
            min={1}
            max={5}
            value={draftExecutionCeiling}
            onChange={(e) => setDraftExecutionCeiling(e.target.value)}
            style={{ maxWidth: 100, textAlign: "right" }}
          />
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Daily spend cap</div>
            <div className="settings-row-sub">Credits; 0 = no cap</div>
          </div>
          <FormInput
            type="number"
            min={0}
            value={draftSpendCap}
            onChange={(e) => setDraftSpendCap(e.target.value)}
            style={{ maxWidth: 100, textAlign: "right" }}
          />
        </div>
        <div className="settings-row">
          <Button size="sm" onClick={handleSaveSettings} disabled={savingSettings}>
            {savingSettings ? "Saving…" : "Save settings"}
          </Button>
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

      <div className="page-header" style={{ marginTop: 24 }}>
        <div className="section-label" style={{ marginBottom: 0 }}>
          Knowledge Base
        </div>
        <div className="page-subtitle">
          Documents added here are isolated to this project — they never appear in the space-wide knowledge base, and vice versa.
        </div>
      </div>

      <form onSubmit={handleAddDoc} className="settings-block" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        <FormInput placeholder="Document title" value={newDocTitle} onChange={(e) => setNewDocTitle(e.target.value)} required />
        <FormTextarea
          placeholder="Paste content to ingest into this project's KB…"
          value={newDocContent}
          onChange={(e) => setNewDocContent(e.target.value)}
          rows={4}
          required
        />
        <div>
          <Button size="sm" disabled={addingDoc}>
            {addingDoc ? "Adding…" : "Add document"}
          </Button>
        </div>
      </form>

      {docsLoading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading knowledge base…</p>
      ) : docs.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>No documents in this project's knowledge base yet.</p>
      ) : (
        <div className="settings-block">
          {docs.map((d) => (
            <div className="settings-row" key={d.id}>
              <div>
                <div className="settings-row-label">{d.title}</div>
                <div className="settings-row-sub">
                  {d.chunk_count} chunk{d.chunk_count === 1 ? "" : "s"} · {d.status}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => handleDeleteDoc(d.id)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}

      <Toast toast={toast} />
    </div>
  );
}
