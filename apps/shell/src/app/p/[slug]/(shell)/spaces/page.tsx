"use client";

import * as React from "react";
import Link from "next/link";
import { Button, Badge, Card, CardTitle, CardDesc, FormInput, FormSelect, Modal, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { listMySpaces, createSpace, getSpaceAnalytics, listSpaceTemplates, forkSpaceTemplate, activateSpaceTemplate, previewSpaceTemplateActivation, type SpaceTemplateActivationPreview, type SpaceSummary, type SpaceTemplateListing } from "@/lib/api";
import { listModelBenchmarks, DEFAULT_WORKING_MODEL, type CostTier } from "@naelao/billing-core";
import { modelLabel } from "@/components/ModelSelector";

const COST_TIER_LABEL: Record<CostTier, string> = { economy: "Economy", standard: "Standard", premium: "Premium" };
const COST_TIER_BADGE: Record<CostTier, "green" | "blue" | "amber"> = { economy: "green", standard: "blue", premium: "amber" };
const AXIS_LABEL: Record<string, string> = {
  agency: "Multi-step", safety: "Safety", fabrication: "Won't invent results",
  recovery: "Recovers", proactivity: "Escalates", synthesis: "Briefings",
};

interface SpaceActivity {
  space: SpaceSummary;
  runs: number;
  credits: number;
  successRate: number | null;
  failed: boolean;
}

export default function SpacesPage() {
  const product = useProduct();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const [spaces, setSpaces] = React.useState<SpaceSummary[]>([]);
  const [templates, setTemplates] = React.useState<SpaceTemplateListing[]>([]);
  const [activities, setActivities] = React.useState<SpaceActivity[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [listFailed, setListFailed] = React.useState(false);
  const [activityLoading, setActivityLoading] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [showAllModels, setShowAllModels] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [newSpaceName, setNewSpaceName] = React.useState("");
  const [templateId, setTemplateId] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [createdSpaceId, setCreatedSpaceId] = React.useState<string | null>(null);
  const [activationReview, setActivationReview] = React.useState<{ spaceId: string; blueprintId: string; preview: SpaceTemplateActivationPreview; filesystemGrantSelections?: Record<string, Record<string, "KEEP" | "NONE" | "READ" | "READ_WRITE">> } | null>(null);
  const [activatingTemplate, setActivatingTemplate] = React.useState(false);
  const [refreshingPreview, setRefreshingPreview] = React.useState(false);
  const [openingPendingTemplate, setOpeningPendingTemplate] = React.useState<string | null>(null);
  const pendingPreviewed = React.useRef(new Set<string>());
  const creds = React.useMemo(() => session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null, [session]);
  const selectedTemplate = templates.find(template => template.id === templateId);

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      const [listed, availableTemplates] = await Promise.allSettled([
        listMySpaces(product.space_id, creds),
        listSpaceTemplates(creds),
      ]);
      if (listed.status === "fulfilled") {
        setSpaces(listed.value);
        setListFailed(false);
      } else {
        setListFailed(true);
      }
      if (availableTemplates.status === "fulfilled") setTemplates(availableTemplates.value);
    } catch {
      setListFailed(true);
    } finally {
      setLoading(false);
    }
  }, [creds, product.space_id]);

  async function handleCreate(event?: React.FormEvent) {
    event?.preventDefault();
    if (!creds || !newSpaceName.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const listing = templateId ? templates.find((item) => item.id === templateId) : undefined;
      if (templateId && !listing) throw new Error("That Space Template is no longer available.");
      const fork = listing ? await forkSpaceTemplate(product.space_id, listing.id, creds) : null;
      const created = await createSpace(product.space_id, creds, {
        name: newSpaceName.trim(),
        ...(listing ? { template_listing_id: listing.id } : {}),
        ...(fork ? { blueprint_id: fork.space_type_id } : {}),
      });
      setNewSpaceName("");
      // Production spaces install the blueprint at the end of background provisioning. Local
      // spaces have no queue, so activate it now that the owner membership is committed.
      if (fork && created.status === "active") {
        try {
          const preview = await previewSpaceTemplateActivation(created.id, fork.space_type_id, creds);
          setActivationReview({ spaceId: created.id, blueprintId: fork.space_type_id, preview });
          setCreatedSpaceId(created.id);
          setCreateError(preview.ready ? null : `Template dependencies need attention: ${preview.blockers.join(", ")}`);
          await refresh();
          return;
        } catch (error) {
          setCreatedSpaceId(created.id);
          setCreateError(`Space created, but the template was not installed: ${error instanceof Error ? error.message : "installation failed"}`);
          await refresh();
          return;
        }
      }
      setCreateOpen(false);
      setTemplateId("");
      setCreatedSpaceId(null);
      await refresh();
      if (created.status === "active") window.location.assign(`/p/${product.slug}/spaces/${created.id}`);
      else show("Space created and provisioning in the background.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create Space.";
      setCreateError(message);
      show(message);
    } finally {
      setCreating(false);
    }
  }

  async function confirmTemplateActivation() {
    if (!creds || !activationReview || !activationReview.preview.ready || activatingTemplate) return;
    setActivatingTemplate(true); setCreateError(null);
    try {
      const approvedSharedFilesystem = Object.fromEntries(Object.entries(activationReview.filesystemGrantSelections ?? {}).flatMap(([extensionId, paths]) => {
        const dependency = activationReview.preview.dependencies.find(item => item.extension_id === extensionId);
        const installed = dependency?.status === "installed";
        const defaultValue = installed ? "KEEP" : "NONE";
        if (!Object.values(paths).some(access => access !== defaultValue)) return [];
        const grants = (dependency?.summary?.shared_filesystem ?? []).flatMap(requested => {
          const selected = paths[requested.path] ?? defaultValue;
          if (selected === "NONE") return [];
          if (selected === "KEEP") {
            const current = dependency?.summary?.approved_shared_filesystem?.find(grant => grant.path === requested.path);
            return current ? [current] : [];
          }
          return [{ path: requested.path, access: selected }];
        });
        return [[extensionId, grants]];
      }));
      await activateSpaceTemplate(activationReview.spaceId, activationReview.blueprintId, creds, approvedSharedFilesystem);
      setCreateOpen(false);
      window.location.assign(`/p/${product.slug}/spaces/${activationReview.spaceId}`);
    } catch (error) { setCreateError(`Template was not activated: ${error instanceof Error ? error.message : "activation failed"}`); }
    finally { setActivatingTemplate(false); }
  }

  async function recheckTemplateActivation() {
    if (!creds || !activationReview || refreshingPreview) return;
    setRefreshingPreview(true); setCreateError(null);
    try {
      const preview = await previewSpaceTemplateActivation(activationReview.spaceId, activationReview.blueprintId, creds);
      setActivationReview({ ...activationReview, preview });
      setCreateError(preview.ready ? null : `Template dependencies need attention: ${preview.blockers.join(", ")}`);
    } catch (error) { setCreateError(`Could not refresh dependency status: ${error instanceof Error ? error.message : "preview failed"}`); }
    finally { setRefreshingPreview(false); }
  }

  async function reviewPendingTemplate(space: SpaceSummary) {
    if (!creds || !space.pending_blueprint_id || openingPendingTemplate) return;
    setOpeningPendingTemplate(space.id);
    try {
      const preview = await previewSpaceTemplateActivation(space.id, space.pending_blueprint_id, creds);
      setActivationReview({ spaceId: space.id, blueprintId: space.pending_blueprint_id, preview });
      setCreatedSpaceId(space.id);
      setCreateError(preview.ready ? null : `Template dependencies need attention: ${preview.blockers.join(", ")}`);
      setCreateOpen(true);
    } catch (error) {
      show(`Template setup review unavailable: ${error instanceof Error ? error.message : "preview failed"}`);
    } finally {
      setOpeningPendingTemplate(null);
    }
  }

  React.useEffect(() => { void refresh(); }, [refresh]);

  React.useEffect(() => {
    if (!creds || createOpen || activationReview) return;
    const pending = spaces.find(space => space.space_status === "active" && space.pending_blueprint_id
      && (space.role === "owner" || space.role === "admin"));
    if (!pending?.pending_blueprint_id) return;
    const key = `${pending.id}:${pending.pending_blueprint_id}`;
    if (pendingPreviewed.current.has(key)) return;
    pendingPreviewed.current.add(key);
    void previewSpaceTemplateActivation(pending.id, pending.pending_blueprint_id, creds).then(preview => {
      setActivationReview({ spaceId: pending.id, blueprintId: pending.pending_blueprint_id!, preview });
      setCreatedSpaceId(pending.id);
      setCreateError(preview.ready ? null : `Template dependencies need attention: ${preview.blockers.join(", ")}`);
      setCreateOpen(true);
    }).catch(error => {
      setCreateError(`Template preview is unavailable: ${error instanceof Error ? error.message : "retry the preview"}`);
      show("A Space Template is waiting for review. Refresh this page to retry its preview.");
    });
  }, [spaces, creds, createOpen, activationReview, show]);

  React.useEffect(() => {
    if (!creds) return;
    const active = spaces.filter((space) => space.space_status === "active");
    if (active.length === 0) { setActivities(null); return; }
    let cancelled = false;
    setActivityLoading(true);
    void Promise.all(active.map(async (space): Promise<SpaceActivity> => {
      try {
        const result = await getSpaceAnalytics(space.id, creds, "30d");
        return { space, runs: result.runs.total, credits: result.credits.used, successRate: result.runs.success_rate, failed: false };
      } catch {
        return { space, runs: 0, credits: 0, successRate: null, failed: true };
      }
    })).then((rows) => {
      if (!cancelled) setActivities(rows.sort((a, b) => b.runs - a.runs));
    }).finally(() => { if (!cancelled) setActivityLoading(false); });
    return () => { cancelled = true; };
  }, [spaces, session]);

  const visibleSpaces = query.trim()
    ? spaces.filter((space) => space.name.toLowerCase().includes(query.trim().toLowerCase()))
    : spaces;
  const totalRuns = activities?.reduce((total, row) => total + row.runs, 0) ?? 0;

  return (
    <div className="page-view">
      <div className="page-header">
        <div>
          <div className="page-title">Spaces</div>
          <div className="page-subtitle">Your Naelao workspaces.</div>
        </div>
        <Button onClick={() => { setCreateError(null); setCreatedSpaceId(null); setActivationReview(null); setCreateOpen(true); }}>New Space</Button>
      </div>

      {!loading && !listFailed && spaces.length > 0 && (
        <div className="grid-3" style={{ marginBottom: 18 }}>
          <div className="card"><div className="card-label">Spaces</div><div className="card-value">{spaces.length}</div></div>
          <div className="card"><div className="card-label">Agent runs (30d)</div><div className="card-value">{activityLoading && activities === null ? "…" : totalRuns.toLocaleString()}</div></div>
        </div>
      )}

      {!loading && !listFailed && spaces.length > 0 && (
        <div className="search-bar" style={{ marginBottom: 16 }}>
          <FormInput placeholder="Search spaces…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
      )}

      <div className="section-label">Your spaces{!loading && !listFailed && spaces.length > 0 ? ` (${visibleSpaces.length}${query.trim() ? ` of ${spaces.length}` : ""})` : ""}</div>
      {loading ? <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
        : listFailed ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
            <span style={{ color: "#dc2626" }} role="alert">Couldn&rsquo;t load your spaces. Your work is still there; this is a loading problem.</span>
            <Button variant="secondary" onClick={() => void refresh()}>Retry</Button>
          </div>
        ) : spaces.length === 0 ? (
          <p style={{ color: "var(--text3)", fontSize: 13 }}>No additional spaces are connected to this account.</p>
        ) : visibleSpaces.length === 0 ? (
          <p style={{ color: "var(--text3)", fontSize: 13 }}>No space matches &ldquo;{query}&rdquo;.</p>
        ) : (
          <div className="grid-3">
            {visibleSpaces.map((space) => {
              const templatePending = Boolean(space.pending_blueprint_id);
              const active = space.space_status === "active";
              return (
                <Link key={space.id} href={`/p/${product.slug}/spaces/${space.id}`} style={{ textDecoration: "none" }}>
                  <Card interactive>
                    <CardTitle>{space.name}</CardTitle>
                    <CardDesc>Your role: {space.role}</CardDesc>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {templatePending && <Badge color="amber">Template review</Badge>}
                      <Badge color={active ? "green" : "amber"}>{active ? "active" : space.space_status}</Badge>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}

      {activities && activities.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 26 }}>Space activity · last 30 days</div>
          <div className="settings-block">
            {activities.map((row, index) => (
              <Link key={row.space.id} href={`/p/${product.slug}/spaces/${row.space.id}`} className="settings-row" style={{ textDecoration: "none", color: "inherit", cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                  <span style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, background: index === 0 ? "var(--accent)" : "var(--surface2)", color: index === 0 ? "#fff" : "var(--text3)" }}>{index + 1}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="settings-row-label" style={{ marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.space.name}</div>
                    <div className="settings-row-sub">{row.runs} runs · {row.credits.toLocaleString()} credits{row.successRate !== null ? ` · ${Math.round(row.successRate * 100)}% success` : ""}{row.failed ? " · partial data" : ""}</div>
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text3)" }}>{row.runs} runs</div><div style={{ fontSize: 10.5, color: "var(--text3)" }}>last 30 days</div></div>
              </Link>
            ))}
          </div>
        </>
      )}

      {visibleSpaces.some(space => space.pending_blueprint_id && (space.role === "owner" || space.role === "admin")) && <div style={{ marginTop: 20 }}>
        <div className="section-label">Template setup to finish</div>
        <div className="settings-block">
          {visibleSpaces.filter(space => space.pending_blueprint_id && (space.role === "owner" || space.role === "admin")).map(space => <div key={`${space.id}:${space.pending_blueprint_id}`} className="settings-row">
            <div style={{ minWidth: 0 }}>
              <div className="settings-row-label">{space.name}</div>
              <div className="settings-row-sub">Space created; template activation is waiting for your review.</div>
            </div>
            <Button variant="secondary" disabled={openingPendingTemplate !== null} onClick={() => void reviewPendingTemplate(space)}>
              {openingPendingTemplate === space.id ? "Loading…" : "Review setup"}
            </Button>
          </div>)}
        </div>
      </div>}

      <div className="section-label" style={{ marginTop: 26 }}>Model benchmarks</div>
      <p style={{ fontSize: 12, color: "var(--text3)", margin: "-6px 0 12px" }}>
        Model strengths and costs based on measured Naelao runs where available, otherwise published estimates.
      </p>
      <div className="grid-3">
        {(showAllModels ? listModelBenchmarks() : listModelBenchmarks().slice(0, 6)).map((benchmark) => (
          <Card key={benchmark.id} interactive={false}>
            <CardTitle>{modelLabel(benchmark.id)}{benchmark.id === DEFAULT_WORKING_MODEL && <span style={{ marginLeft: 6, fontSize: 10.5, color: "var(--accent)", fontWeight: 600 }}>DEFAULT</span>}</CardTitle>
            <CardDesc>{benchmark.strengths[0]}</CardDesc>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
              <Badge color={COST_TIER_BADGE[benchmark.costTier]}>{COST_TIER_LABEL[benchmark.costTier]}</Badge>
              {benchmark.costBasis === "estimated" && <Badge color="blue">Estimated cost</Badge>}
              {benchmark.eval && <Badge color={benchmark.eval.usable.startsWith("0") ? "amber" : "green"}>{benchmark.eval.usable} usable · {benchmark.eval.avgScore.toFixed(2)}/10</Badge>}
              {benchmark.neuronsPerRun !== undefined && <Badge color="blue">~{benchmark.neuronsPerRun} neurons/run</Badge>}
            </div>
            {benchmark.axes && Object.keys(benchmark.axes).length > 0 && (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", margin: "2px 0 6px" }}>
                {Object.entries(benchmark.axes).map(([axis, result]) => <span key={axis} title={result.note ?? `${result.passed} of ${result.total} checks passed`} style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, border: "1px solid var(--border)", color: result.passed === result.total ? "var(--text2)" : "var(--text3)", background: result.passed === result.total ? "var(--bg3)" : "transparent" }}>{AXIS_LABEL[axis] ?? axis} {result.passed}/{result.total}</span>)}
              </div>
            )}
            <p style={{ fontSize: 11.5, color: "var(--text3)", margin: "4px 0 0" }}>{benchmark.eval ? benchmark.eval.note : `Best for: ${benchmark.bestFor[0]}`}</p>
          </Card>
        ))}
      </div>
      {!showAllModels && listModelBenchmarks().length > 6 && <Button variant="secondary" onClick={() => setShowAllModels(true)} style={{ marginTop: 10 }}>Show all {listModelBenchmarks().length} models</Button>}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={activationReview ? "Review Space Template" : "Create a Space"} footer={activationReview ? <><Button variant="secondary" onClick={() => { setCreateOpen(false); setActivationReview(null); }}>Later</Button><Button onClick={() => void confirmTemplateActivation()} disabled={!activationReview.preview.ready || activatingTemplate}>{activatingTemplate ? "Installing…" : "Approve and install"}</Button></> : createdSpaceId ? <Button onClick={() => window.location.assign(`/p/${product.slug}/spaces/${createdSpaceId}`)}>Open Space</Button> : <><Button variant="secondary" type="button" onClick={() => setCreateOpen(false)}>Cancel</Button><Button onClick={() => void handleCreate()} disabled={creating || !newSpaceName.trim()}>{creating ? "Creating…" : "Create Space"}</Button></>}>
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 12 }}>Name<FormInput autoFocus maxLength={100} placeholder="What is this Space for?" value={newSpaceName} onChange={(event) => setNewSpaceName(event.target.value)} required /></label>
          {templates.some((template) => template.price_cents === 0) && (
            <label style={{ fontSize: 12 }}>Space Template (optional)<FormSelect value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              <option value="">Start with a blank Space</option>
              {templates.filter((template) => template.price_cents === 0).map((template) => <option key={template.id} value={template.id}>{template.name} · by {template.author_name}</option>)}
            </FormSelect></label>
          )}
          {selectedTemplate && <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, fontSize: 11.5 }}>
            <strong>Template prerequisites</strong>
            {selectedTemplate.planGatedFeatures?.length ? <div style={{ marginTop: 5 }}>
              Plan-gated features: {selectedTemplate.planGatedFeatures.join(", ")}. Availability depends on the Space subscription plan; this preview does not verify the current plan’s entitlement.
            </div> : null}
            {selectedTemplate.requirements ? <>
              <div style={{ marginTop: 5 }}>Required extensions: {selectedTemplate.requirements.extensions.length
                ? selectedTemplate.requirements.extensions.map(item => `${item.id}${item.version ? ` v${item.version}` : " (version pin missing)"}`).join(", ") : "none declared"}</div>
              <div>Setup credentials: {selectedTemplate.requirements.credentials.length
                ? selectedTemplate.requirements.credentials.map(item => `${item.name} (${item.required ? "required" : "optional"}) — ${item.description}`).join("; ") : "none declared"}</div>
              <div>Project runtimes: {selectedTemplate.requirements.runtimes.length
                ? selectedTemplate.requirements.runtimes.map(item => `${item.project_id} · ${item.id}${item.required ? " (required)" : " (optional)"}${item.capabilities.length ? ` [${item.capabilities.join(", ")}]` : ""}`).join("; ") : "none declared"}</div>
            </> : <p style={{ margin: "5px 0 0" }}>This marketplace listing does not include prerequisite details.</p>}
            <p style={{ margin: "6px 0 0", color: "var(--text3)" }}>This is the template’s declared setup. Naelao checks availability and asks you to review access before activation.</p>
          </div>}
          <p style={{ margin: 0, fontSize: 12, color: "var(--text3)" }}>You can install additional extensions and configure the Space after it is created.</p>
          {createError && <p role="alert" style={{ margin: 0, fontSize: 12, color: "#dc2626" }}>{createError}</p>}
          {activationReview && <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, fontSize: 12 }}>
            <strong>{activationReview.preview.ready ? "Ready for your approval" : "Cannot install yet"}</strong>
            <p>This preview made no changes and granted no access.</p>
            <strong>Extensions</strong>
            {activationReview.preview.dependencies.length ? <ul>{activationReview.preview.dependencies.map(item => <li key={item.extension_id}>
              <strong>{item.extension_id}: {item.status}</strong>{item.required_version ? ` (requires ${item.required_version}${item.available_version ? `; available ${item.available_version}` : ""})` : item.status === "version_unpinned" ? " (pin an exact release before installing this template)" : ""}{item.required_digest ? ` · SHA-256 ${item.required_digest.slice(0, 12)}${item.available_digest && item.available_digest !== item.required_digest ? ` (available ${item.available_digest.slice(0, 12)})` : ""}` : ""}
              {item.summary && <div style={{ margin: "4px 0 8px 12px", color: "var(--text3)" }}>
                <div>Declared extension surface only; host grants and per-operation checks still control what can run.</div>
                {item.summary.primitives.length > 0 && <div>Components: {item.summary.primitives.map(part => `${part.kind} ${part.id}${part.scope ? ` [${part.scope}]` : ""}${part.provider ? ` [${part.provider}]` : ""}`).join(", ")}</div>}
                {item.summary.primitives.map(part => <div key={`${part.kind}:${part.id}`} style={{ marginLeft: 10 }}>
                  <strong>{part.kind} {part.id}:</strong> {[...(part.tools?.map(tool => `tool ${tool}`) ?? []), ...(part.gadget_reads?.map(grant => `read ${grant.gadget_id}.${grant.tables.join("/")}`) ?? []), ...part.capabilities.map(capability => `capability ${capability}`), ...part.permissions.map(permission => `access ${permission}`), ...(part.inbound_events?.map(event => `in ${event}`) ?? []), ...(part.outbound_events?.map(event => `out ${event}`) ?? [])].join(", ") || "no declared actions"}
                  {part.resources && ` · ${part.resources.cpu_cores} CPU / ${part.resources.memory_mb} MiB / ${part.resources.timeout_seconds}s`}{part.network_policy && ` · network ${part.network_policy}`}
                </div>)}
                {item.summary.capabilities.length > 0 && <div>Capabilities: {item.summary.capabilities.join(", ")}</div>}
                {item.summary.permissions.length > 0 && <div>Requested access: {item.summary.permissions.join(", ")}</div>}
                {item.summary.commands.length > 0 && <div>Commands: {item.summary.commands.join(", ")}</div>}
                {item.summary.background_jobs.length > 0 && <div>Background jobs: {item.summary.background_jobs.map(job => `${job.id}${job.schedule ? ` (${job.schedule})` : ""} · ${job.memory_scope}`).join(", ")}</div>}
                {item.summary.widgets.length > 0 && <div>Chat widgets: {item.summary.widgets.map(widget => `${widget.event} → ${widget.component}`).join(", ")}</div>}
                {item.summary.connections.length > 0 && <div>Connections: {item.summary.connections.map(connection => `${connection.provider}/${connection.id} (${connection.required ? "required" : "optional"}) — ${connection.purpose}`).join("; ")}</div>}
                {item.summary.knowledge.length > 0 && <div>Knowledge: {item.summary.knowledge.map(item => `${item.purpose} (${item.access})`).join("; ")}</div>}
                {item.summary.shared_filesystem.length > 0 && <div>Shared files: {item.summary.shared_filesystem.map(grant => `${grant.path} (${grant.access})`).join(", ")}</div>}
                {item.summary.approved_shared_filesystem && item.summary.approved_shared_filesystem.length > 0 && <div>Currently approved: {item.summary.approved_shared_filesystem.map(grant => `${grant.path} (${grant.access})`).join(", ")}</div>}
                {item.summary.shared_filesystem.length > 0 && <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 6 }}>
                  <div>{item.status === "installed" ? "Review existing shared-file grants. Existing access stays unless you replace it here." : "Optional shared-file access. Nothing is granted unless selected."}</div>
                  {item.summary.shared_filesystem.map(grant => <label key={grant.path} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
                    <span style={{ flex: 1 }}>{grant.path}</span>
                    <select aria-label={`Access for ${item.extension_id} ${grant.path}`} value={activationReview.filesystemGrantSelections?.[item.extension_id]?.[grant.path] ?? (item.status === "installed" ? "KEEP" : "NONE")}
                      onChange={event => setActivationReview(current => current ? { ...current, filesystemGrantSelections: {
                        ...current.filesystemGrantSelections,
                        [item.extension_id]: { ...current.filesystemGrantSelections?.[item.extension_id], [grant.path]: event.target.value as "KEEP" | "NONE" | "READ" | "READ_WRITE" },
                      } } : current)}>
                      {item.status === "installed" && <option value="KEEP">Keep current</option>}
                      <option value="NONE">No access</option>
                      <option value="READ">Read only</option>
                      {grant.access === "READ_WRITE" && <option value="READ_WRITE">Read and write</option>}
                    </select>
                  </label>)}
                </div>}
                {item.summary.worker_roles.length > 0 && <div>Worker roles: {item.summary.worker_roles.map(role => `${role.id} (${role.execution}/${role.invocation}; ${role.primitive_ids.join(", ") || "no primitives"}${role.gadget_actions.length ? `; ${role.gadget_actions.map(action => `${action.gadget_id} ${action.operations.join("/")} on ${action.tables.join(",")}`).join("; ")}` : ""})`).join("; ")}</div>}
              </div>}
            </li>)}</ul> : <p>None required</p>}
            <strong>Project runtimes</strong>
            {activationReview.preview.runtime_requirements.length ? <ul>{activationReview.preview.runtime_requirements.map(item => <li key={`${item.project_id}:${item.runtime_id}`}>{item.project_id} · {item.runtime_id}: {item.status === "installable" ? "will install after approval" : item.status} ({item.reason}){item.required ? item.status === "installable" ? " · required" : " · required; install is blocked" : " · optional; omitted from this install"}{item.project_slots_required !== undefined && item.project_slots_limit !== undefined ? ` · ${item.project_slots_required} of ${item.project_slots_limit} project container slots planned` : ""}{item.resources ? ` · ${item.resources.cpu_cores} CPU cores / ${item.resources.memory_mb} MiB combined declared resources` : ""}</li>)}</ul> : <p>None declared</p>}
            <strong>Connections to set up</strong>
            {activationReview.preview.setup_credentials.length ? <ul>{activationReview.preview.setup_credentials.map(item => <li key={item.name}>{item.name}{item.required ? " (required)" : " (optional)"}: {item.description}</li>)}</ul> : <p>None required</p>}
            <strong>Extension provider connections</strong>
            {activationReview.preview.extension_connections.length ? <ul>{activationReview.preview.extension_connections.map(connection => <li key={`${connection.extension_id}:${connection.connection_id}`}>
              {connection.extension_id} · {connection.provider}/{connection.connection_id}: {connection.required ? "required" : "optional"} · {connection.required ? "Space-wide provider connection is not supported yet" : "optional provider connection is also unsupported for Space-wide extensions"} — {connection.purpose}
            </li>)}</ul> : <p>None declared</p>}
            <strong>Template evaluation</strong>
            <p>{activationReview.preview.evaluation.passed}/{activationReview.preview.evaluation.total} checks passed · {activationReview.preview.evaluation.evidence} · issued {new Date(activationReview.preview.evaluation.issued_at).toLocaleDateString()}</p>
            <strong>Cost estimate</strong>
            <p>Not available in this preview. Provider charges and runtime usage are not calculated here.</p>
            {!activationReview.preview.ready && <><p role="alert">{activationReview.preview.blockers.join(", ")}</p><Button variant="secondary" disabled={refreshingPreview} onClick={() => void recheckTemplateActivation()}>{refreshingPreview ? "Checking…" : "Recheck dependencies"}</Button></>}
          </div>}
        </form>
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}
