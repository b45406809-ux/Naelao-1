import { sha256Hex } from "./keys.js";

export const MAX_RECIPIENTS = 50;
export const NEW_TENANT_DAYS = 14;
export const NEW_TENANT_DAILY_LIMIT = 100;
export const DEFAULT_DAILY_LIMIT = 1000;
const MAX_BODY_CHARS = 1_000_000;
const MAX_LIST = 1000;
const ADDR_RE = /^[^\s@<>(),;:\\"[\]]+@[^\s@<>(),;:\\"[\]]+\.[^\s@<>(),;:\\"[\]]+$/;
const notFound = { error_code: "not_found", message: "Not found." };

export interface SendEnv { PLATFORM_DB: D1Database; NEMAIL_R2?: R2Bucket; EMAIL?: SendEmail }
export interface Outcome { status: number; body: unknown; /** false = a pre-send rejection: the Idempotency-Key is not consumed. */ cache?: boolean; headers?: Record<string, string> }
export interface Fields {
  to: string[]; cc: string[]; bcc: string[]; subject: string; text: string | null; html: string | null; in_reply_to_message_id: string | null;
}

// ---- validation ----
function addrList(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_LIST) return null;
  const out: string[] = [];
  for (const a of v) {
    if (typeof a !== "string") return null;
    const s = a.trim().toLowerCase();
    if (s.length > 254 || !ADDR_RE.test(s)) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
const bodyField = (v: unknown) => v === undefined || v === null ? null : typeof v === "string" && v.length <= MAX_BODY_CHARS ? v : undefined;

/** Parses the provided fields only. `error` is set on any invalid value. */
export function parseFields(o: unknown): { fields: Partial<Fields>; error?: string } {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { fields: {}, error: "Body must be a JSON object." };
  const b = o as Record<string, unknown>, f: Partial<Fields> = {};
  for (const k of ["to", "cc", "bcc"] as const) {
    if (b[k] === undefined) continue;
    const l = addrList(b[k]);
    if (!l) return { fields: {}, error: `Invalid ${k} recipients.` };
    f[k] = l;
  }
  if (b.subject !== undefined) {
    if (typeof b.subject !== "string" || b.subject.length > 998 || /[\r\n\0]/.test(b.subject)) return { fields: {}, error: "Invalid subject." };
    f.subject = b.subject;
  }
  for (const [k, out] of [["text", "text"], ["html", "html"]] as const) {
    if (b[k] === undefined) continue;
    const v = bodyField(b[k]);
    if (v === undefined) return { fields: {}, error: `Invalid ${k} body (string up to ${MAX_BODY_CHARS} characters).` };
    f[out] = v;
  }
  if (b.in_reply_to_message_id !== undefined) {
    const v = b.in_reply_to_message_id;
    if (v !== null && (typeof v !== "string" || !v || v.length > 100)) return { fields: {}, error: "Invalid in_reply_to_message_id." };
    f.in_reply_to_message_id = v as string | null;
  }
  return { fields: f };
}
const complete = (f: Partial<Fields>): Fields => ({
  to: f.to ?? [], cc: f.cc ?? [], bcc: f.bcc ?? [], subject: f.subject ?? "", text: f.text ?? null, html: f.html ?? null, in_reply_to_message_id: f.in_reply_to_message_id ?? null,
});

// ---- MIME ----
const enc = new TextEncoder();
const bin = (bytes: Uint8Array) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return s; };
const b64Wrapped = (s: string) => (btoa(bin(enc.encode(s))).match(/.{1,76}/g) ?? []).join("\r\n");
const noCtl = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ");
/** RFC 2047 encoded-word(s) for non-ASCII header text (chunked so each word stays under 75 chars). */
export function encodeWord(s: string): string {
  s = noCtl(s);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (enc.encode(cur + ch).length > 42) { words.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map(w => `=?UTF-8?B?${btoa(bin(enc.encode(w)))}?=`).join("\r\n ");
}
function mailbox(name: string, address: string) {
  const n = noCtl(name).trim();
  if (!n) return address;
  return /^[\x20-\x7e]*$/.test(n) ? `"${n.replace(/(["\\])/g, "\\$1")}" <${address}>` : `${encodeWord(n)} <${address}>`;
}
export interface MimeInput {
  fromName: string; from: string; to: string[]; cc: string[]; subject: string; text: string | null; html: string | null;
  messageId: string; inReplyTo: string | null; references: string[]; date: Date;
}
export function buildMime(m: MimeInput): string {
  const h: string[] = [
    `From: ${mailbox(m.fromName, m.from)}`,
    ...(m.to.length ? [`To: ${m.to.join(", ")}`] : []),
    ...(m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${m.date.toUTCString()}`,
    `Message-ID: <${m.messageId}>`,
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo}>`] : []),
    ...(m.references.length ? [`References: ${m.references.map(r => `<${r}>`).join("\r\n ")}`] : []),
    "MIME-Version: 1.0",
  ];
  const part = (type: string, body: string) => `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Wrapped(body)}\r\n`;
  if (m.text !== null && m.html !== null) {
    const bd = `nem_${crypto.randomUUID().replaceAll("-", "")}`;
    return `${h.join("\r\n")}\r\nContent-Type: multipart/alternative; boundary="${bd}"\r\n\r\n--${bd}\r\n${part("text/plain", m.text)}--${bd}\r\n${part("text/html", m.html)}--${bd}--\r\n`;
  }
  return `${h.join("\r\n")}\r\n${part(m.html !== null ? "text/html" : "text/plain", m.html ?? m.text ?? "")}`;
}

/** Real `EmailMessage` inside Workers; a structurally identical object elsewhere (tests). A failure here is before invocation. */
async function makeEmailMessage(from: string, to: string, raw: string): Promise<unknown> {
  if (globalThis.navigator?.userAgent === "Cloudflare-Workers") {
    const spec = "cloudflare:email";
    const mod = await import(/* @vite-ignore */ spec) as { EmailMessage: new (f: string, t: string, r: string) => unknown };
    return new mod.EmailMessage(from, to, raw);
  }
  return { from, to, raw };
}

// ---- send ----
interface InboxRow { id: string; address: string; domain: string; display_name: string; status: string; sending_paused: number }
interface TenantRow { sending_paused: number; daily_send_limit_override: number | null; age_days: number }
const reject = (status: number, error_code: string, message: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): Outcome =>
  ({ status, body: { error_code, message, ...extra }, cache: false, ...(headers ? { headers } : {}) });

export function dailyLimit(t: Pick<TenantRow, "daily_send_limit_override" | "age_days">) {
  if (t.daily_send_limit_override !== null && t.daily_send_limit_override !== undefined) return t.daily_send_limit_override;
  return t.age_days < NEW_TENANT_DAYS ? NEW_TENANT_DAILY_LIMIT : DEFAULT_DAILY_LIMIT;
}

export interface SendOptions {
  /** Draft sends: atomically claims the draft once admission passes; false means it was already sent. */
  claim?: () => Promise<boolean>;
  release?: () => Promise<void>;
  onSent?: (messageId: string) => Promise<void>;
}

/**
 * MR-EM-4 order: (scope, done by the route) -> inbox status (+ paused) -> payload validity -> suppression -> recipient count
 * -> daily limit -> reply target -> delivery rows (the reservation) -> send -> delivery outcome -> usage (sent/unknown only).
 * Returns pre-send rejections with cache=false so the Idempotency-Key stays reusable.
 */
export async function performSend(env: SendEnv, tenantId: string, inboxId: string, input: unknown, opts: SendOptions = {}): Promise<Outcome> {
  const db = env.PLATFORM_DB;
  const inbox = await db.prepare("SELECT id,address,domain,display_name,status,sending_paused FROM nemail_inboxes WHERE id=? AND nemail_tenant_id=? AND status != 'deleted'").bind(inboxId, tenantId).first<InboxRow>();
  if (!inbox) return { status: 404, body: notFound, cache: false };
  if (inbox.status !== "active") return reject(409, "inbox_unavailable", "The inbox is not active.");
  const tenant = await db.prepare("SELECT sending_paused,daily_send_limit_override,(julianday('now') - julianday(created_at)) AS age_days FROM nemail_tenants WHERE id=?").bind(tenantId).first<TenantRow>();
  if (!tenant) return { status: 404, body: notFound, cache: false };
  if (tenant.sending_paused === 1 || inbox.sending_paused === 1) return reject(403, "sending_paused", "Sending is paused pending operator review.");

  const parsed = parseFields(input);
  const f = complete(parsed.fields);
  if (!parsed.error && f.to.length === 0) parsed.error = "At least one to recipient is required.";
  if (!parsed.error && f.text === null && f.html === null) parsed.error = "A text or html body is required.";
  if (parsed.error) return reject(400, "invalid_request", parsed.error);
  const recipients = [...new Set([...f.to, ...f.cc, ...f.bcc])];

  // 2. suppression list (chunked: D1 allows at most 100 bound variables per statement)
  const suppressed: string[] = [];
  for (let i = 0; i < recipients.length; i += 50) {
    const chunk = recipients.slice(i, i + 50);
    const rows = await db.prepare(`SELECT address FROM nemail_suppressions WHERE nemail_tenant_id=? AND address IN (${chunk.map(() => "?").join(",")})`).bind(tenantId, ...chunk).all<{ address: string }>();
    suppressed.push(...rows.results.map(r => r.address));
  }
  if (suppressed.length > 0) return reject(422, "recipient_suppressed", "One or more recipients are on the suppression list.", { addresses: suppressed });
  // 3. recipient count
  if (recipients.length > MAX_RECIPIENTS) return reject(422, "too_many_recipients", `At most ${MAX_RECIPIENTS} recipients per message.`);
  // 4. daily limit: messages with a non-failed delivery in the trailing 24 hours (queued rows count, so in-flight sends reserve capacity)
  const used = await db.prepare("SELECT count(DISTINCT message_id) AS n FROM nemail_deliveries WHERE nemail_tenant_id=? AND message_id IS NOT NULL AND status != 'failed' AND created_at >= datetime('now','-1 day')").bind(tenantId).first<{ n: number }>();
  const limit = dailyLimit(tenant);
  if ((used?.n ?? 0) >= limit) return reject(429, "rate_limit_exceeded", `Daily send limit of ${limit} messages reached.`, { limit, window: "trailing_24h" }, { "retry-after": "3600" });

  // reply target (same tenant and inbox only)
  let thread: { id: string; header: string | null; refs: string[] } | null = null;
  if (f.in_reply_to_message_id) {
    const r = await db.prepare("SELECT thread_id,message_id_header,references_json FROM nemail_messages WHERE id=? AND nemail_tenant_id=? AND inbox_id=?").bind(f.in_reply_to_message_id, tenantId, inboxId)
      .first<{ thread_id: string | null; message_id_header: string | null; references_json: string | null }>();
    if (!r) return reject(404, "message_not_found", "The message to reply to was not found.");
    let refs: string[] = [];
    try { refs = JSON.parse(r.references_json ?? "[]") as string[]; } catch { /* none */ }
    thread = { id: r.thread_id ?? "", header: r.message_id_header, refs };
  }

  if (opts.claim && !(await opts.claim())) return reject(409, "draft_already_sent", "This draft was already sent.");

  const messageId = `msg_${crypto.randomUUID()}`;
  const headerId = `${crypto.randomUUID()}@${inbox.domain}`;
  const references = thread?.header ? [...thread.refs.filter(r => r !== thread!.header), thread.header].slice(-20) : [];
  const now = new Date();
  let raw: string | null = null, sha: string | null = null;
  try {
    raw = buildMime({ fromName: inbox.display_name, from: inbox.address, to: f.to, cc: f.cc, subject: f.subject, text: f.text, html: f.html, messageId: headerId, inReplyTo: thread?.header ?? null, references, date: now });
    sha = await sha256Hex(raw);
  } catch { raw = null; }

  const newThread = !thread?.id;
  const threadId = thread?.id || `thr_${crypto.randomUUID()}`;
  const iso = now.toISOString();
  const rawKey = raw && sha && env.NEMAIL_R2 ? `raw/${tenantId}/${inboxId}/${sha}.eml` : null;
  await db.batch([
    newThread
      ? db.prepare("INSERT INTO nemail_threads(id,nemail_tenant_id,inbox_id,subject,last_message_at) VALUES(?,?,?,?,?)").bind(threadId, tenantId, inboxId, f.subject, iso)
      : db.prepare("UPDATE nemail_threads SET last_message_at=? WHERE id=? AND nemail_tenant_id=? AND inbox_id=?").bind(iso, threadId, tenantId, inboxId),
    db.prepare("INSERT INTO nemail_messages(id,nemail_tenant_id,inbox_id,thread_id,direction,message_id_header,in_reply_to,references_json,from_address,from_name,to_json,cc_json,subject,raw_r2_key,raw_sha256,size_bytes,state,text_body,html_body) VALUES(?,?,?,?, 'outbound', ?,?,?,?,?,?,?,?,?,?,?, 'stored', ?,?)")
      .bind(messageId, tenantId, inboxId, threadId, headerId, thread?.header ?? null, JSON.stringify(references), inbox.address, inbox.display_name || null, JSON.stringify(f.to), JSON.stringify(f.cc), f.subject, rawKey, sha, raw ? enc.encode(raw).length : 0, f.text, f.html),
    ...recipients.map(r => db.prepare("INSERT INTO nemail_deliveries(id,nemail_tenant_id,inbox_id,message_id,recipient,status,idempotency_key) VALUES(?,?,?,?,?, 'queued', ?)").bind(`dlv_${crypto.randomUUID()}`, tenantId, inboxId, messageId, r, null)),
  ]);

  // Transport. `invoked` flips immediately before the binding call: an error before it is `failed` (nothing was sent),
  // an error during or after it is `unknown` (it may have been sent) and is never retried automatically.
  let prepError = raw ? null : "prepare_failed";
  if (!prepError && rawKey && env.NEMAIL_R2 && raw) {
    try { await env.NEMAIL_R2.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } }); } catch { prepError = "storage_failed"; }
  }
  const results: Array<{ recipient: string; status: "sent" | "failed" | "unknown" }> = [];
  for (const r of recipients) {
    let invoked = false, status: "sent" | "failed" | "unknown", code: string | null = null;
    try {
      if (prepError) throw new Error(prepError);
      if (!env.EMAIL) throw new Error("no_transport");
      const msg = await makeEmailMessage(inbox.address, r, raw!);
      invoked = true;
      await env.EMAIL.send(msg as never);
      status = "sent";
    } catch {
      status = invoked ? "unknown" : "failed";
      code = invoked ? "transport_outcome_unknown" : prepError ?? "transport_unavailable";
    }
    results.push({ recipient: r, status });
    try { await db.prepare("UPDATE nemail_deliveries SET status=?, error_code=?, updated_at=datetime('now') WHERE message_id=? AND nemail_tenant_id=? AND recipient=?").bind(status, code, messageId, tenantId, r).run(); } catch { /* stays queued: reconcile manually */ }
  }
  const sentLike = results.some(r => r.status !== "failed");
  const overall = results.every(r => r.status === "sent") ? "sent" : results.every(r => r.status === "failed") ? "failed"
    : results.some(r => r.status === "unknown") ? "unknown" : "partial";
  if (sentLike) {
    try {
      await db.prepare("INSERT OR IGNORE INTO nemail_usage(id,nemail_tenant_id,meter,quantity,message_id,outcome,period) VALUES(?,?, 'email.message.sent', 1, ?,?,?)")
        .bind(`use_${crypto.randomUUID()}`, tenantId, messageId, results.some(r => r.status === "unknown") ? "unknown" : "sent", iso.slice(0, 7)).run();
    } catch { /* usage can be re-derived from nemail_deliveries */ }
  }
  if (overall === "failed") await opts.release?.().catch(() => {});
  else await opts.onSent?.(messageId).catch(() => {});
  const data = { message_id: messageId, thread_id: threadId, rfc822_message_id: headerId, status: overall, deliveries: results };
  return overall === "failed"
    ? { status: 502, body: { error_code: "send_failed", message: "The message was not sent.", data } }
    : { status: 201, body: { data } };
}
