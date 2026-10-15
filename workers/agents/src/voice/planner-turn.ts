import { mintInternalToken } from "@naelao/http";
import type { OwnerVoiceTicket } from "./voice-ticket.js";

const MAX_TURN_CHARS = 2_000;

export async function dispatchOwnerVoiceTurn(
  ticket: OwnerVoiceTicket,
  transcript: string,
  input: { platformSecret: string; agentsWorker: Fetcher; signal?: AbortSignal },
): Promise<string> {
  const goal = transcript.trim().slice(0, MAX_TURN_CHARS);
  if (!goal) throw new Error("voice_transcript_empty");
  if (input.signal?.aborted) throw new Error("voice_turn_cancelled");
  const url = `http://agents-worker/spaces/${encodeURIComponent(ticket.spaceId)}/sessions/${encodeURIComponent(ticket.sessionId)}/agent/run`;
  const response = await input.agentsWorker.fetch(new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "prefer": "respond-sync",
      "x-naelao-tenant-id": ticket.tenantId,
      "x-naelao-user-id": ticket.userId,
      "x-naelao-role": ticket.callerRole,
      "x-naelao-internal-token": await mintInternalToken(input.platformSecret, ticket.tenantId),
    },
    body: JSON.stringify({ goal, ...(ticket.projectId ? { project_id: ticket.projectId } : {}) }),
    ...(input.signal ? { signal: input.signal } : {}),
  }));
  if (!response.ok) throw new Error(`voice_planner_failed_${response.status}`);
  const result = await response.json<{ finalAnswer?: unknown; final_answer?: unknown; status?: string; error?: string }>();
  const answer = result.finalAnswer ?? result.final_answer;
  if (typeof answer !== "string" || !answer.trim()) throw new Error(result.error || "voice_planner_returned_no_answer");
  return answer.slice(0, 4_000);
}
