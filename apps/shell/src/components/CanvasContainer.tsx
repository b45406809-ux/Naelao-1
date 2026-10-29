"use client";

import * as React from "react";
import { listContainerInstallations, listWorkspaceFiles, readWorkspaceFile, updateDocumentNodeLease, type Project, type WorkspaceFile, type WorkspaceFileContent } from "@/lib/api";
import { CodeCanvas } from "./viewports/DomainCanvases";
import { DocumentRedlineCanvas } from "./viewports/DocumentRedlineCanvas";
import { SpreadsheetFormulaGrid } from "./viewports/SpreadsheetFormulaGrid";
import { MicroAppCanvas } from "./viewports/MicroAppCanvas";
import { ContainerTerminalCanvas } from "./viewports/ContainerTerminalCanvas";
import { VirtualDesktopGuiCanvas } from "./viewports/VirtualDesktopGuiCanvas";

type Creds = { sessionToken: string; endUserId: string };
type HeaderTab = "canvases" | "files" | "details";
type ExtensionCanvasChoice = { resourceId: string; canvasId: string; installationId: string; gadgetReads: Array<{ gadgetId: string; tables: string[] }>; label: string };
export type CanvasView = "deliverable" | "code" | "micro-app" | "terminal" | "gui";
type HydrationAction = { id: string; label: string; kind: "open_file" | "review_file"; path: string } | { id: string; label: string; kind: "open_channel_settings"; channel: "whatsapp" };

function parseHydrationSeed(value: unknown): { title: string; description: string; actions: HydrationAction[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const seed = row.hydration_seed;
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) return null;
  const data = seed as Record<string, unknown>;
  if (data.version !== 1 || typeof data.title !== "string" || typeof data.description !== "string" || !Array.isArray(data.actions)) return null;
  const actions = data.actions.filter((action): action is HydrationAction => {
    if (!action || typeof action !== "object" || Array.isArray(action)) return false;
    const item = action as Record<string, unknown>;
    return typeof item.id === "string" && typeof item.label === "string" && (
      ((item.kind === "open_file" || item.kind === "review_file") && typeof item.path === "string") ||
      (item.kind === "open_channel_settings" && item.channel === "whatsapp")
    );
  });
  return { title: data.title, description: data.description, actions };
}

