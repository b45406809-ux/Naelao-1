"use client";

import type { Project, ThreadSummary } from "@/lib/api";
import type { SessionCredentials } from "@/lib/api";
import { PrivateScratchpad } from "./PrivateScratchpad";
import { Chat } from "./Chat";

export function ProjectCanvas({ project, threads, thread, spaceId, slug, session, supportContact }: { project: Project; threads: ThreadSummary[]; thread: ThreadSummary; spaceId: string; slug: string; session: SessionCredentials; supportContact?: string | null }) {
  if (thread.thread_tier === "tier_4_scratchpad") return thread.session_id ? <PrivateScratchpad spaceId={spaceId} sessionId={thread.session_id} session={session} /> : <p>Scratchpad session unavailable.</p>;
  return <div className="project-workspace project-workspace-flat" data-testid="project-workspace">
    <Chat
      spaceId={spaceId}
      session={session}
      sessionKey={thread.id}
      title={thread.title ?? "Thread"}
      {...(supportContact !== undefined ? { supportContact } : {})}
      threadId={thread.id}
      projectId={project.id}
      project={project}
      projectThreads={threads}
      slug={slug}
      {...(thread.session_id ? { sessionId: thread.session_id } : {})}
    />
  </div>;
}
