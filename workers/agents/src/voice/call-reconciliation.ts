type Statement = {
  bind(...values: unknown[]): Statement;
  all<T>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};

type Database = { prepare(sql: string): Statement };
type TwilioCredentials = { accountSid: string; authToken: string };

type StaleCall = {
  call_sid: string;
  number_binding_id: string;
  tenant_id: string;
  space_id: string;
  provider_account_sid: string;
  inbound_price_per_minute_minor: number;
  max_call_duration_seconds: number;
  status: "issued" | "connected";
  ticket_expires_at: string;
};

const TERMINAL_CALL_STATES = new Set(["completed", "failed", "busy", "no-answer", "canceled"]);
const MAX_CALL_RESPONSE_BYTES = 16_384;
const CALLBACK_GRACE_SECONDS = 90;
const MAX_RECONCILE_PER_SPACE = 10;

async function boundedJson(response: Response): Promise<Record<string, unknown> | null> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_CALL_RESPONSE_BYTES) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_CALL_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const json = JSON.parse(text) as unknown;
    return json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function encodeBasicAuth(credentials: TwilioCredentials): string {
  return `Basic ${btoa(`${credentials.accountSid}:${credentials.authToken}`)}`;
}

/**
 * Recover expired pre-consent reservations and settle calls whose Twilio status callback was
 * lost. Connected calls are only reconciled after their maximum admitted duration plus grace;
 * the Twilio Call resource must report a terminal state before any reservation is released.
 */
export async function reconcileStaleCustomerVoiceCalls(input: {
  db: Database;
  tenantId: string;
  spaceId: string;
  now?: Date;
  credentialsForSpace: (tenantId: string, spaceId: string) => Promise<TwilioCredentials | null>;
  fetcher?: typeof fetch;
}): Promise<{ expired: number; reconciled: number; pending: number }> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expired = await input.db.prepare(
    `UPDATE customer_voice_call_admissions SET status='failed',reserved_cost_minor=0,reserved_duration_seconds=0,
       duration_seconds=0,actual_cost_minor=0,ended_at=?,updated_at=?
     WHERE tenant_id=? AND space_id=? AND status='issued' AND ticket_expires_at<=?`,
  ).bind(nowIso, nowIso, input.tenantId, input.spaceId, nowIso).run();

  const stale = await input.db.prepare(
    `SELECT a.call_sid,a.number_binding_id,a.tenant_id,a.space_id,a.status,a.ticket_expires_at,
            b.provider_account_sid,b.inbound_price_per_minute_minor,b.max_call_duration_seconds
       FROM customer_voice_call_admissions a
       JOIN customer_voice_number_bindings b ON b.id=a.number_binding_id
      WHERE a.tenant_id=? AND a.space_id=? AND a.status='connected'
        AND julianday(a.connected_at) + ((b.max_call_duration_seconds + ?) / 86400.0) <= julianday(?)
      ORDER BY a.connected_at ASC LIMIT ?`,
  ).bind(input.tenantId, input.spaceId, CALLBACK_GRACE_SECONDS, nowIso, MAX_RECONCILE_PER_SPACE).all<StaleCall>();

  let reconciled = 0;
  let pending = 0;
  const credentialCache = new Map<string, Promise<TwilioCredentials | null>>();
  for (const call of stale.results ?? []) {
    if (!/^CA[a-fA-F0-9]{32}$/.test(call.call_sid) || !/^AC[a-fA-F0-9]{32}$/.test(call.provider_account_sid)) continue;
    const scope = `${call.tenant_id}:${call.space_id}`;
    let credentialsPromise = credentialCache.get(scope);
    if (!credentialsPromise) {
      credentialsPromise = input.credentialsForSpace(call.tenant_id, call.space_id);
      credentialCache.set(scope, credentialsPromise);
    }
    const credentials = await credentialsPromise;
    if (!credentials || credentials.accountSid !== call.provider_account_sid) { pending++; continue; }

    let response: Response;
    try {
      response = await (input.fetcher ?? fetch)(
        `https://api.twilio.com/2010-04-01/Accounts/${call.provider_account_sid}/Calls/${encodeURIComponent(call.call_sid)}.json`,
        { headers: { authorization: encodeBasicAuth(credentials) }, redirect: "error", signal: AbortSignal.timeout(8_000) },
      );
    } catch { pending++; continue; }
    if (!response.ok) { pending++; continue; }
    const providerCall = await boundedJson(response);
    if (!providerCall || providerCall.sid !== call.call_sid || typeof providerCall.status !== "string" || !TERMINAL_CALL_STATES.has(providerCall.status)) {
      pending++;
      continue;
    }

    let duration = 0;
    let actualCost = 0;
    let finalStatus: "completed" | "failed" = "failed";
    if (providerCall.status === "completed") {
      const parsedDuration = typeof providerCall.duration === "string" && /^\d{1,6}$/.test(providerCall.duration)
        ? Number(providerCall.duration)
        : typeof providerCall.duration === "number" && Number.isSafeInteger(providerCall.duration) ? providerCall.duration : -1;
      if (parsedDuration < 0) { pending++; continue; }
      duration = parsedDuration;
      actualCost = Math.ceil(duration / 60) * call.inbound_price_per_minute_minor;
      finalStatus = "completed";
    }

    const settled = await input.db.prepare(
      `UPDATE customer_voice_call_admissions SET status=?,ended_at=?,duration_seconds=?,actual_cost_minor=?,
         reserved_cost_minor=0,reserved_duration_seconds=0,updated_at=?
       WHERE call_sid=? AND number_binding_id=? AND tenant_id=? AND space_id=? AND status='connected'`,
    ).bind(finalStatus, nowIso, duration, actualCost, nowIso, call.call_sid, call.number_binding_id, call.tenant_id, call.space_id).run();
    if ((settled.meta?.changes ?? 0) === 1) reconciled++;
  }

  return { expired: expired.meta?.changes ?? 0, reconciled, pending };
}
