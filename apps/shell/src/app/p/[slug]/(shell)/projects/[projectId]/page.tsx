"use client";


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

import { AgentPolicyPanel } from "@/components/AgentPolicyPanel";
import { AssistantSidePanelBody } from "@/components/AssistantSidePanels";
import { ProjectKindPanel } from "@/components/ProjectKindPanel";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useProduct } from "@/lib/product-context";
import { relativeTime } from "@/lib/relativeTime";
import {
  associateProjectDepartment,
  createDepartment,
  createKbDocument,
  createThread,
  deleteKbDocument,
  getProject,
  getProjectUsageSummary,
  instantiateAgentTemplate,
  listAgentDefinitions,
  listAgentTemplates,
  listExternalKnowledgePublications,
  listDepartments,
  listKbDocuments,
  listProjectDepartments,
  listProjects,
  listThreads,
  publishExternalKnowledge,
  unpublishExternalKnowledge,
  updateProject,
  type AgentDefinitionSummary,
  type AgentTemplateSummary,
  type DepartmentOption,
  type ExternalKnowledgePublication,
  type KbDocument,
  type Project,
  type ProjectDepartment,
  type ProjectUsageSummary,
  type ThreadSummary,
} from "@/lib/api";
import { Button, Card, CardDesc, CardLabel, CardTitle, CardValue, FormInput, FormSelect, FormTextarea, Modal, Toast, useToast } from "@naelao/ui";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

const STATUS_BADGE: Record<string, "green" | "amber" | "blue" | undefined> = {
  active: "green",
  archived: undefined,
};

function usagePayerLabel(payer: string): string {
  switch (payer) {
    case "space_wallet": return "Project wallet";
    case "consumer_credits": return "User credits";
    case "plan_quota": return "Space plan";
    case "platform": return "Platform";
    case "legacy": return "Legacy event";
    default: return "Payer not assigned";
  }
}

