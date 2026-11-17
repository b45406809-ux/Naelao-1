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
import { ManagedRuntimeProfilesPanel } from "@/components/ManagedRuntimeProfilesPanel";
import { ProjectComputersPanel } from "@/components/ProjectComputersPanel";
import { ProjectCoordinationProposalPanel } from "@/components/ProjectCoordinationProposalPanel";
import { ProjectKindPanel } from "@/components/ProjectKindPanel";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useProduct } from "@/lib/product-context";
import { relativeTime } from "@/lib/relativeTime";
import {
  associateProjectDepartment,
  createDepartment,
  createKbDocument,
  applyWebsiteKnowledgeRefresh,
  setWebsiteKnowledgeRefreshSchedule,
  previewKbPdf,
  previewWebsiteKnowledgeSource,
  previewWebsiteKnowledgeCrawl,
  createThread,
  deleteKbDocument,
  getExternalKnowledgePublicationSources,
  getProject,
  getProjectUsageSummary,
  getWebsiteKnowledgeCrawlCapability,
  getWebsiteKnowledgeCrawlStatus,
  listAgentDefinitions,
  listWebsiteConnections,
  listExternalKnowledgePublicationEvents,
  listExternalKnowledgePublications,
  listSpaceTemplateInstallations,
  listSpaceSharedChannelKnowledge,
  listDepartments,
  listKbDocuments,
  listProjectDepartments,
  listProjects,
  listThreads,
  publishExternalKnowledge,
  setExternalKnowledgePublicationArchived,
  setSpaceSharedChannelKnowledge,
  unpublishExternalKnowledge,
  updateProject,
  type AgentDefinitionSummary,
  type DepartmentOption,
  type ExternalKnowledgePublicationEvent,
  type ExternalKnowledgePublication,
  type SpaceSharedChannelKnowledgeInstallation,
  type KbDocument,
  type Project,
  type ProjectDepartment,
  type ProjectUsageSummary,
  type ThreadSummary,
  type WebsiteConnection,
  type WebsiteKnowledgeCrawlResult,
  type WebsiteKnowledgePreview,
} from "@/lib/api";
import { knowledgeContentByteLength, PROJECT_KNOWLEDGE_MAX_CONTENT_BYTES } from "@/lib/knowledge-upload-limits";
import { readKnowledgePdfFile } from "@/lib/knowledge-pdf-preview";
import { KnowledgeCsvPreview } from "@/components/KnowledgeCsvPreview";
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
  const externalKnowledgeSetupRef = React.useRef<HTMLDivElement>(null);

  const [docs, setDocs] = React.useState<KbDocument[]>([]);
  const [docsLoading, setDocsLoading] = React.useState(true);
  const [newDocTitle, setNewDocTitle] = React.useState("");
  const [newDocContent, setNewDocContent] = React.useState("");
  const [csvPreviewActive, setCsvPreviewActive] = React.useState(false);
  const [xlsxPreviewActive, setXlsxPreviewActive] = React.useState(false);
  const [addingDoc, setAddingDoc] = React.useState(false);
  const [pdfPreview, setPdfPreview] = React.useState<{ base64: string; receipt: Awaited<ReturnType<typeof previewKbPdf>> } | null>(null);
  const [previewingPdf, setPreviewingPdf] = React.useState(false);
  const [websiteConnections, setWebsiteConnections] = React.useState<WebsiteConnection[]>([]);
  const [websiteConnectionId, setWebsiteConnectionId] = React.useState("");
  const [websiteSourceUrl, setWebsiteSourceUrl] = React.useState("");
  const [websitePreview, setWebsitePreview] = React.useState<WebsiteKnowledgePreview | null>(null);
  const [previewingWebsite, setPreviewingWebsite] = React.useState(false);
  const [websiteCrawlAvailable, setWebsiteCrawlAvailable] = React.useState(false);
  const [websiteCrawlConcurrencyLimit, setWebsiteCrawlConcurrencyLimit] = React.useState(2);
  const [websiteCrawlTermsConfirmed, setWebsiteCrawlTermsConfirmed] = React.useState(false);
  const [websiteCrawl, setWebsiteCrawl] = React.useState<WebsiteKnowledgeCrawlResult | null>(null);
  const [crawlingWebsite, setCrawlingWebsite] = React.useState(false);
  const [websiteRefreshDraft, setWebsiteRefreshDraft] = React.useState<{ documentId: string; content: string; preview: WebsiteKnowledgePreview } | null>(null);
  const [refreshingWebsiteId, setRefreshingWebsiteId] = React.useState<string | null>(null);
  const [savingWebsiteScheduleId, setSavingWebsiteScheduleId] = React.useState<string | null>(null);
  const [websiteScheduleIntervals, setWebsiteScheduleIntervals] = React.useState<Record<string, 24 | 168>>({});
  const websiteRefreshRequestKeysRef = React.useRef(new Map<string, string>());
  const websiteCrawlRequestKeyRef = React.useRef<string | null>(null);
  const createIdempotencyKeyRef = React.useRef<string | null>(null);
  const [externalPublications, setExternalPublications] = React.useState<ExternalKnowledgePublication[]>([]);
  const [publicationId, setPublicationId] = React.useState("course_material");
  const [publicationName, setPublicationName] = React.useState("Course material");
  const [publishedDocumentIds, setPublishedDocumentIds] = React.useState<string[]>([]);
  const [savingPublication, setSavingPublication] = React.useState(false);
  const [publicationLoadError, setPublicationLoadError] = React.useState(false);
  const [loadingPublicationSources, setLoadingPublicationSources] = React.useState<string | null>(null);
  const [loadingPublicationHistory, setLoadingPublicationHistory] = React.useState<string | null>(null);
  const [publicationHistory, setPublicationHistory] = React.useState<{ publicationId: string; events: ExternalKnowledgePublicationEvent[] } | null>(null);
  const [sharedChannelKnowledge, setSharedChannelKnowledge] = React.useState<SpaceSharedChannelKnowledgeInstallation[]>([]);
  const [sharedChannelKnowledgeDrafts, setSharedChannelKnowledgeDrafts] = React.useState<Record<string, string[]>>({});
  const [sharedChannelKnowledgeLoadError, setSharedChannelKnowledgeLoadError] = React.useState(false);
  const [savingSharedKnowledge, setSavingSharedKnowledge] = React.useState<string | null>(null);

  // Editable project policy (execution ceiling,
  // spend cap, max threads, agent bindings) — PATCH succeeds for an admin/owner in the target
  // space; the settings section is still shown to a plain member (read-only save attempt
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

  React.useEffect(() => {
    let current = true;
    setWebsiteCrawlAvailable(false);
    setWebsiteCrawlConcurrencyLimit(2);
    if (!creds) return () => { current = false; };
    void getWebsiteKnowledgeCrawlCapability(activeSpaceId, params.projectId, creds)
      .then((capability) => { if (current) {
        setWebsiteCrawlAvailable(capability.available);
        setWebsiteCrawlConcurrencyLimit(capability.active_operations_per_tenant);
      } })
      .catch(() => { if (current) setWebsiteCrawlAvailable(false); });
    return () => { current = false; };
  }, [activeSpaceId, params.projectId, session]);

  React.useEffect(() => {
    let current = true;
    if (!creds || typeof window === "undefined") return () => { current = false; };
    const storageKey = `naelao:website-crawl:${activeSpaceId}:${params.projectId}`;
    const saved = window.sessionStorage.getItem(storageKey);
    if (!saved) return () => { current = false; };
    let receipt: { operationId?: unknown; idempotencyKey?: unknown; connectionId?: unknown };
    try { receipt = JSON.parse(saved) as typeof receipt; }
    catch { window.sessionStorage.removeItem(storageKey); return () => { current = false; }; }
    if (typeof receipt.operationId !== "string" || !/^[0-9a-f-]{36}$/i.test(receipt.operationId)
      || typeof receipt.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(receipt.idempotencyKey)
      || typeof receipt.connectionId !== "string" || !receipt.connectionId) {
      window.sessionStorage.removeItem(storageKey);
      return () => { current = false; };
    }
    websiteCrawlRequestKeyRef.current = receipt.idempotencyKey;
    setWebsiteConnectionId(receipt.connectionId);
    void getWebsiteKnowledgeCrawlStatus(activeSpaceId, params.projectId, receipt.operationId, creds)
      .then((status) => {
        if (!current) return;
        setWebsiteCrawl(status);
        const root = status.pages.find(page => page.depth === 0)?.requested_url;
        if (root) setWebsiteSourceUrl(root);
        if (!status.continuation_available) websiteCrawlRequestKeyRef.current = null;
      })
      .catch(() => {
        if (!current) return;
        window.sessionStorage.removeItem(storageKey);
        websiteCrawlRequestKeyRef.current = null;
      });
    return () => { current = false; };
  }, [activeSpaceId, params.projectId, session]);

  React.useEffect(() => {
    let current = true;
    if (!creds || typeof window === "undefined") return () => { current = false; };
    const storageKey = `naelao:website-crawl:${activeSpaceId}:${params.projectId}`;
    const saved = window.sessionStorage.getItem(storageKey);
    if (!saved) return () => { current = false; };
    let receipt: { operationId?: unknown; idempotencyKey?: unknown; connectionId?: unknown; rootUrl?: unknown };
    try { receipt = JSON.parse(saved) as typeof receipt; }
    catch { window.sessionStorage.removeItem(storageKey); return () => { current = false; }; }
    if (typeof receipt.operationId !== "string" || !/^[0-9a-f-]{36}$/i.test(receipt.operationId)
      || typeof receipt.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(receipt.idempotencyKey)
      || typeof receipt.connectionId !== "string" || !receipt.connectionId || typeof receipt.rootUrl !== "string") {
      window.sessionStorage.removeItem(storageKey);
      return () => { current = false; };
    }
    websiteCrawlRequestKeyRef.current = receipt.idempotencyKey;
    setWebsiteConnectionId(receipt.connectionId);
    setWebsiteSourceUrl(receipt.rootUrl);
    void getWebsiteKnowledgeCrawlStatus(activeSpaceId, params.projectId, receipt.operationId, creds)
      .then((status) => {
        if (!current) return;
        setWebsiteCrawl(status);
        const root = status.pages.find(page => page.depth === 0)?.requested_url;
        if (root) setWebsiteSourceUrl(root);
      })
      .catch(() => {
        if (!current) return;
        window.sessionStorage.removeItem(storageKey);
        websiteCrawlRequestKeyRef.current = null;
      });
    return () => { current = false; };
  }, [activeSpaceId, params.projectId, session]);

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
      show(error instanceof Error ? error.message : "Couldn't link subspace");
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
      show(error instanceof Error ? error.message : "Couldn't create subspace");
      await refresh();
    } finally {
      setDepartmentBusy(false);
    }
  }

  const refreshDocs = React.useCallback(async (showLoading = true) => {
    if (!creds) return;
    if (showLoading) setDocsLoading(true);
    try {
      setDocs(await listKbDocuments(activeSpaceId, creds, params.projectId));
    } catch {
      show("Couldn't load knowledge base");
    } finally {
      if (showLoading) setDocsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, params.projectId, session]);

  const refreshWebsiteConnections = React.useCallback(async () => {
    if (!creds) return;
    try {
      const connections = (await listWebsiteConnections(activeSpaceId, creds))
        .filter((connection) => connection.project_id === params.projectId);
      setWebsiteConnections(connections);
      setWebsiteConnectionId((current) => connections.some((connection) => connection.id === current)
        ? current : connections[0]?.id ?? "");
      setWebsiteSourceUrl((current) => current || connections[0]?.start_url || "");
    } catch {
      setWebsiteConnections([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, params.projectId, session]);

  const refreshExternalKnowledge = React.useCallback(async () => {
    if (!creds) return;
    setPublicationLoadError(false);
    setSharedChannelKnowledgeLoadError(false);
    const [publicationsResult, sharedKnowledgeResult, templateInstallationsResult] = await Promise.allSettled([
      listExternalKnowledgePublications(activeSpaceId, params.projectId, creds),
      listSpaceSharedChannelKnowledge(activeSpaceId, params.projectId, creds),
      listSpaceTemplateInstallations(activeSpaceId, creds),
    ]);
    const publications = publicationsResult.status === "fulfilled" ? publicationsResult.value : [];
    const installRecords = templateInstallationsResult.status === "fulfilled" ? templateInstallationsResult.value.installations : [];
    const activationSelections: Record<string, string[]> = {};
    for (const record of installRecords) {
      const selected = record.extension_requirements_review?.project_knowledge_selections?.[params.projectId];
      for (const [extensionId, publicationIds] of Object.entries(selected ?? {}))
        activationSelections[extensionId] = [...new Set([...(activationSelections[extensionId] ?? []), ...publicationIds])].sort();
    }
    if (publicationsResult.status === "fulfilled") setExternalPublications(publications);
    else {
      setExternalPublications([]);
      setPublicationLoadError(true);
    }
    if (sharedKnowledgeResult.status === "fulfilled") {
      const installationsByExtension = new Map<string, number>();
      for (const installation of sharedKnowledgeResult.value) installationsByExtension.set(installation.extension_id, (installationsByExtension.get(installation.extension_id) ?? 0) + 1);
      const installations = sharedKnowledgeResult.value.map(installation => ({ ...installation,
        ...(installationsByExtension.get(installation.extension_id) === 1 && activationSelections[installation.extension_id]?.length
          ? { activation_selected_publication_ids: activationSelections[installation.extension_id] } : {}) }));
      setSharedChannelKnowledge(installations);
      const currentPublications = new Set(publications.filter(publication => !publication.archived).map(publication => publication.id));
      setSharedChannelKnowledgeDrafts(Object.fromEntries(installations.map(installation => [installation.instance_id,
        (installation.configured ? installation.granted_publication_ids : installation.activation_selected_publication_ids ?? [])
          .filter(id => installation.declared_publication_ids.includes(id) && currentPublications.has(id)),
      ])));
    } else {
      setSharedChannelKnowledgeLoadError(true);
    }
  }, [activeSpaceId, params.projectId, session]);

  React.useEffect(() => {
    void refresh();
    void refreshDocs();
    void refreshWebsiteConnections();
    void refreshExternalKnowledge();
  }, [refresh, refreshDocs, refreshExternalKnowledge, refreshWebsiteConnections]);

  React.useEffect(() => {
    if (searchParams.get("setup") !== "knowledge") return;
    const timer = window.setTimeout(() => externalKnowledgeSetupRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
    return () => window.clearTimeout(timer);
  }, [searchParams, params.projectId]);

  React.useEffect(() => {
    if (!docs.some((document) => document.status === "deleting")) return;
    const timer = setInterval(() => { void refreshDocs(false); }, 5_000);
    return () => clearInterval(timer);
  }, [docs, refreshDocs]);

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

  // Upload bounded text directly; PDFs are parsed in this project scope and require review.
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  async function handlePickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    createIdempotencyKeyRef.current = null;
    setWebsitePreview(null);
    setCsvPreviewActive(false);
    setXlsxPreviewActive(false);
    if (/\.(pdf|docx|xlsx|pptx|png|jpe?g)$/i.test(file.name)) {
      if (!creds) return;
      setPdfPreview(null);
      setPreviewingPdf(true);
      try {
        const base64 = await readKnowledgePdfFile(file, params.projectId);
        const receipt = await previewKbPdf(activeSpaceId, creds, {
          content: base64, source_file_name: file.name, project_id: params.projectId,
        });
        if (!newDocTitle.trim()) setNewDocTitle(file.name.replace(/\.(pdf|docx|xlsx|pptx|png|jpe?g)$/i, ""));
        setNewDocContent(receipt.content);
        setPdfPreview({ base64, receipt });
        setXlsxPreviewActive(/\.xlsx$/i.test(file.name));
      } catch (err) {
        show(err instanceof Error ? err.message : "Couldn't preview that document.");
      } finally {
        setPreviewingPdf(false);
      }
      return;
    }
    setPdfPreview(null);
    const looksText = /^text\//.test(file.type) || file.type === "" || /\.(md|txt|csv|json|html|xml|log|ya?ml)$/i.test(file.name);
    if (!looksText) {
      show("Only readable text files are supported by this upload form.");
      return;
    }
    if (file.size > PROJECT_KNOWLEDGE_MAX_CONTENT_BYTES) {
      show("Project Knowledge text files are limited to 5 MiB.");
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
      setCsvPreviewActive(/\.csv$/i.test(file.name));
      setXlsxPreviewActive(false);
    } catch {
      show("Couldn't read that file.");
    }
  }

  async function handlePreviewWebsiteSource() {
    if (!creds || !websiteConnectionId || !websiteSourceUrl.trim() || previewingWebsite) return;
    createIdempotencyKeyRef.current = null;
    setPdfPreview(null);
    setCsvPreviewActive(false);
    setXlsxPreviewActive(false);
    setWebsitePreview(null);
    setPreviewingWebsite(true);
    try {
      const receipt = await previewWebsiteKnowledgeSource(activeSpaceId, params.projectId, creds, {
        connection_id: websiteConnectionId,
        url: websiteSourceUrl.trim(),
      });
      setWebsitePreview(receipt);
      setWebsiteSourceUrl(receipt.requested_url);
      setNewDocContent(receipt.content);
      if (!newDocTitle.trim()) {
        const finalUrl = new URL(receipt.final_url);
        const pathLeaf = finalUrl.pathname.split("/").filter(Boolean).pop();
        setNewDocTitle(pathLeaf ? pathLeaf.replace(/[-_]+/g, " ") : finalUrl.hostname);
      }
    } catch (error) {
      show(error instanceof Error ? error.message : "Couldn't preview this website page.");
    } finally {
      setPreviewingWebsite(false);
    }
  }

  async function handlePreviewWebsiteCrawl() {
    if (!creds || !websiteCrawlAvailable || !websiteCrawlTermsConfirmed || !websiteConnectionId
      || !websiteSourceUrl.trim() || crawlingWebsite) return;
    const idempotencyKey = websiteCrawlRequestKeyRef.current ?? crypto.randomUUID();
    websiteCrawlRequestKeyRef.current = idempotencyKey;
    setCrawlingWebsite(true);
    try {
      const result = await previewWebsiteKnowledgeCrawl(activeSpaceId, params.projectId, creds, {
        connection_id: websiteConnectionId, url: websiteSourceUrl.trim(), idempotency_key: idempotencyKey,
        max_pages: 8, max_depth: 2, owner_confirmed_site_terms: true,
      });
      setWebsiteCrawl(result);
      if (typeof window !== "undefined") window.sessionStorage.setItem(`naelao:website-crawl:${activeSpaceId}:${params.projectId}`,
        JSON.stringify({ operationId: result.operation_id, idempotencyKey, connectionId: websiteConnectionId }));
      if (!result.continuation_available) websiteCrawlRequestKeyRef.current = null;
    } catch (error) {
      show(error instanceof Error ? error.message : "Couldn't discover approved website pages.");
    } finally {
      setCrawlingWebsite(false);
    }
  }

  async function handlePreviewWebsiteRefresh(document: KbDocument) {
    const requestedUrl = document.source_requested_url ?? document.source_url;
    if (!creds || !requestedUrl || document.source_adapter !== "website" || refreshingWebsiteId) return;
    if (document.source_next_attempt_at && Date.parse(document.source_next_attempt_at) > Date.now()) {
      show(`Retry is available after ${new Date(document.source_next_attempt_at).toLocaleString()}.`);
      return;
    }
    const idempotencyKey = websiteRefreshRequestKeysRef.current.get(document.id) ?? crypto.randomUUID();
    websiteRefreshRequestKeysRef.current.set(document.id, idempotencyKey);
    setRefreshingWebsiteId(document.id);
    setWebsiteRefreshDraft(null);
    try {
      const preview = await previewWebsiteKnowledgeSource(activeSpaceId, params.projectId, creds, {
        document_id: document.id,
        idempotency_key: idempotencyKey,
        url: requestedUrl,
      });
      if (!preview.refresh_operation_id || !Number.isSafeInteger(preview.expected_source_revision)) {
        throw new Error("The refresh preview did not include a current source version. Reload and try again.");
      }
      setWebsiteRefreshDraft({ documentId: document.id, content: preview.content, preview });
    } catch (error) {
      show(error instanceof Error ? error.message : "Couldn't refresh this website page.");
    } finally {
      setRefreshingWebsiteId(null);
      await refreshDocs();
    }
  }

  async function handleSaveWebsiteRefresh(document: KbDocument) {
    if (!creds || !websiteRefreshDraft || websiteRefreshDraft.documentId !== document.id || addingDoc) return;
    const { preview, content } = websiteRefreshDraft;
    if (!preview.refresh_operation_id || preview.expected_source_revision === undefined) return;
    setAddingDoc(true);
    try {
      await applyWebsiteKnowledgeRefresh(activeSpaceId, document.id, params.projectId, creds, {
        title: document.title,
        content,
        requested_url: preview.requested_url,
        final_url: preview.final_url,
        preview_sha256: preview.preview_sha256,
        preview_token: preview.preview_token,
        refresh_operation_id: preview.refresh_operation_id,
        expected_source_revision: preview.expected_source_revision,
      });
      websiteRefreshRequestKeysRef.current.delete(document.id);
      setWebsiteRefreshDraft(null);
      show("Website snapshot refreshed and indexed");
      await refreshDocs();
      await refreshExternalKnowledge();
    } catch (error) {
      show(error instanceof Error ? error.message : "Couldn't save the refreshed website snapshot.");
    } finally {
      setAddingDoc(false);
    }
  }

  async function handleWebsiteRefreshSchedule(document: KbDocument, enabled: boolean) {
    if (!creds || savingWebsiteScheduleId) return;
    const intervalHours = websiteScheduleIntervals[document.id]
      ?? (document.source_refresh_interval_hours === 168 ? 168 : 24);
    setSavingWebsiteScheduleId(document.id);
    try {
      await setWebsiteKnowledgeRefreshSchedule(activeSpaceId, params.projectId, document.id, creds,
        { enabled, interval_hours: intervalHours });
      show(enabled ? `Automatic website refresh enabled (${intervalHours === 24 ? "daily" : "weekly"})` : "Automatic website refresh paused");
      await refreshDocs();
    } catch (error) {
      show(error instanceof Error ? error.message : "Couldn't update the website refresh schedule");
    } finally {
      setSavingWebsiteScheduleId(null);
    }
  }

  async function handleAddDoc(e: React.FormEvent) {
    e.preventDefault();
    if (!creds || !newDocTitle.trim() || !newDocContent.trim()) return;
    const submittedContent = newDocContent.trim();
    if (knowledgeContentByteLength(submittedContent) > PROJECT_KNOWLEDGE_MAX_CONTENT_BYTES) {
      show("Project Knowledge content is limited to 5 MiB.");
      return;
    }
    setAddingDoc(true);
    try {
      const idempotencyKey = createIdempotencyKeyRef.current ?? (createIdempotencyKeyRef.current = crypto.randomUUID());
      const created = await createKbDocument(activeSpaceId, creds, websitePreview ? {
        title: newDocTitle.trim(),
        content: submittedContent,
        content_type: "url",
        source_url: websitePreview.final_url,
        idempotency_key: idempotencyKey,
        project_id: params.projectId,
        website_connection_id: websiteConnectionId,
        website_requested_url: websitePreview.requested_url,
        website_preview_sha256: websitePreview.preview_sha256,
        website_preview_token: websitePreview.preview_token,
      } : pdfPreview ? {
        title: newDocTitle.trim(),
        content: pdfPreview.base64,
        content_type: /\.docx$/i.test(pdfPreview.receipt.source_file_name) ? "docx"
          : /\.xlsx$/i.test(pdfPreview.receipt.source_file_name) ? "xlsx"
            : /\.pptx$/i.test(pdfPreview.receipt.source_file_name) ? "pptx"
              : /\.(?:png|jpe?g)$/i.test(pdfPreview.receipt.source_file_name) ? "image" : "pdf",
        idempotency_key: idempotencyKey,
        ...(pdfPreview.receipt.source_file_name ? { source_file_name: pdfPreview.receipt.source_file_name } : {}),
        preview_content: submittedContent,
        preview_token: pdfPreview.receipt.preview_token,
        preview_extraction_sha256: pdfPreview.receipt.extraction_sha256,
        project_id: params.projectId,
      } : {
        title: newDocTitle.trim(),
        content: submittedContent,
        idempotency_key: idempotencyKey,
        project_id: params.projectId,
      });
      if (created.status === "failed") {
        createIdempotencyKeyRef.current = null;
        show("This earlier upload attempt failed. Submit again to start a new attempt.");
        await refreshDocs();
        return;
      }
      createIdempotencyKeyRef.current = null;
      setNewDocTitle("");
      setNewDocContent("");
      setCsvPreviewActive(false);
      setXlsxPreviewActive(false);
      setPdfPreview(null);
      setWebsitePreview(null);
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
      const result = await deleteKbDocument(activeSpaceId, docId, creds);
      await refreshDocs();
      await refreshExternalKnowledge();
      if (result.state === "pending") show("Deletion is still in progress. This list will update when cleanup finishes.");
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
        expected_revision: externalPublications.find(item => item.id === publicationId.trim())?.revision ?? 0,
      });
      show("Published Knowledge collection updated");
      await refreshExternalKnowledge();
    } catch (error) {
      await refreshExternalKnowledge();
      show(error instanceof Error ? error.message : "Couldn't publish this Knowledge collection");
    } finally {
      setSavingPublication(false);
    }
  }

  async function handleUnpublishExternalCollection(id: string) {
    if (!creds) return;
    try {
      const publication = externalPublications.find(item => item.id === id);
      if (!publication) throw new Error("Reload the current collection list before unpublishing");
      await unpublishExternalKnowledge(activeSpaceId, params.projectId, id, creds, publication.revision);
      setExternalPublications(items => items.filter(item => item.id !== id));
      if (publicationId === id) setPublishedDocumentIds([]);
      show("Knowledge collection unpublished");
      await refreshExternalKnowledge();
      await showExternalCollectionHistory(id);
    } catch (error) {
      await refreshExternalKnowledge();
      show(error instanceof Error ? error.message : "Couldn't unpublish this Knowledge collection");
    }
  }

  async function handleArchiveExternalCollection(id: string, archived: boolean) {
    if (!creds) return;
    try {
      const publication = externalPublications.find(item => item.id === id);
      if (!publication) throw new Error("Reload the current collection list before changing its archive state");
      await setExternalKnowledgePublicationArchived(activeSpaceId, params.projectId, id, creds, publication.revision, archived);
      if (publicationId === id) setPublishedDocumentIds([]);
      show(archived
        ? "Collection archived; extension access is paused and its published document list was removed."
        : "Collection restored as an empty draft; select documents, publish the new revision, then approve extension access again.");
      await refreshExternalKnowledge();
    } catch (error) {
      await refreshExternalKnowledge();
      show(error instanceof Error ? error.message : "Couldn't change the collection archive state");
    }
  }

  async function handleSaveSharedChannelKnowledge(installation: SpaceSharedChannelKnowledgeInstallation) {
    if (!creds || savingSharedKnowledge) return;
    setSavingSharedKnowledge(installation.instance_id);
    try {
      await setSpaceSharedChannelKnowledge(activeSpaceId, params.projectId, installation.instance_id, creds,
        installation.revision, sharedChannelKnowledgeDrafts[installation.instance_id] ?? []);
      show("Project Knowledge access updated");
      await refreshExternalKnowledge();
    } catch (error) {
      await refreshExternalKnowledge();
      show(error instanceof Error ? error.message : "Couldn't update Project Knowledge access");
    } finally {
      setSavingSharedKnowledge(null);
    }
  }

  async function editExternalCollection(publication: ExternalKnowledgePublication) {
    if (!creds || loadingPublicationSources) return;
    setLoadingPublicationSources(publication.id);
    try {
      const sources = await getExternalKnowledgePublicationSources(activeSpaceId, params.projectId, publication.id, creds);
      const current = externalPublications.find(item => item.id === publication.id);
      if (!current || current.archived || current.revision !== sources.revision)
        throw new Error("The collection changed while loading its sources. Reload and try again.");
      setPublicationId(publication.id);
      setPublicationName(publication.name);
      setPublishedDocumentIds(sources.document_ids);
    } catch (error) {
      show(error instanceof Error ? error.message : "Couldn't read collection sources");
    } finally {
      setLoadingPublicationSources(null);
    }
  }

  async function showExternalCollectionHistory(publicationId: string) {
    if (!creds || loadingPublicationHistory) return;
    setLoadingPublicationHistory(publicationId);
    try {
      const events = await listExternalKnowledgePublicationEvents(activeSpaceId, params.projectId, publicationId, creds);
      setPublicationHistory({ publicationId, events });
    } catch (error) {
      show(error instanceof Error ? error.message : "Couldn't load Knowledge collection history");
    } finally {
      setLoadingPublicationHistory(null);
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
      {/* Breadcrumb: Space > Project (mockup's #projects-back-label). */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16, fontSize: 12, color: "var(--text3)" }}>
        <Link href={`/p/${product.slug}/spaces/${activeSpaceId}`} style={{ color: "var(--text2)", textDecoration: "none" }}>
          {activeSpaceName ?? "Space"}
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

      <section aria-label="Project subspaces" style={{ margin: "0 0 20px", padding: 14, border: "1px solid var(--border)", borderRadius: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Subspaces</div>
        {departmentLoadError ? <output style={{ color: "var(--text3)", fontSize: 12 }}>Subspace links are unavailable. Refresh to try again.</output> : (
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
              {departments.length === 0 && <span style={{ fontSize: 12, color: "var(--text3)" }}>No subspace is linked to this project.</span>}
            </div>
            {selectedDepartmentId && <div style={{ marginTop: 8, fontSize: 12, color: "var(--text3)" }}>
              Subspace selected: {departments.find((department) => department.id === selectedDepartmentId)?.name}. Project identity and its data remain shared across its linked subspaces.
              {departments.some((department) => department.id === selectedDepartmentId) && <Link href={`/p/${product.slug}/spaces/${activeSpaceId}/departments/${encodeURIComponent(selectedDepartmentId)}`} style={{ marginLeft: 8, color: "var(--accent)" }}>Open subspace projects →</Link>}
            </div>}
            {departmentOptions.some((option) => !departments.some((department) => department.id === option.id)) && (
              <form style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }} onSubmit={(event) => { event.preventDefault(); void attachDepartment(departmentToAdd); }}>
                <label htmlFor="project-department-add" style={{ fontSize: 12, color: "var(--text2)" }}>Link another subspace</label>
                <select id="project-department-add" value={departmentToAdd} onChange={(event) => setDepartmentToAdd(event.target.value)} style={{ maxWidth: 240 }}>
                  <option value="">Choose a subspace</option>
                  {departmentOptions.filter((option) => !departments.some((department) => department.id === option.id)).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select>
                <button type="submit" className="btn btn-secondary btn-sm" disabled={!departmentToAdd || departmentBusy}>{departmentBusy ? "Linking…" : "Link subspace"}</button>
              </form>
            )}
            <form style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }} onSubmit={(event) => { event.preventDefault(); void createAndAttachDepartment(); }}>
              <label htmlFor="project-department-new" style={{ fontSize: 12, color: "var(--text2)" }}>Create a subspace</label>
              <input id="project-department-new" value={newDepartmentName} onChange={(event) => setNewDepartmentName(event.target.value)} maxLength={120} placeholder="Subspace name" style={{ maxWidth: 240 }} />
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
          isChildSpace={activeSpaceId !== product.space_id}
        />
      </section>}

      {creds && <ManagedRuntimeProfilesPanel spaceId={activeSpaceId} projectId={project.id} session={creds} />}
      {creds && <ProjectComputersPanel spaceId={activeSpaceId} projectId={project.id} session={creds} />}

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
          <Link href={`/p/${product.slug}/agents`} className="card" style={{ borderStyle: "dashed", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6, minHeight: 90, textDecoration: "none" }}>
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="var(--text3)" width={16} height={16}><circle cx="8" cy="8" r="6" /></svg>
            <div style={{ fontSize: 12, color: "var(--text3)" }}>Create or manage workers</div>
          </Link>
        </div>
      )}

      <div className="section-label" ref={settingsRef} style={{ marginTop: 24, scrollMarginTop: 16 }}>Settings</div>
      {creds && project && <ProjectCoordinationProposalPanel spaceId={activeSpaceId} projectId={project.id} session={creds} />}
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
        <FormInput placeholder="Document title" value={newDocTitle} onChange={(e) => { createIdempotencyKeyRef.current = null; setNewDocTitle(e.target.value); }} required />
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
          <strong style={{ fontSize: 13 }}>Add an approved website page</strong>
          {websiteConnections.length === 0 ? (
            <div style={{ color: "var(--text3)", fontSize: 12 }}>
              No active website connection is scoped to this Project. <Link href="/connectors">Manage website connections</Link>.
            </div>
          ) : (
            <>
              <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                Website connection
                <select value={websiteConnectionId} onChange={(event) => {
                  const connection = websiteConnections.find((item) => item.id === event.target.value);
                  setWebsiteConnectionId(event.target.value);
                  setWebsiteSourceUrl(connection?.start_url ?? "");
                  setWebsitePreview(null);
                  setWebsiteCrawl(null);
                  setWebsiteCrawlTermsConfirmed(false);
                  websiteCrawlRequestKeyRef.current = null;
                  createIdempotencyKeyRef.current = null;
                }}>
                  {websiteConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                </select>
              </label>
              <FormInput
                type="url"
                placeholder="HTTPS page URL within the approved origins"
                value={websiteSourceUrl}
                onChange={(event) => {
                  setWebsiteSourceUrl(event.target.value);
                  setWebsitePreview(null);
                  setWebsiteCrawl(null);
                  setWebsiteCrawlTermsConfirmed(false);
                  websiteCrawlRequestKeyRef.current = null;
                  createIdempotencyKeyRef.current = null;
                }}
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={previewingWebsite || addingDoc || !websiteSourceUrl.trim()}
                  onClick={() => void handlePreviewWebsiteSource()}>
                  {previewingWebsite ? "Fetching page…" : "Fetch and review page"}
                </button>
                {websitePreview && <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
                  setWebsitePreview(null);
                  createIdempotencyKeyRef.current = null;
                }}>Clear website source</button>}
              </div>
              {websiteCrawlAvailable ? (
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, display: "grid", gap: 8 }}>
                  <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}>
                    <input type="checkbox" checked={websiteCrawlTermsConfirmed}
                      onChange={(event) => setWebsiteCrawlTermsConfirmed(event.target.checked)} />
                    <span>I confirm I have permission to crawl this site and its applicable terms allow this bounded discovery.</span>
                  </label>
                  <div className="settings-row-sub">Discovery is limited to 8 same-origin pages, depth 2, 100 links per page, 5 redirects, 512 KiB per page, 2 MiB total, 20 seconds per request and {websiteCrawlConcurrencyLimit} active operations per tenant. It never stores or indexes page text; every selected page still requires its own preview and owner review.</div>
                  <Button size="sm" variant="ghost" type="button"
                    disabled={!websiteCrawlTermsConfirmed || !websiteSourceUrl.trim() || crawlingWebsite}
                    onClick={() => void handlePreviewWebsiteCrawl()}>
                    {crawlingWebsite ? "Discovering pages…" : websiteCrawl?.continuation_available ? "Continue discovery" : "Discover related pages"}
                  </Button>
                </div>
              ) : <div role="status" className="settings-row-sub">Multi-page discovery remains disabled while site-terms and live acceptance gates are open.</div>}
              {websiteCrawl && <div role="status" style={{ borderTop: "1px solid var(--border)", paddingTop: 8, fontSize: 12 }}>
                <strong>Discovery {websiteCrawl.status} · {websiteCrawl.totals.page_count} pages · {websiteCrawl.totals.byte_count.toLocaleString()} bytes</strong>
                  <Button size="sm" variant="ghost" type="button" onClick={() => {
                    setWebsiteCrawl(null);
                    websiteCrawlRequestKeyRef.current = null;
                    if (typeof window !== "undefined") window.sessionStorage.removeItem(`naelao:website-crawl:${activeSpaceId}:${params.projectId}`);
                  }}>Forget discovery status</Button>
                {websiteCrawl.pages.map((page) => <div key={page.requested_url} className="settings-row-sub" style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                  <span style={{ paddingLeft: page.depth * 12 }}>{page.status} · {page.requested_url}{page.error_code ? ` · ${page.error_code}` : ""}</span>
                  {page.status === "preview_ready" && <Button size="sm" variant="ghost" type="button" onClick={() => {
                    setWebsiteSourceUrl(page.requested_url);
                    setWebsitePreview(null);
                    websiteCrawlRequestKeyRef.current = null;
                  }}>Select page</Button>}
                </div>)}
                {websiteCrawl.continuation_available && <div className="settings-row-sub" style={{ marginTop: 6 }}>Continue discovery to process the remaining bounded pages.</div>}
              </div>}
              {websitePreview && <div role="status" style={{ borderTop: "1px solid var(--border)", paddingTop: 8, fontSize: 12 }}>
                <strong>Website snapshot preview</strong>
                <div>Source: <a href={websitePreview.final_url} target="_blank" rel="noreferrer">{websitePreview.final_url}</a></div>
                <div>Fetched as {websitePreview.content_type} · approval expires in 15 minutes</div>
                <p>Review and edit the extracted text below. Saving stores this approved snapshot; refresh is manual.</p>
                <ul>{websitePreview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </div>}
            </>
          )}
        </div>
        <FormTextarea
          placeholder={websitePreview ? "Review and edit the approved website text…" : "Paste content to ingest into this project's KB…"}
          value={newDocContent}
          onChange={(e) => { createIdempotencyKeyRef.current = null; setNewDocContent(e.target.value); }}
          rows={4}
          required
        />
        {csvPreviewActive && <KnowledgeCsvPreview content={newDocContent} />}
        {xlsxPreviewActive && <KnowledgeCsvPreview content={newDocContent} delimiter="\t" kind="XLSX worksheet" />}
        <div style={{ fontSize: 12, color: "var(--text3)" }}>
          Project-private text limit: 5 MiB ({knowledgeContentByteLength(newDocContent.trim()).toLocaleString()} bytes entered).
        </div>
        {pdfPreview && <div role="status" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, fontSize: 12 }}>
          <strong>{/\.docx$/i.test(pdfPreview.receipt.source_file_name) ? "DOCX" : /\.xlsx$/i.test(pdfPreview.receipt.source_file_name) ? "XLSX" : /\.pptx$/i.test(pdfPreview.receipt.source_file_name) ? "PPTX" : /\.(?:png|jpe?g)$/i.test(pdfPreview.receipt.source_file_name) ? "IMAGE OCR" : "PDF"} extraction preview · {pdfPreview.receipt.parser_version}</strong>
          <div>Source SHA-256: <code>{pdfPreview.receipt.source_sha256}</code></div>
          <div>{pdfPreview.receipt.source_bytes.toLocaleString()} source bytes · {pdfPreview.receipt.extracted_bytes.toLocaleString()} extracted bytes (5 MiB project limit)</div>
          <p>Review and edit the extracted text before adding it to this project. This file preview expires after 15 minutes.</p>
          <ul>{pdfPreview.receipt.extraction_warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Button size="sm" disabled={addingDoc || previewingPdf || knowledgeContentByteLength(newDocContent.trim()) > PROJECT_KNOWLEDGE_MAX_CONTENT_BYTES}>
            {addingDoc ? "Adding…" : "Add document"}
          </Button>
          <input ref={fileInputRef} type="file" accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.txt,.md,.csv,.json,.html,.xml,.log,text/*" style={{ display: "none" }} onChange={(event) => void handlePickFile(event)} />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => fileInputRef.current?.click()}
            style={{ fontSize: 12.5 }}
          >
            {previewingPdf ? "Preparing document preview…" : "Upload text, PDF, DOCX, XLSX, PPTX, PNG or JPEG"}
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
            <div key={d.id} style={{ borderBottom: "1px solid var(--border)", padding: "10px 14px" }}>
              <div className="settings-row" style={{ border: 0, padding: 0 }}>
                <div>
                  <div className="settings-row-label">{d.title}</div>
                  <div className="settings-row-sub">
                    {d.chunk_count} chunk{d.chunk_count === 1 ? "" : "s"} · {d.status}
                    {d.source_adapter === "website" && ` · website snapshot v${d.source_revision ?? 1}`}
                  </div>
                  {d.source_adapter === "website" && <div className="settings-row-sub" style={{ marginTop: 4 }}>
                    Last attempted refresh: {d.source_last_attempt_at ? new Date(d.source_last_attempt_at).toLocaleString() : "not recorded"}
                    {` · last indexed ${d.source_last_success_at ? new Date(d.source_last_success_at).toLocaleString() : "not recorded"}`}
                    {d.source_refresh_failures ? ` · ${d.source_refresh_failures} failed attempt${d.source_refresh_failures === 1 ? "" : "s"}` : ""}
                    {d.source_last_error_code ? " · latest attempt failed" : ""}
                    {d.source_next_attempt_at && ` · retry after ${new Date(d.source_next_attempt_at).toLocaleString()}`}
                  </div>}
                  {d.source_adapter === "website" && <div className="settings-row-sub" style={{ marginTop: 4 }}>
                    {d.source_refresh_schedule_enabled === 1
                      ? d.source_refresh_schedule_available === false
                        ? "Automatic refresh is paused while this capability is unavailable"
                        : `Automatic refresh ${d.source_refresh_interval_hours === 168 ? "weekly" : "daily"}${d.source_refresh_next_run_at ? ` · next ${new Date(d.source_refresh_next_run_at).toLocaleString()}` : ""}`
                      : d.source_refresh_schedule_available === true ? "Automatic refresh is off"
                        : d.source_refresh_last_result ? "Automatic refresh is paused" : ""}
                    {d.source_refresh_last_result && ` · last result ${d.source_refresh_last_result}`}
                    {d.source_refresh_last_error_code && ` (${d.source_refresh_last_error_code})`}
                  </div>}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {d.source_adapter === "website" && <Button size="sm" variant="ghost"
                    disabled={!d.source_url || d.source_state !== "current" || !["indexed", "failed"].includes(d.status) || refreshingWebsiteId !== null || addingDoc}
                    onClick={() => void handlePreviewWebsiteRefresh(d)}>
                    {refreshingWebsiteId === d.id ? "Fetching…" : "Refresh page"}
                  </Button>}
                  {d.source_adapter === "website" && d.source_state === "current"
                    && (d.source_refresh_schedule_available === true || d.source_refresh_schedule_enabled === 1) && <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {d.source_refresh_schedule_enabled === 1 ? <Button size="sm" variant="ghost"
                      disabled={savingWebsiteScheduleId !== null}
                      onClick={() => void handleWebsiteRefreshSchedule(d, false)}>
                      {savingWebsiteScheduleId === d.id ? "Saving…" : "Pause automatic refresh"}
                    </Button> : <>
                      <label className="sr-only" htmlFor={`website-refresh-interval-${d.id}`}>Automatic refresh interval for {d.title}</label>
                      <select id={`website-refresh-interval-${d.id}`} className="input input-sm"
                        value={websiteScheduleIntervals[d.id] ?? 24}
                        onChange={(event) => setWebsiteScheduleIntervals(current => ({ ...current,
                          [d.id]: Number(event.target.value) === 168 ? 168 : 24 }))}>
                        <option value={24}>Daily</option><option value={168}>Weekly</option>
                      </select>
                      <Button size="sm" variant="ghost"
                        disabled={!d.source_url || d.status !== "indexed" || savingWebsiteScheduleId !== null}
                        onClick={() => void handleWebsiteRefreshSchedule(d, true)}>
                        {savingWebsiteScheduleId === d.id ? "Saving…" : "Enable automatic refresh"}
                      </Button>
                    </>}
                  </div>}
                  <Button size="sm" variant="ghost" onClick={() => handleDeleteDoc(d.id)} disabled={d.status === "deleting"}>
                    {d.status === "deleting" ? "Deleting…" : "Remove"}
                  </Button>
                </div>
              </div>
              {d.source_adapter === "website" && (d.source_refresh_schedule_available === true || d.source_refresh_schedule_enabled === 1) && <p className="settings-row-sub" style={{ margin: "6px 0 0" }}>
                {d.source_refresh_schedule_enabled === 1 ? "Changed page text is reindexed automatically without another review and may use your existing Knowledge processing quota. Pausing or revoking its website connection stops later runs."
                  : "Opt in to recheck this one page daily or weekly. If its text changes, it is reindexed automatically without another review and may use your existing Knowledge processing quota. Pausing or revoking its website connection stops later runs."}
              </p>}
              {websiteRefreshDraft?.documentId === d.id && <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                <div role="status" className="settings-row-sub">
                  Review the refreshed page before replacing version {websiteRefreshDraft.preview.expected_source_revision}. Saving updates this snapshot and any published collection revision.
                </div>
                <div className="settings-row-sub">Fetched source: <a href={websiteRefreshDraft.preview.final_url} target="_blank" rel="noreferrer">{websiteRefreshDraft.preview.final_url}</a></div>
                <FormTextarea aria-label={`Review refreshed ${d.title}`} rows={6} value={websiteRefreshDraft.content}
                  onChange={(event) => setWebsiteRefreshDraft(current => current?.documentId === d.id ? { ...current, content: event.target.value } : current)} />
                <ul className="settings-row-sub" style={{ margin: 0 }}>{websiteRefreshDraft.preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button size="sm" disabled={addingDoc || !websiteRefreshDraft.content.trim()} onClick={() => void handleSaveWebsiteRefresh(d)}>
                    {addingDoc ? "Indexing…" : "Approve and update snapshot"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={addingDoc} onClick={() => setWebsiteRefreshDraft(null)}>Cancel</Button>
                </div>
              </div>}
            </div>
          ))}
        </div>
      )}

      <div ref={externalKnowledgeSetupRef} className="page-header" style={{ marginTop: 24 }}>
        <div className="section-label" style={{ marginBottom: 0 }}>External extension Knowledge</div>
        <div className="page-subtitle">
          Select indexed project documents to publish as a named collection. Only a channel extension explicitly configured for this collection can retrieve it; publishing does not connect a provider or enable a bot.
        </div>
      </div>
      {searchParams.get("setup") === "knowledge" && <p role="status" className="settings-block" style={{ padding: 12, color: "var(--text2)" }}>
        This template requires owner-published Knowledge for a Space-shared channel. Publish a collection here, then grant only that current collection in the Project access controls below. No extension receives Project Knowledge until you save an explicit grant.
      </p>}
      {publicationLoadError ? (
        <div role="status" className="settings-block" style={{ padding: 12, color: "var(--text2)" }}>
          Couldn't load published collections. Check project access and try again.
        </div>
      ) : externalPublications.length > 0 ? (
        <div className="settings-block" aria-label="Published Knowledge collections">
          {externalPublications.map(publication => (
            <div className="settings-row" key={publication.id}>
              <div>
                <div className="settings-row-label">{publication.name}{publication.archived ? " · Archived" : ""}</div>
                <div className="settings-row-sub">{publication.id} · revision {publication.revision} · {publication.document_count} published document{publication.document_count === 1 ? "" : "s"}</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {publication.archived ? (
                  <Button size="sm" variant="ghost" onClick={() => void handleArchiveExternalCollection(publication.id, false)}>Restore draft</Button>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" disabled={loadingPublicationSources !== null}
                      onClick={() => void editExternalCollection(publication)}>
                      {loadingPublicationSources === publication.id ? "Loading…" : "Edit"}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={loadingPublicationHistory !== null}
                      onClick={() => void showExternalCollectionHistory(publication.id)}>
                      {loadingPublicationHistory === publication.id ? "Loading…" : "History"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void handleArchiveExternalCollection(publication.id, true)}>Archive</Button>
                    <Button size="sm" variant="ghost" onClick={() => void handleUnpublishExternalCollection(publication.id)}>Delete</Button>
                  </>
                )}
                {publication.archived && (
                  <Button size="sm" variant="ghost" disabled={loadingPublicationHistory !== null}
                    onClick={() => void showExternalCollectionHistory(publication.id)}>
                    {loadingPublicationHistory === publication.id ? "Loading…" : "History"}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>No documents are published for external extensions.</p>
      )}
      {publicationHistory && (
        <div className="settings-block" aria-label="Knowledge collection archive history" style={{ marginTop: 12, padding: 14 }}>
          <div className="settings-row-label">Lifecycle history · {publicationHistory.publicationId}</div>
          {publicationHistory.events.length === 0 ? (
            <div className="settings-row-sub" style={{ marginTop: 6 }}>No archive or restore actions are recorded.</div>
          ) : publicationHistory.events.map(event => {
            const label = { published: "Published", updated: "Updated published sources", archived: "Archived",
              restored_as_draft: "Restored as draft", deleted: "Deleted" }[event.action];
            return (
              <div className="settings-row" key={event.event_id}>
                <div className="settings-row-label">{label}</div>
                <div className="settings-row-sub">Revision {event.from_revision} → {event.to_revision} · {event.actor_id} · <time dateTime={event.created_at}>{event.created_at}</time></div>
              </div>
            );
          })}
          <Button size="sm" variant="ghost" onClick={() => setPublicationHistory(null)}>Close history</Button>
        </div>
      )}
      <div className="page-header" style={{ marginTop: 24 }}>
        <div className="section-label" style={{ marginBottom: 0 }}>Space-shared channel access for this project</div>
        <div className="page-subtitle">
          Space-shared channel extensions receive no Project Knowledge by default. Owners and admins can grant only collections declared by the signed package and currently published in this Project. Saving an empty selection revokes access.
        </div>
      </div>
      {sharedChannelKnowledgeLoadError ? (
        <div role="status" className="settings-block" style={{ padding: 12, color: "var(--text2)" }}>
          Couldn't load Space-shared channel access. Only Space owners and admins can view or change these selections.
        </div>
      ) : sharedChannelKnowledge.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>No active Space-shared channel extensions declare Project Knowledge collections.</p>
      ) : (
        <div className="settings-block" aria-label="Space-shared channel Project Knowledge access">
          {sharedChannelKnowledge.map(installation => {
            const draft = sharedChannelKnowledgeDrafts[installation.instance_id] ?? [];
            const available = externalPublications.filter(publication => !publication.archived && installation.declared_publication_ids.includes(publication.id));
            const unavailableGrants = installation.granted_publication_ids.filter(id => !available.some(publication => publication.id === id));
            const staleGrants = (installation.granted_publications ?? []).filter(grant => {
              const current = externalPublications.find(publication => publication.id === grant.id);
              return current && current.revision !== grant.revision;
            });
            const activationSelectionsPending = (installation.activation_selected_publication_ids ?? [])
              .filter(id => !installation.granted_publication_ids.includes(id));
            return (
              <div className="settings-row" key={installation.instance_id} style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div className="settings-row-label">{installation.name}</div>
                  <div className="settings-row-sub">
                    {installation.configured
                      ? `Owner selection active · revision ${installation.revision}`
                      : "No owner selection saved · this extension has no Project Knowledge access"}
                  </div>
                  <div className="settings-row-sub" style={{ marginTop: 6 }}>
                    Signed package collection IDs: {installation.declared_publication_ids.join(", ")}
                  </div>
                  {(installation.grant_history?.length ?? 0) > 0 && (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: "pointer", fontSize: 13 }}>Project Knowledge grant history ({installation.grant_history!.length})</summary>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                        {installation.grant_history!.map(event => (
                          <div className="settings-row-sub" key={event.revision}>
                            Revision {event.revision} · {event.publication_ids.length ? event.publication_ids.map(id => `${id} @${event.publication_revisions[id] ?? "legacy"}`).join(", ") : "no collections (revoked)"}
                            · {event.actor_id} · <time dateTime={event.created_at}>{event.created_at}</time>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {activationSelectionsPending.length > 0 && <div role="status" className="settings-row-sub" style={{ marginTop: 8 }}>
                    Space Template review selected {activationSelectionsPending.join(", ")} for this Project. This is a pending setup choice, not access: publish each exact collection above, then explicitly save Project access to commit it. Current publication and signed package declaration are checked again when you save.
                  </div>}
                  {publicationLoadError ? (
                    <div role="status" className="settings-row-sub" style={{ marginTop: 8 }}>Current Project publications are unavailable; retry before changing access.</div>
                  ) : available.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                      {available.map(publication => (
                        <label key={publication.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                          <input
                            type="checkbox"
                            checked={draft.includes(publication.id)}
                            onChange={event => setSharedChannelKnowledgeDrafts(current => ({
                              ...current,
                              [installation.instance_id]: event.target.checked
                                ? [...new Set([...(current[installation.instance_id] ?? []), publication.id])]
                                : (current[installation.instance_id] ?? []).filter(id => id !== publication.id),
                            }))}
                          />
                          <span>{publication.name} <span style={{ color: "var(--text3)" }}>({publication.id})</span></span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <div className="settings-row-sub" style={{ marginTop: 8 }}>
                      No signed package collection is published in this Project yet. Publish a collection above with one of the declared IDs, then save an explicit grant.
                    </div>
                  )}
                  {unavailableGrants.length > 0 && (
                    <div role="status" className="settings-row-sub" style={{ marginTop: 8 }}>
                      These saved selections are not currently selectable and will be revoked when you save: {unavailableGrants.join(", ")}.
                    </div>
                  )}
                  {staleGrants.length > 0 && (
                    <div role="status" className="settings-row-sub" style={{ marginTop: 8 }}>
                      Access is paused for collections whose published contents changed: {staleGrants.map(grant => grant.id).join(", ")}. Review the current documents and save Project access to approve the new revision.
                    </div>
                  )}
                  <div style={{ marginTop: 10 }}>
                    <Button size="sm" variant="ghost" disabled={savingSharedKnowledge !== null || publicationLoadError}
                      onClick={() => void handleSaveSharedChannelKnowledge(installation)}>
                      {savingSharedKnowledge === installation.instance_id ? "Saving…" : "Save Project access"}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
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
