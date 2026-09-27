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
 * the visible thread, that's `thread.consult` — a real, separate conversation in its own subthread
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
 * workspace-admin's `project.list`/`agent.list`). `thread.consult` is left ungated by default too —
 * it dispatches the assistant's own normal operating cost (one run), same posture as @mention
 * dispatch; whatever the consulted agent decides to DO is still gated by its own
 * agent_policy_overrides/assistant_policy exactly as if a human had asked it directly.
 * `thread.create`/`thread.rename`/`thread.delete`/`thread.send_message` ARE gated by default —
 * each is either a structural write or a real dispatched run, and the guided policy's job is to
 * let the owner see structure and cost appear on purpose rather than accumulate.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";
import {
  ALLOWED_MODELS,
  DEFAULT_WORKING_MODEL,
  capabilityForModel,
  contextWindowForModel,
  benchmarkForModel,
  isAllowedModel,
  suggestModels,
} from "@naelao/billing-core";

/** The general Space Assistant agent id — provisioned in every space, so it is a valid target in
 *  every project even one with no explicit agent_definitions rows. Kept in sync with
 *  DEFAULT_NAELAO_AGENT.agentId in profiles.ts. */
const GENERAL_AGENT_ID = "naelao-agent";

interface ProjectAgentEntry {
  id: string;
  name: string;
  description?: string;
  is_default?: boolean;
}

/** List the agents addressable from a project: every agent_definition in the space PLUS the
 *  general Space Assistant, which is always addressable even in a brand-new project (auto-added
 *  to the listing so a spawn/consult/send can name it). De-duplicated by id. */
async function listProjectAgents(ctx: PrebuiltOpContext): Promise<ProjectAgentEntry[]> {
  let rows: Array<Record<string, unknown>> = [];
  try {
    const res = (await spacesCall(
      ctx,
      "GET",
      `/spaces/${ctx.env.spaceId}/agent-definitions?space_id=${encodeURIComponent(ctx.env.spaceId)}`
    )) as { data?: Array<Record<string, unknown>> };
    rows = Array.isArray(res.data) ? res.data : [];
  } catch {
    // A listing failure must never make the general agent invisible — it is always addressable.
    rows = [];
  }
  const entries: ProjectAgentEntry[] = rows.map((r) => ({
    id: String(r["id"] ?? ""),
    name: String(r["name"] ?? r["id"] ?? "agent"),
    ...(typeof r["description"] === "string" ? { description: r["description"] as string } : {}),
  }));
  if (!entries.some((e) => e.id === GENERAL_AGENT_ID)) {
    entries.unshift({
      id: GENERAL_AGENT_ID,
      name: "Space Assistant (general)",
      description: "The default general-purpose agent, available in every project.",
      is_default: true,
    });
  }
  return entries;
}

/** Rank candidate agent ids/names against a guess by token overlap — the "did you mean" list for
 *  an agent_id that names no real agent (same shape as billing-core's suggestModels). */
