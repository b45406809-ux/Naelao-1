"use client";

export const runtime = "edge";

// Ported from apps/launchpad/src/index.html's Projects page (#projects-view): breadcrumb, a
// header with icon action buttons, a stats row, a searchable thread list with status-colored
// badges, and an agents-in-project grid ending in a "view all" card — using the SAME global
// classes (grid-4, workflow-item, badge-green/amber, search-bar, card-icon, btn-ghost/btn-primary)
// packages/ui/src/styles.css already ports verbatim from that same mockup, so this isn't a
// re-theme, it's actually using the shared system the way the mockup's own markup does.
//
// Kept, not ported: the mockup's per-tile "Credits used" stat (not tracked per-project — would be
// fabricated, same precedent as this codebase's `credits_consumed: null` elsewhere) and each
// thread/agent's fake run counts. Everything else here is real, fetched data.

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Card, CardLabel, CardValue, CardTitle, CardDesc, Modal, FormInput, FormSelect, FormTextarea, useToast, Toast } from "@naelao/ui";
import { relativeTime } from "@/lib/relativeTime";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  getProject,
  updateProject,
  listThreads,
  listProjects,
  createThread,
  listAgentDefinitions,
  listKbDocuments,
  createKbDocument,
  deleteKbDocument,
  listAgentTemplates,
  instantiateAgentTemplate,
  type Project,
  type ThreadSummary,
  type AgentDefinitionSummary,
  type KbDocument,
  type AgentTemplateSummary,
} from "@/lib/api";
import { ProjectKindPanel } from "@/components/ProjectKindPanel";
import { CustomerBotAutomation } from "@/components/CustomerBotAutomation";
import { AgentPolicyPanel } from "@/components/AgentPolicyPanel";

const STATUS_BADGE: Record<string, "green" | "amber" | "blue" | undefined> = {
  active: "green",
  archived: undefined,
};

