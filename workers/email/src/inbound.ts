import PostalMime from "postal-mime";
import { sha256Hex } from "./keys.js";

export const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const MAX_BODY_CHARS = 500_000;

export interface InboundEnv {
  PLATFORM_DB: D1Database;
  NEMAIL_R2?: R2Bucket;
}

/** Strip angle brackets and whitespace from a Message-ID style token. */
export function normalizeMessageId(value: string | undefined | null): string | null {
  const v = (value ?? "").trim().replace(/^<|>$/g, "").trim();
  return v && v.length <= 998 ? v : null;
}
export function parseReferences(value: string | undefined | null): string[] {
  const ids = [...(value ?? "").matchAll(/<([^<>\s]+)>/g)].map(m => m[1]!);
  return [...new Set(ids)].slice(-20);
}
async function sha256Bytes(bytes: Uint8Array) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(d, b => b.toString(16).padStart(2, "0")).join("");
}

async function readBounded(raw: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MESSAGE_BYTES) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

const safeName = (n: string) => n.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 200) || "attachment";
const safeType = (t: string | undefined) => (t && /^[\w.+-]+\/[\w.+-]+$/.test(t) ? t.toLowerCase() : "application/octet-stream");
const addr = (a: { address?: string | undefined } | undefined) => (a?.address ?? "").trim().toLowerCase();

/**
 * Cloudflare Email Routing entrypoint. Order: resolve recipient, bound + hash raw, store raw in R2,
 * then parse. After the raw is stored this function never throws: failures become recorded states.
 */
export async function handleInbound(message: ForwardableEmailMessage, env: InboundEnv, enabled: boolean): Promise<void> {
  const reject = (reason: string) => message.setReject(reason);
  if (!enabled || !env.NEMAIL_R2) return reject("Naelao Email is unavailable");
  const recipient = (message.to ?? "").trim().toLowerCase();
  const inbox = await env.PLATFORM_DB.prepare("SELECT id, nemail_tenant_id FROM nemail_inboxes WHERE address=? AND status='active'")
    .bind(recipient).first<{ id: string; nemail_tenant_id: string }>();
  if (!inbox) return reject("Unknown recipient");
  const tenantId = inbox.nemail_tenant_id, inboxId = inbox.id;
  const messageId = `msg_${crypto.randomUUID()}`;
  const db = env.PLATFORM_DB;
  const recordRejected = async (code: string, extra: { sha?: string; key?: string; size?: number } = {}) => {
    try {
      await db.prepare("INSERT INTO nemail_messages(id,nemail_tenant_id,inbox_id,direction,from_address,to_json,raw_r2_key,raw_sha256,size_bytes,state,error_code) VALUES(?,?,?, 'inbound', ?,?,?,?,?, 'rejected', ?)")
        .bind(messageId, tenantId, inboxId, (message.from ?? "").toLowerCase(), JSON.stringify([recipient]), extra.key ?? null, extra.sha ?? null, extra.size ?? message.rawSize ?? 0, code).run();
    } catch { /* duplicate rejected raw or db failure: nothing more to do */ }
  };

  if (typeof message.rawSize === "number" && message.rawSize > MAX_MESSAGE_BYTES) {
    reject("Message exceeds the inbound size limit");
    return recordRejected("message_too_large");
  }
  let bytes: Uint8Array | null;
  try { bytes = await readBounded(message.raw); } catch { reject("Message could not be read"); return; }
  if (!bytes) { reject("Message exceeds the inbound size limit"); return recordRejected("message_too_large"); }

  // Raw MIME is stored BEFORE parsing; the key is content-addressed so a redelivery overwrites identically.
  const sha = await sha256Bytes(bytes);
  const rawKey = `raw/${tenantId}/${inboxId}/${sha}.eml`;
  try { await env.NEMAIL_R2.put(rawKey, bytes, { httpMetadata: { contentType: "message/rfc822" } }); } catch { return reject("Temporary storage failure"); }

  try {
    await ingest(message, env, { tenantId, inboxId, messageId, recipient, bytes, sha, rawKey, reject });
  } catch {
    // Raw is safe in R2. Keep a minimal row so the message is not lost; never throw after storage.
    try {
      await db.prepare("INSERT OR IGNORE INTO nemail_messages(id,nemail_tenant_id,inbox_id,direction,from_address,to_json,raw_r2_key,raw_sha256,size_bytes,state,error_code) VALUES(?,?,?, 'inbound', ?,?,?,?,?, 'stored', 'persist_failed')")
        .bind(messageId, tenantId, inboxId, (message.from ?? "").toLowerCase(), JSON.stringify([recipient]), rawKey, sha, bytes.byteLength).run();
    } catch { /* give up quietly: raw remains in R2 */ }
  }
}