export function CanvasContainer({ project, spaceId, creds, maximized = false, onMaximize = () => {}, standalone = false, canvasView }: { project: Project; spaceId: string; creds: Creds; maximized?: boolean; onMaximize?(): void; standalone?: boolean; canvasView?: CanvasView }) {
  const [files, setFiles] = React.useState<WorkspaceFile[]>([]);
  const [selected, setSelected] = React.useState<WorkspaceFileContent | null>(null);
  const [tab, setTab] = React.useState<HeaderTab>("canvases");
  const [extensionCanvases, setExtensionCanvases] = React.useState<ExtensionCanvasChoice[]>([]);
  const [canvasProjectId, setCanvasProjectId] = React.useState("");
  const [selectedExtensionCanvas, setSelectedExtensionCanvas] = React.useState<string | null>(null);
  const [canvasLoadError, setCanvasLoadError] = React.useState<string | null>(null);
  const isExtensionCanvas = canvasProjectId === project.id && selectedExtensionCanvas !== null;
  const legacyCanvasResource = project.viewport_config?.component === "CanvasMount" && typeof project.viewport_config.resourceId === "string"
    ? project.viewport_config.resourceId : null;
  const hasCanvasMount = Boolean(isExtensionCanvas || legacyCanvasResource);
  const appId = String(project.channel_config?.app_id ?? (isExtensionCanvas ? selectedExtensionCanvas : null) ?? legacyCanvasResource ?? project.id);
  const [view, setView] = React.useState<CanvasView>(canvasView ?? (project.channel_config?.app_id || hasCanvasMount ? "micro-app" : "deliverable"));
  const [terminalLines, setTerminalLines] = React.useState<string[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = React.useState(false);
  const socket = React.useRef<WebSocket | null>(null);
  const selectedRef = React.useRef(selected);
  React.useEffect(() => { selectedRef.current = selected; }, [selected]);

  React.useEffect(() => {
    let cancelled = false;
    setCanvasProjectId(""); setExtensionCanvases([]); setCanvasLoadError(null); setSelectedExtensionCanvas(null);
    listContainerInstallations(spaceId, creds, project.id).then(result => {
      if (cancelled) return;
      const choices = result.installations.flatMap(installation => {
        const { instance, manifest } = installation;
        if (instance.status !== "active" || instance.project_id !== project.id || !instance.instance_id || !manifest.bundle?.primitives) return [];
        return manifest.bundle.primitives.filter(primitive => primitive.kind === "canvas" && typeof primitive.id === "string")
          .map(primitive => {
            const resourceId = instance.instance_key && instance.instance_key !== "default" ? `${instance.instance_key}_${primitive.id}` : primitive.id!;
            return /^[a-z][a-z0-9_-]{1,63}$/.test(resourceId) ? { resourceId, canvasId: primitive.id!, installationId: instance.instance_id!, gadgetReads: primitive.gadgetReads ?? [], label: `${manifest.id ?? instance.extension_id} · ${primitive.id}` } : null;
          }).filter((item): item is ExtensionCanvasChoice => item !== null);
      });
      setExtensionCanvases(choices); setCanvasProjectId(project.id);
      const params = new URLSearchParams(window.location.search);
      const requested = params.get("canvas");
      const validRequested = requested && choices.some(choice => choice.resourceId === requested) ? requested : null;
      const selected = validRequested ?? (legacyCanvasResource && choices.some(choice => choice.resourceId === legacyCanvasResource) ? legacyCanvasResource : choices[0]?.resourceId ?? null);
      setSelectedExtensionCanvas(selected);
      if (selected) setView(current => current === "deliverable" ? "micro-app" : current);
      if (requested !== selected) {
        if (selected) params.set("canvas", selected); else params.delete("canvas");
        const query = params.toString();
        window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
      }
    }).catch(error => {
      if (!cancelled) { setCanvasProjectId(project.id); setCanvasLoadError(error instanceof Error ? error.message : "Extension canvases are unavailable."); }
    });
    return () => { cancelled = true; };
  }, [spaceId, project.id, creds.sessionToken, creds.endUserId, legacyCanvasResource]);

  React.useEffect(() => {
    const onPopState = () => {
      const requested = new URLSearchParams(window.location.search).get("canvas");
      if (requested && extensionCanvases.some(choice => choice.resourceId === requested)) {
        setSelectedExtensionCanvas(requested); setView("micro-app");
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [extensionCanvases]);

  const selectExtensionCanvas = React.useCallback((resourceId: string) => {
    if (!extensionCanvases.some(choice => choice.resourceId === resourceId)) return;
    setSelectedExtensionCanvas(resourceId); setView("micro-app");
    const params = new URLSearchParams(window.location.search); params.set("canvas", resourceId);
    window.history.pushState({}, "", `${window.location.pathname}?${params.toString()}${window.location.hash}`);
  }, [extensionCanvases]);

  const refresh = React.useCallback(async () => {
    const next = await listWorkspaceFiles(spaceId, project.id, creds);
    setFiles(next);
    const current = selectedRef.current;
    if (current && next.some(file => file.path === current.path)) setSelected(await readWorkspaceFile(spaceId, project.id, current.path, creds));
    else if (!current && next[0]) setSelected(await readWorkspaceFile(spaceId, project.id, next[0].path, creds));
  }, [spaceId, project.id, creds.sessionToken, creds.endUserId]);

  React.useEffect(() => { let live = true; void refresh().catch(() => {}); const timer = window.setInterval(() => { if (live) void refresh().catch(() => {}); }, 3000); return () => { live = false; clearInterval(timer); }; }, [refresh]);
  React.useEffect(() => {
    const base = process.env.NEXT_PUBLIC_WS_GATEWAY_URL;
    if (!base) return;
    const url = new URL("/ws", base); url.searchParams.set("spaceId", spaceId); url.searchParams.set("userId", creds.endUserId); url.searchParams.set("agentId", project.default_agent_id ?? "naelao-agent"); url.searchParams.set("sessionId", `canvas:${project.id}`);
    const ws = new WebSocket(url); socket.current = ws;
    ws.onopen = () => setConnected(true); ws.onclose = () => setConnected(false);
    ws.onmessage = event => { let message: { type?: string; line?: string } = {}; try { message = JSON.parse(String(event.data)); } catch { return; } if (message.type === "container.output" && message.line) setTerminalLines(lines => [...lines.slice(-999), message.line!]); else window.setTimeout(() => void refresh().catch(() => {}), 100); };
    return () => { socket.current = null; ws.close(); };
  }, [spaceId, project.id, project.default_agent_id, creds.endUserId, refresh]);
  const onSelect = React.useCallback((path: string) => { void readWorkspaceFile(spaceId, project.id, path, creds).then(setSelected); }, [spaceId, project.id, creds.sessionToken, creds.endUserId]);
  const onAction = React.useCallback((action: string, payload: Record<string, unknown> = {}) => { const event = { type: "mcp.ui_action", projectId: project.id, user: creds.endUserId, action, payload }; window.dispatchEvent(new CustomEvent("naelao:mcp-ui-action", { detail: event })); if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(event)); }, [project.id, creds.endUserId]);
  const onLease = React.useCallback(async (operation: "claim" | "renew" | "release", nodeId: string) => {
    try { return await updateDocumentNodeLease(spaceId, project.id, nodeId, operation, creds); }
    catch (error) {
      const apiError = typeof error === "object" && error ? error as { errorCode?: unknown; status?: unknown } : {};
      return { error_code: typeof apiError.errorCode === "string" ? apiError.errorCode : apiError.status === 409 ? "node_lease_conflict" : "node_lease_unavailable" };
    }
  }, [spaceId, project.id, creds.sessionToken, creds.endUserId]);

  const hasContainer = Boolean(project.channel_config?.container_enabled);
  const views: { id: CanvasView; label: string }[] = [{ id: "deliverable", label: "📄 Deliverable" }, { id: "code", label: "⌘ Code Canvas" }];
  if (project.channel_config?.app_id || hasCanvasMount) views.push({ id: "micro-app", label: hasCanvasMount ? "🧩 Extension Canvas" : "📱 Micro-App" });
  if (hasContainer) views.push({ id: "terminal", label: "💻 Terminal" }, { id: "gui", label: "🖥️ GUI Display" });
  const props = { files, selected, onSelect, onAction, onLease, bare: standalone };
  const component = project.viewport_config?.component;
  const activeExtensionCanvas = extensionCanvases.find(choice => choice.resourceId === selectedExtensionCanvas);
  const extensionCanvasProps = activeExtensionCanvas ? { extensionInstallationId: activeExtensionCanvas.installationId, extensionCanvasId: activeExtensionCanvas.canvasId, readableGadgets: activeExtensionCanvas.gadgetReads } : {};
  const deliverable = component === "DocumentRedlineCanvas" ? <DocumentRedlineCanvas {...props} /> : component === "SpreadsheetFormulaGrid" ? <SpreadsheetFormulaGrid {...props} /> : <CodeCanvas {...props} />;
  const activeView = canvasView ?? view;
  const desktopUrl = typeof project.channel_config?.desktop_stream_url === "string" ? project.channel_config.desktop_stream_url : null;
  const hydrationSeed = parseHydrationSeed(project.channel_config);
  React.useEffect(() => setWelcomeDismissed(false), [project.id]);

  const canvas = <div className="canvas-viewport">
    {hydrationSeed && !welcomeDismissed && <section className="card" aria-label="Template welcome" data-testid="template-welcome" style={{ margin: 12, padding: 14 }}>
      <span className="canvas-eyebrow">Getting started</span><h3>{hydrationSeed.title}</h3><p>{hydrationSeed.description}</p>
      <div className="clause-actions">{hydrationSeed.actions.map(action => <button key={action.id} type="button" className="btn btn-primary btn-sm" onClick={() => {
        if (action.kind === "open_file") onSelect(action.path);
        else if (action.kind === "review_file") onAction(action.label === "Run sample audit" ? "template.run_sample_audit" : "template.review_starter", { path: action.path, ...(action.label === "Run sample audit" ? { mode: "synthetic_fixture_audit" } : {}) });
        else {
          const slug = window.location.pathname.split("/")[2];
          if (slug) window.location.assign(`/p/${encodeURIComponent(slug)}/dashboard/assistant`);
        }
      }}>{action.label}</button>)}<button type="button" className="btn btn-ghost btn-sm" onClick={() => setWelcomeDismissed(true)}>Dismiss</button></div>
    </section>}
    {canvasLoadError && <div role="status" className="canvas-error">Installed Canvas list unavailable: {canvasLoadError}</div>}
    {activeView === "micro-app" && extensionCanvases.length > 1 && <label className="canvas-extension-select">Extension Canvas <select aria-label="Active extension Canvas" value={appId} onChange={event => selectExtensionCanvas(event.target.value)}>{extensionCanvases.map(choice => <option key={choice.resourceId} value={choice.resourceId}>{choice.label}</option>)}</select></label>}
    {activeView === "deliverable" && (hasCanvasMount ? <MicroAppCanvas spaceId={spaceId} appId={appId} projectId={project.id} projectScoped session={creds} {...extensionCanvasProps} onAction={onAction} /> : deliverable)}{activeView === "code" && <CodeCanvas {...props} />}{activeView === "micro-app" && <MicroAppCanvas spaceId={spaceId} appId={appId} projectId={project.id} projectScoped={hasCanvasMount} session={creds} {...extensionCanvasProps} onAction={onAction} />}{activeView === "terminal" && <ContainerTerminalCanvas lines={terminalLines} connected={connected} />}{activeView === "gui" && <VirtualDesktopGuiCanvas {...(desktopUrl ? { streamUrl: desktopUrl } : {})} />}</div>;
  if (standalone) return <section className={`canvas-container canvas-standalone${maximized ? " maximized" : ""}`} aria-label={canvasView === "code" ? "Code canvas" : "Canvas"} data-testid="canvas-container">{canvas}</section>;
  return <section className={`canvas-container${maximized ? " maximized" : ""}`} aria-label="Canvas container" data-testid="canvas-container">
    <header className="canvas-header"><nav aria-label="Canvas sections">{(["canvases", "files", "details"] as HeaderTab[]).map(id => <button key={id} type="button" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{id === "canvases" ? "📄 Canvases" : id === "files" ? "📁 Files" : "ℹ️ Details"}</button>)}</nav><button type="button" className="canvas-maximize" onClick={onMaximize} aria-label={maximized ? "Restore canvas" : "Maximize canvas"}>{maximized ? "⤡ Restore" : "⤢ Maximize"}</button></header>
    {tab === "canvases" && <><nav className="canvas-switcher" aria-label="Available canvas views">{views.map(item => <button key={item.id} type="button" className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>{item.label}</button>)}</nav>{canvas}</>}
    {tab === "files" && <div className="canvas-panel"><h3>Workspace files</h3>{files.map(file => <button key={file.path} type="button" className={selected?.path === file.path ? "active" : ""} onClick={() => { onSelect(file.path); setTab("canvases"); }}>{file.path}<small>{Math.ceil(file.size / 1024)} KB</small></button>)}</div>}
    {tab === "details" && <div className="canvas-details"><span className="canvas-eyebrow">Active project</span><h3>{project.name}</h3><p>{project.description || "No project description."}</p><dl><dt>Project kind</dt><dd>{project.kind ?? "DualPane"}</dd><dt>Live sync</dt><dd>{connected ? "Connected" : "Polling fallback"}</dd><dt>File</dt><dd>{selected?.path ?? "None selected"}</dd></dl></div>}
  </section>;
}