export default function ProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const product = useProduct();
  const { activeSpaceId, activeSpaceName } = useActiveSpace();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const [project, setProject] = React.useState<Project | null>(null);
  const [allProjects, setAllProjects] = React.useState<Project[]>([]);
  const [departments, setDepartments] = React.useState<ProjectDepartment[]>([]);
  const [departmentOptions, setDepartmentOptions] = React.useState<DepartmentOption[]>([]);
  const [departmentLoadError, setDepartmentLoadError] = React.useState(false);
  const [departmentBusy, setDepartmentBusy] = React.useState(false);
  const [departmentToAdd, setDepartmentToAdd] = React.useState("");
  const [newDepartmentName, setNewDepartmentName] = React.useState("");
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [usageSummary, setUsageSummary] = React.useState<ProjectUsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = React.useState(true);
  const [usageError, setUsageError] = React.useState(false);
  const [usageDays, setUsageDays] = React.useState(30);
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
  const [externalPublications, setExternalPublications] = React.useState<ExternalKnowledgePublication[]>([]);
  const [publicationId, setPublicationId] = React.useState("course_material");
  const [publicationName, setPublicationName] = React.useState("Course material");
  const [publishedDocumentIds, setPublishedDocumentIds] = React.useState<string[]>([]);
  const [savingPublication, setSavingPublication] = React.useState(false);
  const [publicationLoadError, setPublicationLoadError] = React.useState(false);

  // Editable project policy (execution ceiling,
  // spend cap, max threads, agent bindings) — PATCH succeeds for an admin/owner in the target
  // business; the settings section is still shown to a plain member (read-only save attempt
  // will surface the 403 via toast rather than pre-computing role client-side).
  const [savingSettings, setSavingSettings] = React.useState(false);
  const [draftMaxThreads, setDraftMaxThreads] = React.useState("0");
  const [draftExecutionCeiling, setDraftExecutionCeiling] = React.useState("5");
  const [draftSpendCap, setDraftSpendCap] = React.useState("0");
  const [draftExternalDailyMessageCap, setDraftExternalDailyMessageCap] = React.useState("0");
  const [draftDefaultAgentId, setDraftDefaultAgentId] = React.useState("");

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  React.useEffect(() => {
    let current = true;
    setUsageSummary(null);
    setUsageError(false);
    if (!creds) {
      setUsageLoading(false);
      return () => { current = false; };
    }
    setUsageLoading(true);
    void getProjectUsageSummary(activeSpaceId, params.projectId, creds, usageDays)
      .then((summary) => { if (current) setUsageSummary(summary); })
      .catch(() => { if (current) setUsageError(true); })
      .finally(() => { if (current) setUsageLoading(false); });
    return () => { current = false; };
  }, [activeSpaceId, params.projectId, session, usageDays]);

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    setProject(null);
    setThreads([]);
    setAgents([]);
    setAllProjects([]);
    setDepartments([]);
    setDepartmentOptions([]);
    try {
      const [p, t, a, allP, projectDepartments, options] = await Promise.all([
        getProject(activeSpaceId, params.projectId, creds),
        listThreads(activeSpaceId, creds, { projectId: params.projectId, includeSubThreads: true }),
        listAgentDefinitions(activeSpaceId, creds).catch(() => []),
        listProjects(activeSpaceId, creds).catch(() => []),
        listProjectDepartments(activeSpaceId, params.projectId, creds).catch(() => null),
        listDepartments(activeSpaceId, creds).catch(() => null),
      ]);
      setProject(p);
      setThreads(t);
      setAgents(a);
      setAllProjects(allP);
      setDepartments(projectDepartments ?? []);
      setDepartmentOptions((options ?? []).filter((option) => option.depth === 1 && option.parent_id === activeSpaceId && option.status === "active"));
      setDepartmentLoadError(projectDepartments === null || options === null);
      setDraftMaxThreads(String(p.max_threads ?? 0));
      setDraftExecutionCeiling(String(p.execution_ceiling ?? 5));
      setDraftSpendCap(String(p.daily_spend_cap_credits ?? 0));
      setDraftExternalDailyMessageCap(String(p.external_daily_message_cap ?? 0));
      setDraftDefaultAgentId(p.default_agent_id ?? "");
    } catch {
      show("Couldn't load project");
      setDepartmentLoadError(true);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, params.projectId, session]);

  const selectedDepartmentId = searchParams.get("departmentId");
  React.useEffect(() => {
    if (!loading && !departmentLoadError && selectedDepartmentId && !departments.some((department) => department.id === selectedDepartmentId)) {
      setDepartmentLoadError(true);
      const next = new URLSearchParams(searchParams.toString());
      next.delete("departmentId");
      router.replace(`?${next.toString()}`);
    }
  }, [departments, departmentLoadError, selectedDepartmentId, searchParams, router, loading]);

  async function attachDepartment(departmentId: string) {
    if (!creds || !departmentId || departmentBusy) return;
    setDepartmentBusy(true);
    try {
      await associateProjectDepartment(activeSpaceId, params.projectId, departmentId, creds);
      await refresh();
      const next = new URLSearchParams(searchParams.toString());
      next.set("departmentId", departmentId);
      router.push(`?${next.toString()}`);
    } catch (error) {
      show(error instanceof Error ? error.message : "Couldn't add department");
    } finally {
      setDepartmentBusy(false);
    }
  }

  async function createAndAttachDepartment() {
    if (!creds || !newDepartmentName.trim() || departmentBusy) return;
    setDepartmentBusy(true);
    try {
      const department = await createDepartment(activeSpaceId, newDepartmentName.trim(), creds);
      await associateProjectDepartment(activeSpaceId, params.projectId, department.id, creds);
      setNewDepartmentName("");
      await refresh();
      const next = new URLSearchParams(searchParams.toString()); next.set("departmentId", department.id);
      router.push(`?${next.toString()}`);
    } catch (error) {
      show(error instanceof Error ? error.message : "Couldn't create department");
      await refresh();
    } finally {
      setDepartmentBusy(false);
    }
  }

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

  const refreshExternalKnowledge = React.useCallback(async () => {
    if (!creds) return;
    setPublicationLoadError(false);
    try {
      const records = await listExternalKnowledgePublications(activeSpaceId, params.projectId, creds);
      setExternalPublications(records);
    } catch {
      setPublicationLoadError(true);
    }
  }, [activeSpaceId, params.projectId, session]);

  React.useEffect(() => {
    void refresh();
    void refreshDocs();
    void refreshExternalKnowledge();
  }, [refresh, refreshDocs, refreshExternalKnowledge]);

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
      router.push(`/p/${product.slug}/threads/${created.id}`);
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
        max_threads: Number(draftMaxThreads) || 0,
        execution_ceiling: Number(draftExecutionCeiling) || 1,
        daily_spend_cap_credits: Number(draftSpendCap) || 0,
        external_daily_message_cap: Number(draftExternalDailyMessageCap) || 0,
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
      await refreshExternalKnowledge();
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
      await refreshExternalKnowledge();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to delete document");
    }
  }

  async function handleSaveExternalPublication(e: React.FormEvent) {
    e.preventDefault();
    if (!creds || !publicationId.trim() || !publicationName.trim() || savingPublication) return;
    setSavingPublication(true);
    try {
      await publishExternalKnowledge(activeSpaceId, params.projectId, publicationId.trim(), creds, {
        name: publicationName.trim(), document_ids: publishedDocumentIds,
      });
      show("Published Knowledge collection updated");
      await refreshExternalKnowledge();
    } catch (error) {
      show(error instanceof Error ? error.message : "Couldn't publish this Knowledge collection");
    } finally {
      setSavingPublication(false);
    }
  }

  async function handleUnpublishExternalCollection(id: string) {
    if (!creds) return;
    try {
      await unpublishExternalKnowledge(activeSpaceId, params.projectId, id, creds);
      setExternalPublications(items => items.filter(item => item.id !== id));
      if (publicationId === id) setPublishedDocumentIds([]);
      show("Knowledge collection unpublished");
    } catch (error) {
      show(error instanceof Error ? error.message : "Couldn't unpublish this Knowledge collection");
    }
  }

  function editExternalCollection(publication: ExternalKnowledgePublication) {
    setPublicationId(publication.id);
    setPublicationName(publication.name);
    setPublishedDocumentIds(publication.document_ids);
  }

  if (loading) return <div className="page-view">Loading…</div>;
  if (!project) return <div className="page-view">Project not found.</div>;

  const lastActivityAt = threads.length > 0
    ? threads.reduce((latest, t) => (t.updated_at > latest ? t.updated_at : latest), threads[0]!.updated_at)
    : null;
  const visibleThreads = threadQuery.trim()
    ? threads.filter((t) => (t.title ?? "Untitled thread").toLowerCase().includes(threadQuery.trim().toLowerCase()))
    : threads;
  const threadTiers = [
    { id: "tier_1_team", label: "Team room", description: project?.visibility === "public" ? "Public to every project member" : "Available to project members" },
    { id: "tier_2_task", label: "Task threads", description: "Shared work and deliverables" },
    { id: "tier_3_consult", label: "Worker consultations", description: "Worker and specialist collaboration" },
    { id: "tier_4_scratchpad", label: "Private scratchpads", description: "Visible only to their creator" },
  ] as const;

  return (
    <div className="spaces-layout">
      {/* Left: project tree nav — the mockup's #projects-view left rail (quick-switch between
          this space's projects without leaving the detail view), plus space-wide shortcuts to
          Worker Library / Knowledge Base. Thread counts are shown ONLY for the currently open
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
          Workers in Space
        </div>
        <Link href={`/p/${product.slug}/agents`} className="space-tree-item" style={{ textDecoration: "none" }}>
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /><circle cx="6" cy="7" r="1" /><circle cx="10" cy="7" r="1" /><path d="M6 10C6 10 7 11 10 10" /></svg>
          Worker Library
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

      <section aria-label="Project departments" style={{ margin: "0 0 20px", padding: 14, border: "1px solid var(--border)", borderRadius: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Departments</div>
        {departmentLoadError ? <output style={{ color: "var(--text3)", fontSize: 12 }}>Department links are unavailable. Refresh to try again.</output> : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className={`btn btn-sm ${selectedDepartmentId ? "btn-ghost" : "btn-secondary"}`} onClick={() => {
                const next = new URLSearchParams(searchParams.toString()); next.delete("departmentId");
                router.push(`?${next.toString()}`);
              }}>All project context</button>
              {departments.map((department) => {
                const next = new URLSearchParams(searchParams.toString()); next.set("departmentId", department.id);
                return <button key={department.id} type="button" className={`btn btn-sm ${selectedDepartmentId === department.id ? "btn-secondary" : "btn-ghost"}`} aria-pressed={selectedDepartmentId === department.id} onClick={() => router.push(`?${next.toString()}`)}>
                  {department.name}{department.is_primary ? " · Primary" : ""}
                </button>;
              })}
              {departments.length === 0 && <span style={{ fontSize: 12, color: "var(--text3)" }}>No department is linked to this project.</span>}
            </div>
            {selectedDepartmentId && <div style={{ marginTop: 8, fontSize: 12, color: "var(--text3)" }}>
              Department selected: {departments.find((department) => department.id === selectedDepartmentId)?.name}. Project identity and its data remain shared across its linked departments.
              {departments.some((department) => department.id === selectedDepartmentId) && <Link href={`/p/${product.slug}/spaces/${activeSpaceId}/departments/${encodeURIComponent(selectedDepartmentId)}`} style={{ marginLeft: 8, color: "var(--accent)" }}>Open department projects →</Link>}
            </div>}
            {departmentOptions.some((option) => !departments.some((department) => department.id === option.id)) && (
              <form style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }} onSubmit={(event) => { event.preventDefault(); void attachDepartment(departmentToAdd); }}>
                <label htmlFor="project-department-add" style={{ fontSize: 12, color: "var(--text2)" }}>Link another department</label>
                <select id="project-department-add" value={departmentToAdd} onChange={(event) => setDepartmentToAdd(event.target.value)} style={{ maxWidth: 240 }}>
                  <option value="">Choose a department</option>
                  {departmentOptions.filter((option) => !departments.some((department) => department.id === option.id)).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select>
                <button type="submit" className="btn btn-secondary btn-sm" disabled={!departmentToAdd || departmentBusy}>{departmentBusy ? "Linking…" : "Link department"}</button>
              </form>
            )}
            <form style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }} onSubmit={(event) => { event.preventDefault(); void createAndAttachDepartment(); }}>
              <label htmlFor="project-department-new" style={{ fontSize: 12, color: "var(--text2)" }}>Create a department</label>
              <input id="project-department-new" value={newDepartmentName} onChange={(event) => setNewDepartmentName(event.target.value)} maxLength={120} placeholder="Department name" style={{ maxWidth: 240 }} />
              <button type="submit" className="btn btn-secondary btn-sm" disabled={!newDepartmentName.trim() || departmentBusy}>{departmentBusy ? "Creating…" : "Create and link"}</button>
            </form>
          </>
        )}
      </section>

      {/* F-40: the kind-specific panel (wallet ledger, etc.) + F-39 files viewer, above the shared
          shell's generic Settings/Threads/KB scaffolding. */}
      {creds && <ProjectKindPanel project={project} spaceId={activeSpaceId} creds={creds} />}

      {session && <section className="settings-block" style={{ marginTop: 24, padding: 16 }}>
        <div className="section-label" style={{ marginTop: 0 }}>Project extensions and channels</div>
        <p style={{ color: "var(--text3)", fontSize: 13, margin: "0 0 12px" }}>
          External conversations run through installed, project-scoped extensions. They do not open or act as internal Project Bot threads.
        </p>
        <AssistantSidePanelBody
          tab="channels"
          spaceId={activeSpaceId}
          projectId={project.id}
          session={creds!}
          isBusinessSpace={activeSpaceId !== product.space_id}
        />
      </section>}

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
          <CardLabel>Project Bot planner</CardLabel>
          <CardValue><span style={{ fontSize: 14 }}>{agents.find((a) => a.id === project.default_agent_id)?.name ?? "Project Bot default"}</span></CardValue>
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
        <div style={{ marginBottom: 24, display: "grid", gap: 16 }}>
          {threadTiers.map((tier) => {
            const rows = visibleThreads.filter((thread) => (thread.thread_tier ?? "tier_2_task") === tier.id);
            return <section key={tier.id} className="settings-block" style={{ padding: 12 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}><strong style={{ fontSize: 13 }}>{tier.label}</strong><span style={{ fontSize: 10.5, color: "var(--text3)" }}>{tier.description}</span></div>{rows.length === 0 ? <p style={{ color: "var(--text3)", fontSize: 12, margin: 0 }}>No {tier.label.toLowerCase()}.</p> : rows.map((t) => (
            <Link key={t.id} href={`/p/${product.slug}/threads/${t.id}`} style={{ textDecoration: "none" }}>
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
          ))}</section>;
          })}
        </div>
      )}

      <div className="section-label">Workers in this project</div>
      {agents.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13, marginBottom: 24 }}>
          No workers installed in this space yet — your assistant can set one up when you ask.
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
                  <span className="badge badge-green"><span className="badge-dot" />Project Bot planner</span>
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
            <div style={{ fontSize: 12, color: "var(--accent)" }}>Add worker from template</div>
          </button>
          <Link href={`/p/${product.slug}/agents`} className="card" style={{ borderStyle: "dashed", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6, minHeight: 90, textDecoration: "none" }}>
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="var(--text3)" width={16} height={16}><circle cx="8" cy="8" r="6" /></svg>
            <div style={{ fontSize: 12, color: "var(--text3)" }}>View all workers</div>
          </Link>
        </div>
      )}

      <Modal open={templatePickerOpen} onClose={() => setTemplatePickerOpen(false)} title="Add a worker from a template">
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
            <div className="settings-row-label">Project type</div>
            <div className="settings-row-sub">Projects are generic workspaces. Templates and extensions configure their capabilities.</div>
          </div>
          <span style={{ color: "var(--text2)", fontSize: 13 }}>Workspace</span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Project Bot planner</div>
            <div className="settings-row-sub">The project-scoped planner used by new project threads by default</div>
          </div>
          <FormSelect value={draftDefaultAgentId} onChange={(e) => setDraftDefaultAgentId(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">Project Bot default</option>
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
            <div className="settings-row-sub">Tier 1-6 script execution ladder cap for this project</div>
          </div>
          <FormInput
            type="number"
            min={1}
              max={6}
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
          <div>
            <div className="settings-row-label">Daily external messages per person and provider</div>
            <div className="settings-row-sub">Shared across every extension instance in this project; 0 = unlimited</div>
          </div>
          <FormInput
            type="number"
            min={0}
            max={10000}
            value={draftExternalDailyMessageCap}
            onChange={(e) => setDraftExternalDailyMessageCap(e.target.value)}
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
        <div className="section-label" style={{ marginBottom: 0 }}>Project usage</div>
        <label style={{ fontSize: 12, color: "var(--text2)" }}>
          Period{" "}
          <select aria-label="Project usage period" value={usageDays} onChange={(event) => setUsageDays(Number(event.target.value))}>
            <option value={1}>Last 24 hours</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>
      </div>
      <section aria-label="Project usage summary" className="settings-block" style={{ padding: 16 }}>
        {usageLoading ? <p role="status" style={{ color: "var(--text3)", margin: 0 }}>Loading project usage…</p> : usageError ? (
          <p role="status" style={{ color: "var(--text3)", margin: 0 }}>Usage details are available to project admins. If you are an admin, refresh to try again.</p>
        ) : !usageSummary || usageSummary.event_count === 0 ? (
          <p style={{ color: "var(--text3)", margin: 0 }}>No measured project usage in this period.</p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 14 }}>
              <div><div className="settings-row-label">Priced usage</div><strong>{usageSummary.cost_credits.toLocaleString()} credits</strong></div>
              <div><div className="settings-row-label">Recorded events</div><strong>{usageSummary.event_count.toLocaleString()}</strong></div>
              {usageSummary.unpriced_event_count > 0 && <div><div className="settings-row-label">Unpriced events</div><strong>{usageSummary.unpriced_event_count.toLocaleString()}</strong></div>}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {usageSummary.breakdown.map((item, index) => (
                <div key={`${item.event_type}:${item.payer_kind}:${item.installation_id ?? ""}:${item.provider ?? item.connector_provider ?? ""}:${index}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{item.event_type.replaceAll("_", " ")} · {usagePayerLabel(item.payer_kind)}</div>
                    <div style={{ fontSize: 11, color: "var(--text3)" }}>
                      {item.quantity.toLocaleString()} {item.unit} · {item.event_count} event{item.event_count === 1 ? "" : "s"}
                      {item.provider ? ` · ${item.provider}` : ""}{item.connector_provider ? ` · ${item.connector_provider}` : ""}
                      {item.installation_id ? ` · installation ${item.installation_id}` : ""}
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: item.cost_credits === null ? "var(--text3)" : "var(--text)" }}>
                    {item.cost_credits === null ? `Unpriced (${item.unpriced_event_count} events)` : `${item.cost_credits.toLocaleString()} credits`}
                  </span>
                </div>
              ))}
            </div>
            {usageSummary.breakdown.length === 200 && <p style={{ fontSize: 11, color: "var(--text3)", margin: "10px 0 0" }}>Showing the 200 largest usage groups; the totals above include all recorded events.</p>}
          </>
        )}
      </section>

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

      <div className="page-header" style={{ marginTop: 24 }}>
        <div className="section-label" style={{ marginBottom: 0 }}>External extension Knowledge</div>
        <div className="page-subtitle">
          Select indexed project documents to publish as a named collection. Only a channel extension explicitly configured for this collection can retrieve it; publishing does not connect a provider or enable a bot.
        </div>
      </div>
      {publicationLoadError ? (
        <div role="status" className="settings-block" style={{ padding: 12, color: "var(--text2)" }}>
          Couldn't load published collections. Check project access and try again.
        </div>
      ) : externalPublications.length > 0 ? (
        <div className="settings-block" aria-label="Published Knowledge collections">
          {externalPublications.map(publication => (
            <div className="settings-row" key={publication.id}>
              <div>
                <div className="settings-row-label">{publication.name}</div>
                <div className="settings-row-sub">{publication.id} · {publication.document_count} published document{publication.document_count === 1 ? "" : "s"}</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button size="sm" variant="ghost" onClick={() => editExternalCollection(publication)}>Edit</Button>
                <Button size="sm" variant="ghost" onClick={() => void handleUnpublishExternalCollection(publication.id)}>Unpublish</Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>No documents are published for external extensions.</p>
      )}
      <form onSubmit={handleSaveExternalPublication} className="settings-block" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="settings-row-label">Publish a collection</div>
        <FormInput aria-label="Stable collection ID" placeholder="course_material" value={publicationId} onChange={event => setPublicationId(event.target.value)} required />
        <FormInput aria-label="Collection name" placeholder="Course material" value={publicationName} onChange={event => setPublicationName(event.target.value)} required />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {docs.filter(document => document.status === "indexed").map(document => (
            <label key={document.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={publishedDocumentIds.includes(document.id)}
                onChange={event => setPublishedDocumentIds(ids => event.target.checked ? [...new Set([...ids, document.id])] : ids.filter(id => id !== document.id))}
              />
              <span>{document.title}</span>
            </label>
          ))}
          {!docsLoading && docs.every(document => document.status !== "indexed") && (
            <span style={{ color: "var(--text3)", fontSize: 13 }}>Indexed documents will appear here. New or processing files cannot be published yet.</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Button size="sm" disabled={savingPublication || docsLoading}>
            {savingPublication ? "Saving…" : "Save published collection"}
          </Button>
          <span style={{ color: "var(--text3)", fontSize: 12 }}>Owner or admin permission required. An empty selection revokes all documents in this collection.</span>
        </div>
      </form>

      <Toast toast={toast} />
      </div>
    </div>
  );
}