export default function ProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const product = useProduct();
  const { activeSpaceId, activeSpaceName } = useActiveSpace();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const [project, setProject] = React.useState<Project | null>(null);
  const [allProjects, setAllProjects] = React.useState<Project[]>([]);
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [agents, setAgents] = React.useState<AgentDefinitionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [threadQuery, setThreadQuery] = React.useState("");
  const settingsRef = React.useRef<HTMLDivElement>(null);

  // Naelao Agent Templates — add a real, differently-configured agent to this project.
  const [templatePickerOpen, setTemplatePickerOpen] = React.useState(false);
  const [templates, setTemplates] = React.useState<AgentTemplateSummary[]>([]);
  const [templatesLoading, setTemplatesLoading] = React.useState(false);
  const [instantiating, setInstantiating] = React.useState(false);

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
      const [p, t, a, allP] = await Promise.all([
        getProject(activeSpaceId, params.projectId, creds),
        listThreads(activeSpaceId, creds, { projectId: params.projectId }),
        listAgentDefinitions(activeSpaceId, creds).catch(() => []),
        listProjects(activeSpaceId, creds).catch(() => []),
      ]);
      setProject(p);
      setThreads(t);
      setAgents(a);
      setAllProjects(allP);
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

  // Defensive re-fetch on regaining focus: a thread created from this project's own "New Thread"
  // button navigates straight into it, so coming back here (tab switch, browser back) should
  // never show a stale list from before that thread existed.
  React.useEffect(() => {
    function onFocus() {
      void refresh();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  async function openTemplatePicker() {
    setTemplatePickerOpen(true);
    if (templates.length > 0 || !creds) return;
    setTemplatesLoading(true);
    try {
      setTemplates(await listAgentTemplates(activeSpaceId, creds));
    } catch {
      show("Couldn't load agent templates");
    } finally {
      setTemplatesLoading(false);
    }
  }

  async function handleAddFromTemplate(t: AgentTemplateSummary) {
    if (!creds || instantiating) return;
    setInstantiating(true);
    try {
      await instantiateAgentTemplate(activeSpaceId, creds, { template_id: t.id, project_id: params.projectId });
      setTemplatePickerOpen(false);
      show(`${t.name} added to this project`);
      void refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't add this agent");
    } finally {
      setInstantiating(false);
    }
  }

  async function handleNewThread() {
    if (!creds) return;
    setCreating(true);
    try {
      const created = await createThread(activeSpaceId, creds, { project_id: params.projectId, title: "New thread" });
      // Open it. Creating a thread and being left staring at the same list is a dead end — the
      // point of making one is to start working in it.
      router.push(`/p/${product.slug}/projects/${params.projectId}/threads/${created.id}`);
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

  // Step 13b: upload a FILE into the project KB, not just paste text. Reads a text-readable file
  // and pre-fills the title (from the filename) + content, then the person clicks Add. Same
  // text-only/2MB guard as the space-wide Knowledge Base page (real PDF/office parsing is a
  // separate, larger pipeline feature — a binary is rejected rather than ingested as garbage).
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  async function handlePickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      show("File is over 2MB — paste the relevant part instead, or upload a smaller file.");
      return;
    }
    try {
      const text = await file.text();
      if (!/\S/.test(text)) {
        show("That file has no readable text (it may be a PDF/image/binary — paste the text instead).");
        return;
      }
      if (!newDocTitle.trim()) setNewDocTitle(file.name.replace(/\.[^.]+$/, ""));
      setNewDocContent(text);
    } catch {
      show("Couldn't read that file.");
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

  const lastActivityAt = threads.length > 0
    ? threads.reduce((latest, t) => (t.updated_at > latest ? t.updated_at : latest), threads[0]!.updated_at)
    : null;
  const visibleThreads = threadQuery.trim()
    ? threads.filter((t) => (t.title ?? "Untitled thread").toLowerCase().includes(threadQuery.trim().toLowerCase()))
    : threads;

  return (
    <div className="spaces-layout">
      {/* Left: project tree nav — the mockup's #projects-view left rail (quick-switch between
          this space's projects without leaving the detail view), plus space-wide shortcuts to
          Agent Library / Knowledge Base. Thread counts are shown ONLY for the currently open
          project (the one count already fetched here) — fetching every OTHER project's thread
          count just to populate this rail would be an N+1 for a cosmetic number, so those are
          left off rather than fabricated or paid for. */}
      <div className="spaces-sidebar">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px 6px" }}>
          <span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--text3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>
            Projects
          </span>
        </div>
        {allProjects.map((p) => (
          <Link
            key={p.id}
            href={`/p/${product.slug}/projects/${p.id}`}
            className={`space-tree-item${p.id === params.projectId ? " active" : ""}`}
            style={{ textDecoration: "none" }}
          >
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor"><path d="M2 4H6L7 5H14V13H2V4Z" /></svg>
            {p.name}
            {p.id === params.projectId && <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text3)" }}>{threads.length}</span>}
          </Link>
        ))}
        <div style={{ padding: "4px 10px", marginTop: 4 }}>
          <div style={{ height: 1, background: "var(--border)" }} />
        </div>
        <div style={{ padding: "10px 14px 4px", fontSize: 10.5, fontWeight: 500, color: "var(--text3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>
          Agents in Space
        </div>
        <Link href={`/p/${product.slug}/agents`} className="space-tree-item" style={{ textDecoration: "none" }}>
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /><circle cx="6" cy="7" r="1" /><circle cx="10" cy="7" r="1" /><path d="M6 10C6 10 7 11 10 10" /></svg>
          Agent Library
        </Link>
        <Link href={`/p/${product.slug}/knowledge`} className="space-tree-item" style={{ textDecoration: "none" }}>
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor"><path d="M3 3H9L13 7V13H3V3Z" /><polyline points="9,3 9,7 13,7" /></svg>
          Knowledge Base
        </Link>
      </div>

      {/* Right: project content (unchanged from the prior single-pane layout, just re-parented
          under spaces-content instead of page-view — same padding/scroll behavior). */}
      <div className="spaces-content">
      {/* Breadcrumb: Business > Project (mockup's #projects-back-label). */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16, fontSize: 12, color: "var(--text3)" }}>
        <Link href={`/p/${product.slug}/spaces/${activeSpaceId}`} style={{ color: "var(--text2)", textDecoration: "none" }}>
          {activeSpaceName ?? "Business"}
        </Link>
        <span>›</span>
        <span style={{ color: "var(--text)", fontWeight: 500 }}>{project.name}</span>
      </div>

      <div className="page-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div className="page-title">{project.name}</div>
          <div className="page-subtitle">
            {project.description ? `${project.description} · ` : ""}
            {threads.length} thread{threads.length === 1 ? "" : "s"}
            {lastActivityAt ? ` · Last active ${relativeTime(lastActivityAt)}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => settingsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor" width={12} height={12}>
              <circle cx="8" cy="8" r="2.5" /><path d="M8 1V2.5M8 13.5V15M1 8H2.5M13.5 8H15" />
            </svg>
            Settings
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleNewThread} disabled={creating}>
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor" width={12} height={12}>
              <line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" />
            </svg>
            {creating ? "Creating…" : "New Thread"}
          </button>
        </div>
      </div>

      {/* F-40: the kind-specific panel (wallet ledger, etc.) + F-39 files viewer, above the shared
          shell's generic Settings/Threads/KB scaffolding. */}
      {creds && <ProjectKindPanel project={project} spaceId={activeSpaceId} creds={creds} />}

      {/* Step 21: the customer-bot Automation dashboard — no-code "when a message matches X, do Y"
          rules, shown only on a customer_bot project (project.kind is refreshed after a settings
          save, so switching a project to Customer bot and saving surfaces it). */}
      {creds && project.kind === "customer_bot" && (
        <CustomerBotAutomation spaceId={activeSpaceId} projectId={project.id} creds={creds} />
      )}

      {/* Real data only — no fabricated "credits used" tile the way the mockup's equivalent had. */}
      <div className="grid-4">
        <Card interactive={false}>
          <CardLabel>Threads</CardLabel>
          <CardValue>{threads.length}</CardValue>
        </Card>
        <Card interactive={false}>
          <CardLabel>Agents</CardLabel>
          <CardValue>{agents.length}</CardValue>
        </Card>
        <Card interactive={false}>
          <CardLabel>Default agent</CardLabel>
          <CardValue><span style={{ fontSize: 14 }}>{agents.find((a) => a.id === project.default_agent_id)?.name ?? "Space default"}</span></CardValue>
        </Card>
        <Card interactive={false}>
          <CardLabel>Last activity</CardLabel>
          <CardValue><span style={{ fontSize: 16 }}>{lastActivityAt ? relativeTime(lastActivityAt) : "—"}</span></CardValue>
        </Card>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div className="section-label" style={{ margin: 0 }}>Threads</div>
        {threads.length > 0 && (
          <div className="search-bar" style={{ margin: 0, maxWidth: 220, padding: "5px 10px" }}>
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor"><circle cx="7" cy="7" r="4.5" /><line x1="10.5" y1="10.5" x2="14" y2="14" /></svg>
            <input type="text" placeholder="Search threads…" value={threadQuery} onChange={(e) => setThreadQuery(e.target.value)} style={{ fontSize: 12 }} />
          </div>
        )}
      </div>
      {threads.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13, marginBottom: 24 }}>No threads yet.</p>
      ) : visibleThreads.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13, marginBottom: 24 }}>No threads match &ldquo;{threadQuery}&rdquo;.</p>
      ) : (
        <div style={{ marginBottom: 24 }}>
          {visibleThreads.map((t) => (
            <Link key={t.id} href={`/p/${product.slug}/projects/${params.projectId}/threads/${t.id}`} style={{ textDecoration: "none" }}>
              <div className="workflow-item">
                <div className="workflow-icon">
                  <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="var(--accent)" width={14} height={14}>
                    <path d="M4 2H10L13 5V14H4V2Z" /><polyline points="10,2 10,5 13,5" />
                  </svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="workflow-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.title ?? "Untitled thread"}
                  </div>
                  <div className="workflow-meta">{relativeTime(t.updated_at)}</div>
                </div>
                <span className={`badge${STATUS_BADGE[t.status] ? ` badge-${STATUS_BADGE[t.status]}` : ""}`} style={STATUS_BADGE[t.status] ? undefined : { background: "var(--surface2)", color: "var(--text3)" }}>
                  {STATUS_BADGE[t.status] === "green" && <span className="badge-dot" />}
                  {t.status}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      <div className="section-label">Agents in this project</div>
      {agents.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13, marginBottom: 24 }}>
          No agents installed in this space yet — your assistant can set one up when you ask.
        </p>
      ) : (
        <div className="grid-3">
          {agents.map((a) => (
            <div key={a.id} className="card agent-card">
              <div className="card-icon">
                <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="var(--accent)"><rect x="3" y="3" width="10" height="10" rx="2" /><circle cx="6" cy="7" r="1" /><circle cx="10" cy="7" r="1" /><path d="M6 10C6 10 7 11 10 10" /></svg>
              </div>
              <div className="card-title">{a.name ?? a.id}</div>
              {a.description && <div className="card-desc">{a.description}</div>}
              {a.id === project.default_agent_id && (
                <div style={{ marginTop: 8 }}>
                  <span className="badge badge-green"><span className="badge-dot" />Default</span>
                </div>
              )}
              {creds && (
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <AgentPolicyPanel spaceId={activeSpaceId} agentId={a.id} session={creds} canEdit />
                  <Link
                    href={`/p/${product.slug}/agents/${encodeURIComponent(a.id)}`}
                    style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none" }}
                  >
                    All settings →
                  </Link>
                </div>
              )}
            </div>
          ))}
          <button
            type="button"
            className="card"
            onClick={() => void openTemplatePicker()}
            style={{ borderStyle: "dashed", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6, minHeight: 90, cursor: "pointer", font: "inherit" }}
          >
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="var(--accent)" width={16} height={16}><path d="M8 3.5v9M3.5 8h9" /></svg>
            <div style={{ fontSize: 12, color: "var(--accent)" }}>Add agent from template</div>
          </button>
          <Link href={`/p/${product.slug}/agents`} className="card" style={{ borderStyle: "dashed", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6, minHeight: 90, textDecoration: "none" }}>
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="var(--text3)" width={16} height={16}><circle cx="8" cy="8" r="6" /></svg>
            <div style={{ fontSize: 12, color: "var(--text3)" }}>View all agents</div>
          </Link>
        </div>
      )}

      <Modal open={templatePickerOpen} onClose={() => setTemplatePickerOpen(false)} title="Add an agent from a template">
        <p style={{ fontSize: 12.5, color: "var(--text3)", margin: "0 0 12px" }}>
          Each template is a real, distinct configuration — tool list, autonomy, and vertical
          instructions — not a label on the same generic agent. It joins this project's agent
          switcher immediately.
        </p>
        {templatesLoading ? (
          <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
        ) : (
          <div className="app-grid">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                className="card app-card"
                disabled={instantiating}
                onClick={() => void handleAddFromTemplate(t)}
                style={{ textAlign: "left", cursor: instantiating ? "default" : "pointer", font: "inherit" }}
              >
                <div className="app-card-header">
                  <div className="app-card-initial">{t.name.slice(0, 1)}</div>
                  <CardTitle>{t.name}</CardTitle>
                </div>
                <CardDesc>{t.description}</CardDesc>
                <span className="app-card-tag">{t.category}</span>
              </button>
            ))}
          </div>
        )}
      </Modal>

      <div className="section-label" ref={settingsRef} style={{ marginTop: 24, scrollMarginTop: 16 }}>Settings</div>
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
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Button size="sm" disabled={addingDoc}>
            {addingDoc ? "Adding…" : "Add document"}
          </Button>
          <input ref={fileInputRef} type="file" accept=".txt,.md,.csv,.json,.html,.xml,.log,text/*" style={{ display: "none" }} onChange={handlePickFile} />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => fileInputRef.current?.click()}
            style={{ fontSize: 12.5 }}
          >
            Upload a file instead
          </button>
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
    </div>
  );
}
