"use client";

import * as React from "react";
import { VoiceClient, type VoiceStatus } from "agents/voice/client";
import { ApiError, getAgentVoiceHost, requestOwnerVoiceTicket, type SessionCredentials } from "@/lib/api";

/** Owner/admin voice call for the currently open planner session. The short-lived ticket is
 * fetched only after an explicit click and is never persisted in browser storage. */
export function OwnerVoiceCall({
  spaceId,
  sessionId,
  projectId,
  session,
}: {
  spaceId: string;
  sessionId: string;
  projectId?: string;
  session: SessionCredentials;
}) {
  const clientRef = React.useRef<VoiceClient | null>(null);
  const [status, setStatus] = React.useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => () => {
    clientRef.current?.endCall();
    clientRef.current?.disconnect();
    clientRef.current = null;
  }, []);

  async function start() {
    if (busy || clientRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const ticket = await requestOwnerVoiceTicket(spaceId, sessionId, session, projectId);
      const client = new VoiceClient({
        agent: ticket.agent,
        name: ticket.name,
        host: getAgentVoiceHost(),
        query: { ticket: ticket.ticket },
        maxTranscriptMessages: 24,
      });
      client.addEventListener("statuschange", setStatus);
      client.addEventListener("transcriptchange", (messages) => setTranscript(messages.slice(-8).map((message) => `${message.role}: ${message.text}`).join("\n")));
      client.addEventListener("error", (message) => { if (message) setError(message); });
      clientRef.current = client;
      client.connect();
      await client.startCall();
    } catch (cause) {
      clientRef.current?.endCall();
      clientRef.current?.disconnect();
      clientRef.current = null;
      setStatus("idle");
      setError(cause instanceof ApiError && cause.status === 403
        ? "Owner or admin access is required for planner voice calls."
        : cause instanceof Error ? cause.message : "Could not start the voice call.");
    } finally {
      setBusy(false);
    }
  }

  function stop() {
    clientRef.current?.endCall();
    clientRef.current?.disconnect();
    clientRef.current = null;
    setStatus("idle");
  }

  const inCall = status !== "idle" || Boolean(clientRef.current);
  return (
    <div className="owner-voice-call" aria-label="Planner voice call">
      {inCall ? (
        <button type="button" onClick={stop} aria-label="End planner voice call">End voice call · {status}</button>
      ) : (
        <button type="button" onClick={() => void start()} disabled={busy} aria-label="Start planner voice call">
          {busy ? "Connecting…" : "Talk to planner"}
        </button>
      )}
      {error && <span role="status">{error}</span>}
      {transcript && <pre aria-live="polite">{transcript}</pre>}
    </div>
  );
}
