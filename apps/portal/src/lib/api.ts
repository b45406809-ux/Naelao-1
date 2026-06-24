// Portal API client — end-user facing (no builder auth required)
// G-A01: Space session management, G-A10: Agent run streaming

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at: string;
}

export interface AgentRun {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  final_answer?: string;
  error?: string;
}

interface SessionResponse {
  id: string;
  space_id: string;
}

interface MessagesResponse {
  data: Message[];
  messages?: Message[];
}

interface MessageCreateResponse {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

interface AgentRunResponse {
  id: string;
  run_id?: string;
  status: string;
  final_answer?: string;
  error?: string;
}

// ── Core fetch ────────────────────────────────────────────────────────────────

async function portalFetch<T>(
  path: string,
  options: RequestInit & { endUserId?: string } = {}
): Promise<T> {
  const { endUserId, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(fetchOptions.headers as Record<string, string> | undefined),
  };

  if (endUserId) {
    headers["x-naelao-end-user-id"] = endUserId;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...fetchOptions,
    headers,
  });

  if (!res.ok) {
    let message = `API error ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // use default message
    }
    throw new Error(message);
  }

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  return res.json() as Promise<T>;
}

// ── Session management ────────────────────────────────────────────────────────

/**
 * Start a new session for a Space (anonymous end-users allowed).
 * POST /v1/spaces/:spaceId/sessions
 * G-A01: End-user session creation without builder auth
 */
export async function startSession(
  spaceId: string,
  endUserId?: string
): Promise<{ id: string; space_id: string }> {
  return portalFetch<SessionResponse>(`/v1/spaces/${spaceId}/sessions`, {
    method: "POST",
    body: JSON.stringify({}),
    ...(endUserId !== undefined ? { endUserId } : {}),
  });
}

// ── Messages ──────────────────────────────────────────────────────────────────

/**
 * Load all messages for a session.
 * GET /v1/spaces/:spaceId/sessions/:sessionId/messages
 * G-A02: Session message history retrieval
 */
export async function getMessages(
  spaceId: string,
  sessionId: string
): Promise<Message[]> {
  const res = await portalFetch<MessagesResponse | Message[]>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/messages`
  );

  if (Array.isArray(res)) return res;
  const typed = res as MessagesResponse;
  return typed.data ?? typed.messages ?? [];
}

/**
 * Send a user message then kick off an agent run.
 * POST /v1/spaces/:spaceId/sessions/:sessionId/messages — add user message
 * POST /v1/spaces/:spaceId/sessions/:sessionId/agent/run — start agent
 * G-A03: User message ingestion + agent invocation
 */
export async function sendMessage(
  spaceId: string,
  sessionId: string,
  content: string
): Promise<{ userMessage: Message; agentRunId: string }> {
  // Step 1: persist user message
  const userMessage = await portalFetch<MessageCreateResponse>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ role: "user", content }),
    }
  );

  // Step 2: trigger agent run
  const agentRun = await portalFetch<AgentRunResponse>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/agent/run`,
    {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId }),
    }
  );

  return {
    userMessage: {
      id: userMessage.id,
      role: "user",
      content: userMessage.content,
      created_at: userMessage.created_at,
    },
    agentRunId: agentRun.id ?? agentRun.run_id ?? "",
  };
}

// ── Streaming ─────────────────────────────────────────────────────────────────

/**
 * Returns the SSE stream URL for an agent run.
 * GET /v1/spaces/:spaceId/sessions/:sessionId/agent/runs/:runId/stream
 * G-A04: Server-Sent Events agent response streaming
 */
export function getStreamUrl(
  spaceId: string,
  sessionId: string,
  runId: string
): string {
  return `${API_URL}/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}/stream`;
}

// ── Polling fallback ──────────────────────────────────────────────────────────

/**
 * Poll agent run status — fallback when SSE is unavailable.
 * GET /v1/spaces/:spaceId/sessions/:sessionId/agent/runs/:runId
 * G-A05: Agent run status polling
 */
export async function pollRun(
  spaceId: string,
  sessionId: string,
  runId: string
): Promise<AgentRun> {
  const res = await portalFetch<AgentRunResponse>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}`
  );

  return {
    id: res.id,
    status: (res.status as AgentRun["status"]) ?? "running",
    ...(res.final_answer !== undefined ? { final_answer: res.final_answer } : {}),
    ...(res.error !== undefined ? { error: res.error } : {}),
  };
}

/**
 * Get space metadata (name, description).
 * GET /v1/spaces/:spaceId
 * G-A06: Space metadata for portal branding
 */
export async function getSpace(
  spaceId: string
): Promise<{ id: string; name: string; description?: string }> {
  return portalFetch<{ id: string; name: string; description?: string }>(
    `/v1/spaces/${spaceId}`
  );
}
