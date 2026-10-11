"use client";


// A thread's own chat surface (the flat /threads/:id route, reached from the Sessions browse
// list). threads.session_id (added for exactly this) links it to the real chat session — passed
// through to Chat below the same way the project-scoped page at
// projects/[projectId]/threads/[threadId]/page.tsx already does, so a thread the assistant (or
// the "New Session" button) created reuses its real linked session instead of Chat's own
// lazy-mint fallback minting a second, unlinked one.

import * as React from "react";
import { useParams } from "next/navigation";
import { Chat } from "@/components/Chat";
import { ProjectCanvas } from "@/components/ProjectCanvas";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { getProject, getThread, listThreads, type Project, type ThreadSummary } from "@/lib/api";

export default function ThreadChatPage() {
  const params = useParams<{ threadId: string }>();
  const product = useProduct();
  const { activeSpaceId, supportContact } = useActiveSpace();
  const { session } = useProductAuth();
  const [thread, setThread] = React.useState<ThreadSummary | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [project, setProject] = React.useState<Project | null>(null);
  const [projectThreads, setProjectThreads] = React.useState<ThreadSummary[]>([]);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  React.useEffect(() => {
    if (!creds) return;
    let cancelled = false;
    setThread(null);
    setLoadFailed(false);
    void getThread(activeSpaceId, params.threadId, creds)
      .then(async (t) => {
        if (!cancelled) setThread(t);
        if (t.project_id) {
          const [nextProject, siblings] = await Promise.all([
            getProject(activeSpaceId, t.project_id, creds),
            listThreads(activeSpaceId, creds, { projectId: t.project_id, includeSubThreads: true }),
          ]);
          if (!cancelled) { setProject(nextProject); setProjectThreads(siblings); }
        } else if (!cancelled) {
          setProject(null); setProjectThreads([]);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, params.threadId, session]);

  if (!creds) return null;
  if (loadFailed) {
    return (
      <div className="page-view">
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Couldn't load this thread. Try again from Sessions.</p>
      </div>
    );
  }
  // Wait for the thread to load, same reasoning as the project-scoped page: rendering Chat before
  // we know thread.session_id always takes the lazy-mint fallback, which would mint an unlinked
  // session even for a thread that already HAS one.
  if (!thread) return <div className="page-view">Loading…</div>;

  if (thread.project_id && !project) return <div className="page-view">Loading project…</div>;
  if (project) return <ProjectCanvas project={project} threads={projectThreads} thread={thread} spaceId={activeSpaceId} slug={product.slug} session={creds} supportContact={supportContact} />;
  return (
    <Chat
      spaceId={activeSpaceId}
      session={creds}
      sessionKey={params.threadId}
      title={thread.title ?? "Thread"}
      threadId={params.threadId}
      {...(thread.session_id ? { sessionId: thread.session_id } : {})}
    />
  );
}
