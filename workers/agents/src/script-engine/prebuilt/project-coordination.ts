/**
 * project-coordination (§A1.18 thread model) — lets a Space Assistant coordinate with a named
 * project agent without mixing that exchange into the visible user<->agent transcript, gives it
 * a narrow way to look at a project's OTHER threads on demand, and — as of this pass — the same
 * everyday thread operations a human has: open one, rename or archive it, find one by name, and
 * actually chat inside an existing thread rather than only through a hidden side channel.
 *
 * Design (see CLAUDE.md item 75 for the full reasoning): a project thread is the person and
 * whichever agent is working — two visible parties, no addressing ambiguity. When the assistant
 * needs to talk TO that agent (a handoff, a status check, an instruction) WITHOUT it appearing in
 * the visible thread, that's `agent.consult` — a real, separate conversation in its own subthread
 * (thread_kind='sub_agent', parent_thread_id), hidden by default and expandable in the shell.
 * `thread.send_message` is the other half: when the point IS for the message (and, unless
 * respond:false, the target agent's reply) to actually show up in a real, visible thread — the
 * assistant participating the way a person types into a thread and gets an answer. "Context is
 * not lost" is mostly already solved without shared transcripts — Memory OS L3/L4/L6
 * (project-shared) and the Project Journal carry the DISTILLED state across every thread in a
 * project — this script is for the rarer cases of needing the RAW exchange itself: consulting an
 * agent privately, chatting in a visible thread, or auditing exactly what was said in one.
 *
 * `thread.list`/`thread.read`/`thread.search` are read-only and never gated (same precedent as
 * workspace-admin's `project.list`/`agent.list`). `agent.consult` is left ungated by default too —
 * it dispatches the assistant's own normal operating cost (one run), same posture as @mention
 * dispatch; whatever the consulted agent decides to DO is still gated by its own
 * agent_policy_overrides/assistant_policy exactly as if a human had asked it directly.
 * `thread.create`/`thread.rename`/`thread.delete`/`thread.send_message` ARE gated by default —
 * each is either a structural write or a real dispatched run, and the guided policy's job is to
 * let the owner see structure and cost appear on purpose rather than accumulate.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";

async function spacesCall(ctx: PrebuiltOpContext, method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.spacesWorker) throw new Error("project-coordination unavailable: spaces worker binding not configured");
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(`http://spaces-worker${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": token,
        // Act on behalf of the person who asked, when there is one — same reasoning as
        // workspace-admin's own spacesCall (see that file's header): correct attribution on
        // anything created, and the assistant is clamped to what that person could do unaided.
        ...(ctx.env.userId ? { "x-naelao-user-id": ctx.env.userId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
  if (!resp.ok) throw new Error(`project-coordination ${method} ${path} failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

export const projectCoordination: PrebuiltScript = {
  name: "project-coordination",
  description:
    "Work with a project's threads and its agents — everything a person can do with a thread, " +
    "not just read one: open a new thread, rename or archive one, find one by name, list a " +
    "project's threads, read exactly what was said in one, send a real message INTO an existing " +
    "thread (with the target agent replying there, visibly, the way a person chatting in it " +
    "would), and consult a named project agent PRIVATELY (a separate exchange, not the visible " +
    "thread). Use send_message when the point is for the person to see the exchange; use consult " +
    "when it's a private handoff/check-in/instruction that shouldn't appear in the visible thread; " +
    "use thread.read when you need the raw exchange rather than the Project Journal's distilled " +
    "summary.",
  domain: "orchestration",
  requires_tier: 1,
  operations: {
    "agent.consult": async (a, c) => {
      if (!c.env.orchestration?.consultAgent) {
        return { ok: false, error: "agent.consult not available in this environment" };
      }
      const agentId = String(a["agent_id"] ?? "");
      const message = String(a["message"] ?? "");
      if (!agentId || !message) throw new Error("agent.consult requires agent_id and message");
      const projectId = a["project_id"] ? String(a["project_id"]) : c.env.projectId;
      const parentThreadId = a["parent_thread_id"] ? String(a["parent_thread_id"]) : undefined;
      const threadId = a["thread_id"] ? String(a["thread_id"]) : undefined;
      return c.env.orchestration.consultAgent({
        agentId,
        message,
        spaceId: c.env.spaceId,
        ...(projectId ? { projectId } : {}),
        ...(parentThreadId ? { parentThreadId } : {}),
        ...(threadId ? { threadId } : {}),
      });
    },
    // Post a real message into an EXISTING, visible thread — and, unless respond:false, dispatch
    // the named agent to reply THERE, the way a person chatting in that thread would see happen.
    // Distinct from agent.consult (above): that one is private and hidden; this one is exactly
    // what shows up when someone opens the thread. `agent_id` is required to get a reply — there
    // is no attempt to guess "the project's default agent"; name who you're addressing.
    "thread.send_message": async (a, c) => {
      if (!c.env.orchestration?.sendToThread) {
        return { ok: false, error: "thread.send_message not available in this environment" };
      }
      const threadId = String(a["thread_id"] ?? "");
      const message = String(a["message"] ?? "");
      if (!threadId || !message) throw new Error("thread.send_message requires thread_id and message");
      const agentId = a["agent_id"] ? String(a["agent_id"]) : undefined;
      const respond = a["respond"] !== false;
      return c.env.orchestration.sendToThread({
        threadId,
        message,
        spaceId: c.env.spaceId,
        ...(agentId ? { agentId } : {}),
        respond,
      });
    },
    // Open a real, visible thread — what "new thread" in the shell does. Deliberately creates a
    // 'primary' thread only: 'sub_agent' threads are the private consult/fan-out lane above (the
    // orchestration hook owns those), and 'channel' threads are minted by the channel gateway from
    // a verified inbound webhook. Letting an agent forge either kind by hand would put messages
    // somewhere the UI presents as having a provenance they didn't have.
    //
    // A thread with no linked session is unopenable in the shell ("Session not found") — the
    // thread page renders <Chat> against thread.session_id and nothing else ever mints one for a
    // thread created this way. So this also creates and links the real chat session immediately,
    // the same way a human clicking "New thread" does (Chat.tsx's startSession(thread_id)) —
    // generate the id ourselves so the thread exists BEFORE the session tries to link to it
    // (POST /sessions' thread_id link is a best-effort UPDATE ... WHERE session_id IS NULL, a
    // no-op against a thread that doesn't exist yet).
    "thread.create": async (a, c) => {
      const projectId = a["project_id"] ? String(a["project_id"]) : c.env.projectId;
      const id = crypto.randomUUID();
      const thread = (await spacesCall(c, "POST", `/spaces/${c.env.spaceId}/threads`, {
        id,
        ...(a["title"] ? { title: String(a["title"]) } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      })) as Record<string, unknown>;
      try {
        const session = (await spacesCall(c, "POST", `/spaces/${c.env.spaceId}/sessions`, { thread_id: id })) as { id?: string };
        if (session?.id) thread["session_id"] = session.id;
      } catch {
        // The thread itself was created successfully; a missing session link is a real gap
        // (the thread will still 404 as "Session not found" if opened) but not a reason to fail
        // the whole call — the caller still gets a real thread id back to retry/inspect.
      }
      return thread;
    },
    "thread.list": (a, c) => {
      const qs = new URLSearchParams({ space_id: c.env.spaceId });
      const projectId = a["project_id"] ? String(a["project_id"]) : c.env.projectId;
      if (projectId) qs.set("project_id", projectId);
      if (a["parent_thread_id"]) qs.set("parent_thread_id", String(a["parent_thread_id"]));
      if (a["include_sub_threads"]) qs.set("include_sub_threads", "true");
      return spacesCall(c, "GET", `/spaces/${c.env.spaceId}/threads?${qs.toString()}`);
    },
    "thread.read": async (a, c) => {
      const threadId = String(a["thread_id"] ?? "");
      if (!threadId) throw new Error("thread.read requires thread_id");
      const thread = (await spacesCall(c, "GET", `/spaces/${c.env.spaceId}/threads/${encodeURIComponent(threadId)}`)) as {
        id: string;
        session_id?: string | null;
        [key: string]: unknown;
      };
      if (!thread.session_id) return { thread, messages: [] };
      const messages = await spacesCall(c, "GET", `/spaces/${c.env.spaceId}/sessions/${thread.session_id}/messages`);
      return { thread, messages };
    },
    "thread.rename": async (a, c) => {
      const threadId = String(a["thread_id"] ?? "");
      const title = String(a["title"] ?? "");
      if (!threadId || !title) throw new Error("thread.rename requires thread_id and title");
      return spacesCall(c, "PATCH", `/spaces/${c.env.spaceId}/threads/${encodeURIComponent(threadId)}`, { title });
    },
    // There is no hard delete for a thread — its messages are real conversation history, and this
    // archives it (status:'archived'), same convention `project.configure({status:'archived'})`
    // already uses. isThreadLimitReached (SpaceDO) already excludes archived threads from a
    // project's max_threads count, so this frees up room the same way a real delete would.
    "thread.delete": async (a, c) => {
      const threadId = String(a["thread_id"] ?? "");
      if (!threadId) throw new Error("thread.delete requires thread_id");
      return spacesCall(c, "PATCH", `/spaces/${c.env.spaceId}/threads/${encodeURIComponent(threadId)}`, { status: "archived" });
    },
    // A real, honest search — matches thread TITLES only (same precedent as the shell's own
    // Sessions-page search, which is instant client-side title filtering; a genuine full-text
    // search over message CONTENT was explicitly scoped out there too and stays out here for the
    // same reason: no backend route for it exists yet, and pretending otherwise would silently
    // under-deliver on what "search" means).
    "thread.search": async (a, c) => {
      const query = String(a["query"] ?? "").trim().toLowerCase();
      if (!query) throw new Error("thread.search requires query");
      const projectId = a["project_id"] ? String(a["project_id"]) : c.env.projectId;
      const qs = new URLSearchParams({ space_id: c.env.spaceId });
      if (projectId) qs.set("project_id", projectId);
      if (a["include_sub_threads"]) qs.set("include_sub_threads", "true");
      const listed = (await spacesCall(c, "GET", `/spaces/${c.env.spaceId}/threads?${qs.toString()}`)) as {
        data?: Array<{ id: string; title?: string | null; [key: string]: unknown }>;
      };
      const matches = (listed.data ?? []).filter((t) => (t.title ?? "").toLowerCase().includes(query));
      return { query, matches, matched_count: matches.length };
    },
  },
  // Live-reported bug this closes: a model asked to "create a thread in project p1 and say hello"
  // called thread.create({}) — no project_id, since nothing told it that field existed — landing
  // the thread with no project attached, then never attempted thread.send_message at all because
  // it had no idea what fields that call needed. See PrebuiltScript.paramHints's own doc.
  paramHints: {
    "thread.create": "project_id (string, OPTIONAL but almost always what you want — the project's " +
      "own id, e.g. from project.list/project.create's result; pass it to attach the new thread to " +
      "THAT project, otherwise omitting it silently creates a space-wide thread with no project at " +
      "all). title (string, optional).",
    "thread.send_message": "thread_id (string, REQUIRED — the id from thread.create/thread.list, " +
      "NOT the project id). message (string, REQUIRED — the real text to post, e.g. \"hello\"). " +
      "agent_id (string, optional but needed to get a reply — without it the message posts with " +
      "nobody addressed to answer it). respond (boolean, optional, default true — set false to " +
      "post without dispatching a reply).",
    "agent.consult": "agent_id (string, REQUIRED — who to consult). message (string, REQUIRED). " +
      "project_id/thread_id (string, optional — defaults to this run's own project/a fresh " +
      "subthread). This is PRIVATE (hidden from the visible thread) — use thread.send_message " +
      "instead when the point is for the person to see the exchange.",
    "thread.list": "project_id (string, optional — defaults to this run's own project; omit for " +
      "every thread in the space).",
    "thread.read": "thread_id (string, REQUIRED).",
    "thread.rename": "thread_id (string, REQUIRED). title (string, REQUIRED — the new title).",
    "thread.delete": "thread_id (string, REQUIRED) — archives it; there is no hard delete.",
    "thread.search": "query (string, REQUIRED — matched against thread TITLES only, not message " +
      "content). project_id (string, optional).",
  },
};
