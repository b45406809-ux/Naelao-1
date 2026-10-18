/**
 * §A1.17 Phase V — whole-business real-time sync. WsHubDO (workers/ws-gateway) is fully built
 * (one DO per tenant, WebSocket Hibernation, a /broadcast endpoint) but was completely unwired —
 * no other worker ever called it. This is the one shared helper every natural mutation point
 * (project created/updated, thread lock transitions, agent run lifecycle,
 * approval.requested/resolved) calls to fan a live event out to a space's connected clients.
 *
 * Best-effort by design: a broadcast failing (WS_GATEWAY unbound, network hiccup, no one
 * connected) must never fail or delay the mutation that triggered it — callers should NOT await
 * this inline in a hot path without `.catch()` unless they're already in a background/waitUntil
 * context, matching this codebase's standing precedent for every other side-effect notification
 * (fireMatchingTriggers, notifyApprovalRequested).
 */

export interface RealtimeBroadcastEnv {
  /** Service binding to naelao-ws-gateway. Optional — degrades to a silent no-op when unbound,
   *  same posture as every other optional binding in this platform. Named to match this
   *  codebase's CF-binding convention (ALL_CAPS), so a host Env/SpaceDOEnv satisfies this
   *  interface structurally with no adapter needed at call sites. */
  WS_GATEWAY?: {
    fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
  };
  PLATFORM_SECRET: string;
}

/** Fans a live event out to every WebSocket connected to `spaceId` under `tenantId`. Never
 *  throws — logs nothing on failure either, since a disconnected/idle space with no listeners is
 *  the overwhelmingly common case, not an error. */
export async function broadcastSpaceEvent(
  env: RealtimeBroadcastEnv,
  tenantId: string,
  spaceId: string,
  event: string,
  data: unknown
): Promise<void> {
  if (!env.WS_GATEWAY || !tenantId || !spaceId) return;
  try {
    await env.WS_GATEWAY.fetch(
      new Request("http://ws-gateway/broadcast", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": tenantId,
          "x-naelao-platform-secret": env.PLATFORM_SECRET,
        },
        body: JSON.stringify({ spaceId, event, data }),
      })
    );
  } catch {
    // best-effort — a live-sync failure must never affect the mutation that triggered it
  }
}