function suggestAgents(guess: string, agents: ProjectAgentEntry[], max = 3): string[] {
  const g = guess.toLowerCase().trim();
  if (!g) return [];
  const gTokens = new Set(g.split(/[/\-.@\s_]+/).filter(Boolean));
  return agents
    .map((a) => {
      const hay = `${a.id} ${a.name}`.toLowerCase();
      let score = 0;
      for (const t of hay.split(/[/\-.@\s_]+/).filter(Boolean)) if (gTokens.has(t)) score += 2;
      if (hay.includes(g)) score += 3;
      for (const t of gTokens) if (t.length >= 3 && hay.includes(t)) score += 1;
      return { id: a.id, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.id);
}

/** Returns a structured error result when `agentId` names no addressable agent, else null. */
async function validateAgentId(ctx: PrebuiltOpContext, agentId: string): Promise<Record<string, unknown> | null> {
  const agents = await listProjectAgents(ctx);
  if (agents.some((a) => a.id === agentId)) return null;
  const suggestions = suggestAgents(agentId, agents);
  return {
    ok: false,
    error:
      `agent "${agentId}" was not found in this project.` +
      (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "") +
      ` Call thread.list_project_agents to see who you can address ("${GENERAL_AGENT_ID}" is always available).`,
    did_you_mean: suggestions,
    available_agents: agents.map((a) => a.id),
  };
}

/** Returns a structured error result when `model` is a non-empty, non-allowed id, else null. */
function validateModel(model: string | undefined): Record<string, unknown> | null {
  if (!model || isAllowedModel(model)) return null;
  const suggestions = suggestModels(model);
  return {
    ok: false,
    error:
      `model "${model}" is not available.` +
      (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "") +
      ` Call thread.list_project_models to see every model you can name (omit "model" to use the agent's default).`,
    did_you_mean: suggestions,
  };
}

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
    "thread.delegate": async (a, c) => {
      if (!c.env.orchestration?.delegateTurn) {
        return { ok: false, error: "sequential delegation not available in this environment" };
      }
      const targetAgentId = String(a["agent_id"] ?? "");
      const task = String(a["task"] ?? "");
      if (!targetAgentId || !task) throw new Error("thread.delegate requires agent_id and task");
      const agentCheck = await validateAgentId(c, targetAgentId);
      if (agentCheck) return agentCheck;
      return c.env.orchestration.delegateTurn({
        targetAgentId,
        task,
        ...(a["handover_context"] && typeof a["handover_context"] === "object"
          ? { handoverContext: a["handover_context"] as Record<string, unknown> }
          : {}),
      });
    },
    "thread.consult": async (a, c) => {
      if (!c.env.orchestration?.consultAgent) {
        return { ok: false, error: "thread.consult not available in this environment" };
      }
      const agentId = String(a["agent_id"] ?? "");
      const message = String(a["message"] ?? "");
      if (!agentId || !message) throw new Error("thread.consult requires agent_id and message");
      // Validate the target agent up front so a wrong id gets a real "did you mean" list instead
      // of the bare "HTTP 404 / not provisioned" the DO dispatch would otherwise surface.
      const agentCheck = await validateAgentId(c, agentId);
      if (agentCheck) return agentCheck;
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
    // Distinct from thread.consult (above): that one is private and hidden; this one is exactly
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
      const model = a["model"] ? String(a["model"]) : undefined;
      // Validate the model and (when a reply is wanted) the target agent up front, so a wrong id
      // returns a real did-you-mean rather than a bare 404 from the dispatch.
      const modelErr = validateModel(model);
      if (modelErr) return modelErr;
      if (respond && agentId) {
        const agentErr = await validateAgentId(c, agentId);
        if (agentErr) return agentErr;
      }
      return c.env.orchestration.sendToThread({
        threadId,
        message,
        spaceId: c.env.spaceId,
        ...(agentId ? { agentId } : {}),
        ...(model ? { model } : {}),
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
    // Step 8: the AI must be able to SEE which models/agents it may address before spawning,
    // consulting, or sending — otherwise it guesses an id and gets a 404 (or never sets one).
    // list_project_models mirrors sub-agent's agent.list_models; list_project_agents always
    // includes the general agent so a brand-new project still lists a real, addressable target.
    "thread.list_project_models": async () => {
      return {
        default: DEFAULT_WORKING_MODEL,
        models: ALLOWED_MODELS.map((m) => {
          const cap = capabilityForModel(m);
          const bench = benchmarkForModel(m);
          return {
            id: m,
            family: bench?.family ?? null,
            cost_tier: bench?.costTier ?? null,
            context_window: contextWindowForModel(m),
            supports_thinking: cap.reasoningLevels.length > 0,
            thinking_levels: cap.reasoningLevels,
            best_for: bench?.bestFor ?? [],
          };
        }),
      };
    },
    "thread.list_project_agents": async (_a, c) => {
      const agents = await listProjectAgents(c);
      return { agents, default_agent: GENERAL_AGENT_ID };
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
      "nobody addressed to answer it; use agent.list to see which agents exist). respond " +
      "(boolean, optional, default true — set false to post without dispatching a reply). model " +
      "(string, optional — run the replying agent on a specific model for this one dispatch; ids " +
      "come from agent.list_models, and omitting it uses that agent's own configured default).",
    "thread.consult": "agent_id (string, REQUIRED — who to consult). message (string, REQUIRED). " +
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
    "thread.list_project_models": "no parameters. Returns every model you may name in a spawn, " +
      "consult, or send_message (with context window, thinking support, cost tier) — call this " +
      "before guessing a model id.",
    "thread.list_project_agents": "no parameters. Returns every agent you may address in this " +
      "project (id + name); the general Space Assistant is always included and addressable.",
  },
};
