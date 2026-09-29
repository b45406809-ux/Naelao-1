"use client";

import * as React from "react";
import Link from "next/link";
import type { Project, ThreadSummary } from "@/lib/api";
import type { SessionCredentials } from "@/lib/api";
import { Chat } from "./Chat";
import { CanvasContainer } from "./CanvasContainer";

export function ProjectCanvas({ project, threads, thread, spaceId, slug, session, supportContact }: { project: Project; threads: ThreadSummary[]; thread: ThreadSummary; spaceId: string; slug: string; session: SessionCredentials; supportContact?: string | null }) {
  const [canvasWidth, setCanvasWidth] = React.useState(44);
  const [maximized, setMaximized] = React.useState(false);
  const [mobilePane, setMobilePane] = React.useState<"chat" | "canvas">("chat");
  const shell = React.useRef<HTMLDivElement>(null);
  const resize = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => { const bounds = shell.current?.getBoundingClientRect(); if (bounds) setCanvasWidth(Math.min(60, Math.max(35, ((bounds.right - e.clientX) / bounds.width) * 100))); };
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };
  return <div className="project-workspace" data-testid="project-workspace">
    <nav className="project-rail" aria-label="Project navigation" data-testid="left-rail">
      <Link href={`/p/${slug}/spaces`} className="org-switcher"><span>◫</span><div><small>Organization</small><strong>{project.name}</strong></div><span>⌄</span></Link>
      <div className="rail-section"><h2># Team Room</h2><Link className="active" href={`/p/${slug}/projects/${project.id}/threads/${thread.id}`}>General</Link></div>
      <div className="rail-section"><h2>Tasks</h2>{threads.filter(t => t.thread_kind !== "private").map(t => <Link className={t.id === thread.id ? "active" : ""} key={t.id} href={`/p/${slug}/projects/${project.id}/threads/${t.id}`}>◇ {t.title || "Untitled task"}</Link>)}</div>
      <div className="rail-section"><h2>Private Drafts</h2>{threads.filter(t => t.thread_kind === "private").map(t => <Link key={t.id} href={`/p/${slug}/projects/${project.id}/threads/${t.id}`}>◌ {t.title || "Draft"}</Link>)}</div>
      <div className="journal-dag"><h2>Project Journal</h2><div><i /> <span><b>Now</b>{thread.title}</span></div><div><i /> <span><b>Project created</b>{new Date(project.created_at).toLocaleDateString()}</span></div></div>
    </nav>
    <div className="mobile-workspace-toggle" role="tablist"><button className={mobilePane === "chat" ? "active" : ""} onClick={() => setMobilePane("chat")}>💬 Chat</button><button className={mobilePane === "canvas" ? "active" : ""} onClick={() => setMobilePane("canvas")}>🖥️ Canvas</button></div>
    <div ref={shell} className={`workspace-stage mobile-${mobilePane}${maximized ? " canvas-is-maximized" : ""}`}>
      <main className="conversation-stage" data-testid="center-chat" style={{ width: maximized ? 0 : `${100 - canvasWidth}%` }}><Chat spaceId={spaceId} session={session} sessionKey={thread.id} title={thread.title ?? "Thread"} {...(supportContact !== undefined ? { supportContact } : {})} threadId={thread.id} projectId={project.id} {...(thread.session_id ? { sessionId: thread.session_id } : {})} /></main>
      {!maximized && <div className="canvas-divider" role="separator" aria-label="Resize canvas" aria-orientation="vertical" onPointerDown={resize}><span /></div>}
      <aside className="canvas-sidebar" data-testid="right-canvas" style={{ width: maximized ? "100%" : `${canvasWidth}%` }}><CanvasContainer project={project} spaceId={spaceId} creds={session} maximized={maximized} onMaximize={() => setMaximized(v => !v)} /></aside>
    </div>
  </div>;
}
