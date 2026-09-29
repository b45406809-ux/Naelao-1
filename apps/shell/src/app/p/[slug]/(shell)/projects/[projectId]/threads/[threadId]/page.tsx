"use client";

export const runtime = "edge";

// A project thread's chat surface, addressed under the project it belongs to
// (/projects/:projectId/threads/:threadId) rather than at the flat /threads/:id — a thread is not
// a free-floating object, it lives in a project, and the URL should say so. The flat route stays
// for now since the standalone Threads browse still links to it.
//
// Threads (SpaceDO `threads`, structural) and chat sessions (SpaceDO `sessions`, the message
// transport) are now linked server-side via threads.session_id (see thread.create in
// project-coordination.ts and startSession's thread_id param) — thread.session_id is passed
// straight to Chat below rather than relying on sessionKey's client-side cache.
//
// A left rail lists this project's OTHER threads (collapsible) so a person can move between
// conversations in the same project without going back to the project page first — reuses the
// same .spaces-layout/.spaces-sidebar shell the project page's own tree already uses, but does
// NOT use .spaces-content for the chat side: that class adds its own padding + overflow-y:auto,
// which would fight Chat's own internal .chat-layout/.chat-area scroll and sticky-composer
// layout. Chat is mounted as a direct flex sibling instead so its own flex:1 sizing still works.

import * as React from "react";
import { useParams } from "next/navigation";
import { useProduct } from "@/lib/product-context";
import { ProjectCanvas } from "@/components/ProjectCanvas";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { getProject, getThread, listThreads, type Project, type ThreadSummary } from "@/lib/api";

export default function ProjectThreadPage() {
  const params = useParams<{ projectId: string; threadId: string }>();
  const product = useProduct();
  const { activeSpaceId, supportContact } = useActiveSpace();
  const { session } = useProductAuth();
  const [thread, setThread] = React.useState<ThreadSummary | null>(null);
  const [project, setProject] = React.useState<Project | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [siblingThreads, setSiblingThreads] = React.useState<ThreadSummary[]>([]);


  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  React.useEffect(() => {
    if (!creds) return;
    let cancelled = false;
    setThread(null);
    setLoadFailed(false);
    void Promise.all([getThread(activeSpaceId, params.threadId, creds), getProject(activeSpaceId, params.projectId, creds)])
      .then(([t, p]) => {
        if (!cancelled) { setThread(t); setProject(p); }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, params.threadId, session]);

  // The rail's own thread list — a separate fetch from the single-thread lookup above, and
  // deliberately not blocking on it: a slow/failed list fetch shouldn't hold up opening the
  // thread itself, it just means the rail renders with nothing (or stays as it was) that tick.
  React.useEffect(() => {
    if (!creds) return;
    let cancelled = false;
    void listThreads(activeSpaceId, creds, { projectId: params.projectId })
      .then((list) => {
        if (!cancelled) setSiblingThreads(list);
      })
      .catch(() => {
        /* the rail just shows nothing this render; the thread itself still opens */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, params.projectId, params.threadId, session]);

  if (!creds) return null;
  if (loadFailed) {
    return (
      <div className="page-view">
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Couldn't load this thread. Try again from the project.</p>
      </div>
    );
  }
  // Wait for the thread to load before mounting Chat, rather than rendering it immediately with
  // no session_id known yet: Chat's `sessionId` prop is read once, on mount, to decide whether to
  // reuse an existing linked session or fall back to client-side caching. Rendering Chat before
  // the thread loads would always take the fallback path — for a thread that already HAS a
  // session (opened again, or from a different browser/tab), that meant minting a brand new,
  // unlinked session every time instead of reusing the real one.
  if (!thread || !project) return <div className="page-view">Loading…</div>;

  return <ProjectCanvas project={project} threads={siblingThreads} thread={thread} spaceId={activeSpaceId} slug={product.slug} session={creds} supportContact={supportContact} />;
}