interface Ctx { tenantId: string; inboxId: string; messageId: string; recipient: string; bytes: Uint8Array; sha: string; rawKey: string; reject: (r: string) => void }

async function ingest(message: ForwardableEmailMessage, env: InboundEnv, x: Ctx) {
  const db = env.PLATFORM_DB, r2 = env.NEMAIL_R2!;
  type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;
  let parsed: Parsed | null = null;
  try {
    parsed = await PostalMime.parse(x.bytes as never, { attachmentEncoding: "arraybuffer", maxNestingDepth: 5, maxRfc822NestingDepth: 2 });
  } catch { parsed = null; }

  const base = { from: (message.from ?? "").toLowerCase(), to: JSON.stringify([x.recipient]) };
  if (!parsed) {
    // Parse failure: raw is kept; record the message as parse_error (deduped by raw hash).
    await db.prepare("INSERT OR IGNORE INTO nemail_messages(id,nemail_tenant_id,inbox_id,direction,from_address,to_json,raw_r2_key,raw_sha256,size_bytes,state,error_code) VALUES(?,?,?, 'inbound', ?,?,?,?,?, 'parse_error', 'parse_failed')")
      .bind(x.messageId, x.tenantId, x.inboxId, base.from, base.to, x.rawKey, x.sha, x.bytes.byteLength).run();
    return;
  }

  const headerId = normalizeMessageId(parsed.messageId);
  const inReplyTo = normalizeMessageId(parsed.inReplyTo);
  const refs = parseReferences(parsed.references);

  // Dedup: Message-ID within the inbox, else the raw hash.
  const findDup = () => headerId
    ? db.prepare("SELECT id FROM nemail_messages WHERE nemail_tenant_id=? AND inbox_id=? AND direction='inbound' AND message_id_header=?").bind(x.tenantId, x.inboxId, headerId).first()
    : db.prepare("SELECT id FROM nemail_messages WHERE nemail_tenant_id=? AND inbox_id=? AND direction='inbound' AND message_id_header IS NULL AND raw_sha256=?").bind(x.tenantId, x.inboxId, x.sha).first();
  if (await findDup()) return;

  const atts = parsed.attachments ?? [];
  let total = 0, tooBig = false;
  const sized = atts.map(a => {
    const content = a.content as ArrayBuffer | string;
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    total += bytes.byteLength;
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) tooBig = true;
    return { a, bytes };
  });
  const from = addr(parsed.from);
  const subject = (parsed.subject ?? "").replace(/[\r\n\0]/g, " ").slice(0, 998);
  const common = { from: from || base.from, subject };
  if (atts.length > MAX_ATTACHMENTS || tooBig || total > MAX_MESSAGE_BYTES) {
    const code = atts.length > MAX_ATTACHMENTS ? "too_many_attachments" : tooBig ? "attachment_too_large" : "message_too_large";
    x.reject("Attachment limits exceeded");
    await db.prepare("INSERT OR IGNORE INTO nemail_messages(id,nemail_tenant_id,inbox_id,direction,message_id_header,from_address,to_json,subject,raw_r2_key,raw_sha256,size_bytes,state,error_code) VALUES(?,?,?, 'inbound', ?,?,?,?,?,?,?, 'rejected', ?)")
      .bind(x.messageId, x.tenantId, x.inboxId, headerId, common.from, base.to, common.subject, x.rawKey, x.sha, x.bytes.byteLength, code).run();
    return;
  }

  // Threading within this inbox only.
  const candidates = [...new Set([...(inReplyTo ? [inReplyTo] : []), ...refs])];
  let threadId: string | null = null;
  if (candidates.length > 0) {
    const row = await db.prepare(`SELECT thread_id FROM nemail_messages WHERE nemail_tenant_id=? AND inbox_id=? AND thread_id IS NOT NULL AND message_id_header IN (${candidates.map(() => "?").join(",")}) ORDER BY received_at DESC, id DESC LIMIT 1`)
      .bind(x.tenantId, x.inboxId, ...candidates).first<{ thread_id: string }>();
    threadId = row?.thread_id ?? null;
  }
  const newThread = threadId === null;
  threadId ??= `thr_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const attKeys: string[] = [];
  const attRows: Array<{ id: string; filename: string; type: string; size: number; key: string; sha: string; disposition: string | null }> = [];
  try {
    for (const [i, { a, bytes }] of sized.entries()) {
      const id = `att_${crypto.randomUUID()}`;
      const asha = await sha256Bytes(bytes);
      const key = `att/${x.tenantId}/${x.inboxId}/${x.messageId}/${i}-${asha}`;
      await r2.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
      attKeys.push(key);
      attRows.push({ id, filename: safeName(a.filename ?? `attachment-${i + 1}`), type: safeType(a.mimeType), size: bytes.byteLength, key, sha: asha, disposition: a.disposition ?? null });
    }
    const text = (parsed.text ?? "").slice(0, MAX_BODY_CHARS);
    const html = (parsed.html ?? "").slice(0, MAX_BODY_CHARS);
    const stmts = [
      newThread
        ? db.prepare("INSERT INTO nemail_threads(id,nemail_tenant_id,inbox_id,subject,last_message_at) VALUES(?,?,?,?,?)").bind(threadId, x.tenantId, x.inboxId, subject, now)
        : db.prepare("UPDATE nemail_threads SET last_message_at=? WHERE id=? AND nemail_tenant_id=? AND inbox_id=?").bind(now, threadId, x.tenantId, x.inboxId),
      db.prepare("INSERT INTO nemail_messages(id,nemail_tenant_id,inbox_id,thread_id,direction,message_id_header,in_reply_to,references_json,from_address,from_name,to_json,cc_json,subject,raw_r2_key,raw_sha256,size_bytes,state,text_body,html_body,received_at) VALUES(?,?,?,?, 'inbound', ?,?,?,?,?,?,?,?,?,?,?, 'parsed', ?,?,?)")
        .bind(x.messageId, x.tenantId, x.inboxId, threadId, headerId, inReplyTo, JSON.stringify(refs), common.from, parsed.from?.name ?? null, base.to,
          JSON.stringify((parsed.cc ?? []).map(c => addr(c)).filter(Boolean)), subject, x.rawKey, x.sha, x.bytes.byteLength, text, html, now.replace("T", " ").slice(0, 19)),
      ...attRows.map(r => db.prepare("INSERT INTO nemail_attachments(id,nemail_tenant_id,message_id,filename,content_type,size_bytes,r2_key,sha256,disposition) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(r.id, x.tenantId, x.messageId, r.filename, r.type, r.size, r.key, r.sha, r.disposition)),
      db.prepare("INSERT INTO nemail_events(id,nemail_tenant_id,event_type,inbox_id,message_id,thread_id) VALUES(?,?,?,?,?,?)")
        .bind(`evt_${crypto.randomUUID()}`, x.tenantId, "email.message.received", x.inboxId, x.messageId, threadId),
    ];
    await db.batch(stmts);
  } catch (e) {
    await Promise.all(attKeys.map(k => r2.delete(k).catch(() => {})));
    if (await findDup().catch(() => null)) return; // concurrent duplicate delivery won the race
    throw e;
  }
}
