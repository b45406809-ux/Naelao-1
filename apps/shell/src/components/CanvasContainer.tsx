"use client";

import * as React from "react";
import { listWorkspaceFiles, readWorkspaceFile, type Project, type WorkspaceFile, type WorkspaceFileContent } from "@/lib/api";
import { CodeCanvas, CustomerBotCanvas, GrowthEngineCanvas, ModelStudioCanvas, VoiceAgentCanvas, type ViewportProps } from "./viewports/DomainCanvases";
import { DocumentRedlineCanvas } from "./viewports/DocumentRedlineCanvas";
import { SpreadsheetFormulaGrid } from "./viewports/SpreadsheetFormulaGrid";
import { MicroAppCanvas } from "./viewports/MicroAppCanvas";
import { ContainerTerminalCanvas } from "./viewports/ContainerTerminalCanvas";
import { VirtualDesktopGuiCanvas } from "./viewports/VirtualDesktopGuiCanvas";

type Creds = { sessionToken: string; endUserId: string };
type HeaderTab = "canvases" | "files" | "details";
type CanvasView = "deliverable" | "micro-app" | "terminal" | "gui";
const DOMAIN_VIEWPORTS: Record<string, React.ComponentType<ViewportProps>> = { product_dev: CodeCanvas, voice_agent: VoiceAgentCanvas, customer_bot: CustomerBotCanvas, model_studio: ModelStudioCanvas, growth_engine: GrowthEngineCanvas };

export function CanvasContainer({ project, spaceId, creds, maximized = false, onMaximize = () => {} }: { project: Project; spaceId: string; creds: Creds; maximized?: boolean; onMaximize?(): void }) {
  const [files, setFiles] = React.useState<WorkspaceFile[]>([]);
  const [selected, setSelected] = React.useState<WorkspaceFileContent | null>(null);
  const [tab, setTab] = React.useState<HeaderTab>("canvases");
  const [view, setView] = React.useState<CanvasView>(project.kind === "app_studio" ? "micro-app" : "deliverable");
  const [terminalLines, setTerminalLines] = React.useState<string[]>([]);
  const [connected, setConnected] = React.useState(false);
  const socket = React.useRef<WebSocket | null>(null);
  const selectedRef = React.useRef(selected);
  React.useEffect(() => { selectedRef.current = selected; }, [selected]);

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

  const hasContainer = Boolean(project.channel_config?.container_enabled);
  const views: { id: CanvasView; label: string }[] = [{ id: "deliverable", label: "📄 Deliverable" }];
  if (project.kind === "app_studio" || project.channel_config?.app_id) views.push({ id: "micro-app", label: "📱 Micro-App" });
  if (hasContainer) views.push({ id: "terminal", label: "💻 Terminal" }, { id: "gui", label: "🖥️ GUI Display" });
  const props = { files, selected, onSelect, onAction };
  const DomainViewport = DOMAIN_VIEWPORTS[project.kind ?? ""];
  const deliverable = project.kind === "doc_studio" ? <DocumentRedlineCanvas {...props} /> : project.kind === "finance_grid" || project.kind === "quant_desk" ? <SpreadsheetFormulaGrid {...props} /> : DomainViewport ? <DomainViewport {...props} /> : <CodeCanvas {...props} />;
  const appId = String(project.channel_config?.app_id ?? project.id);
  const desktopUrl = typeof project.channel_config?.desktop_stream_url === "string" ? project.channel_config.desktop_stream_url : null;

  return <section className={`canvas-container${maximized ? " maximized" : ""}`} aria-label="Canvas container" data-testid="canvas-container">
    <header className="canvas-header"><nav aria-label="Canvas sections">{(["canvases", "files", "details"] as HeaderTab[]).map(id => <button key={id} type="button" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{id === "canvases" ? "📄 Canvases" : id === "files" ? "📁 Files" : "ℹ️ Details"}</button>)}</nav><button type="button" className="canvas-maximize" onClick={onMaximize} aria-label={maximized ? "Restore canvas" : "Maximize canvas"}>{maximized ? "⤡ Restore" : "⤢ Maximize"}</button></header>
    {tab === "canvases" && <><nav className="canvas-switcher" aria-label="Available canvas views">{views.map(item => <button key={item.id} type="button" className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>{item.label}</button>)}</nav><div className="canvas-viewport">{view === "deliverable" && deliverable}{view === "micro-app" && <MicroAppCanvas spaceId={spaceId} appId={appId} onAction={onAction} />}{view === "terminal" && <ContainerTerminalCanvas lines={terminalLines} connected={connected} />}{view === "gui" && <VirtualDesktopGuiCanvas {...(desktopUrl ? { streamUrl: desktopUrl } : {})} />}</div></>}
    {tab === "files" && <div className="canvas-panel"><h3>Workspace files</h3>{files.map(file => <button key={file.path} type="button" className={selected?.path === file.path ? "active" : ""} onClick={() => { onSelect(file.path); setTab("canvases"); }}>{file.path}<small>{Math.ceil(file.size / 1024)} KB</small></button>)}</div>}
    {tab === "details" && <div className="canvas-details"><span className="canvas-eyebrow">Active project</span><h3>{project.name}</h3><p>{project.description || "No project description."}</p><dl><dt>Canvas</dt><dd>{project.kind ?? "workspace"}</dd><dt>Live sync</dt><dd>{connected ? "Connected" : "Polling fallback"}</dd><dt>File</dt><dd>{selected?.path ?? "None selected"}</dd></dl></div>}
  </section>;
}
