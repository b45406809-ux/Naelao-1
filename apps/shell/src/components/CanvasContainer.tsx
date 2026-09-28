"use client";
import * as React from "react";
import { listWorkspaceFiles, readWorkspaceFile, type Project, type WorkspaceFile, type WorkspaceFileContent } from "@/lib/api";
import { AppStudioCanvas, CodeCanvas, CustomerBotCanvas, DocStudioCanvas, GrowthEngineCanvas, ModelStudioCanvas, VoiceAgentCanvas, type ViewportProps } from "./viewports/DomainCanvases";

type Creds = { sessionToken: string; endUserId: string };
const VIEWPORTS: Record<string, React.ComponentType<ViewportProps>> = { product_dev: CodeCanvas, doc_studio: DocStudioCanvas, voice_agent: VoiceAgentCanvas, customer_bot: CustomerBotCanvas, model_studio: ModelStudioCanvas, growth_engine: GrowthEngineCanvas, app_studio: AppStudioCanvas };
export function CanvasContainer({ project, spaceId, creds, copilot }: { project: Project; spaceId: string; creds: Creds; copilot?: React.ReactNode }) {
  const [files, setFiles] = React.useState<WorkspaceFile[]>([]), [selected, setSelected] = React.useState<WorkspaceFileContent | null>(null), [dockOpen, setDockOpen] = React.useState(true);
  const socket = React.useRef<WebSocket | null>(null);
  React.useEffect(() => { let live = true; const refresh = () => listWorkspaceFiles(spaceId, project.id, creds).then(v => live && setFiles(v)).catch(() => {}); void refresh(); const timer = window.setInterval(refresh, 3000); return () => { live = false; clearInterval(timer); }; }, [spaceId, project.id, creds.sessionToken]);
  React.useEffect(() => { const base = process.env.NEXT_PUBLIC_WS_GATEWAY_URL; if (!base) return; const url = new URL("/ws", base); url.searchParams.set("spaceId", spaceId); url.searchParams.set("userId", creds.endUserId); url.searchParams.set("agentId", project.default_agent_id ?? "naelao-agent"); url.searchParams.set("sessionId", `canvas:${project.id}`); const ws = new WebSocket(url); socket.current = ws; return () => { socket.current = null; ws.close(); }; }, [spaceId, project.id, project.default_agent_id, creds.endUserId]);
  const onSelect = React.useCallback((path: string) => { void readWorkspaceFile(spaceId, project.id, path, creds).then(setSelected); }, [spaceId, project.id, creds.sessionToken]);
  const onAction = React.useCallback((action: string, payload: Record<string, unknown> = {}) => { const event = { type: "mcp.ui_action", projectId: project.id, user: creds.endUserId, action, payload }; window.postMessage(event, window.location.origin); window.dispatchEvent(new CustomEvent("naelao:mcp-ui-action", { detail: event })); if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(event)); }, [project.id, creds.endUserId]);
  const Viewport = VIEWPORTS[project.kind ?? ""];
  if (!Viewport) return null;
  return <section aria-label="Project canvas" style={{ width: "100%", display: "grid", gridTemplateColumns: dockOpen ? "minmax(0, 85fr) minmax(260px, 15fr)" : "1fr auto", gap: 10, minHeight: 560 }}><main><Viewport files={files} selected={selected} onSelect={onSelect} onAction={onAction}/></main><aside aria-label="Docked copilot" style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}><button type="button" className="btn btn-ghost" style={{ width: "100%" }} onClick={() => setDockOpen(v => !v)}>{dockOpen ? "Hide copilot" : "Chat"}</button>{dockOpen && <div style={{ padding: 10 }}>{copilot ?? <p style={{ color: "var(--text3)", fontSize: 12 }}>Open a thread to work with your autonomous project copilot.</p>}</div>}</aside></section>;
}
