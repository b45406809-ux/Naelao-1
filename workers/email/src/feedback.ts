// Bounce (DSN, RFC 3464) and complaint (ARF, RFC 5965) ingestion plus MR-EM-5 auto-pause.
export interface FeedbackReport { kind: "bounce" | "complaint"; originalMessageId: string | null; recipients: string[] }

export const MIN_SAMPLE_SENDS = 50;
export const COMPLAINT_RATE_LIMIT = 0.003;
export const BOUNCE_RATE_LIMIT = 0.05;
const COMPLAINT_TYPES = new Set(["abuse", "fraud", "virus", "other"]);

function splitHeaders(text: string): { headers: Map<string, string>; body: string } {
  const m = /\r?\n\r?\n/.exec(text);
  const head = m ? text.slice(0, m.index) : text;
  const body = m ? text.slice(m.index + m[0].length) : "";
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!headers.has(k)) headers.set(k, line.slice(i + 1).trim()); }
  }
  return { headers, body };
}
const param = (value: string | undefined, name: string) => {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i").exec(value ?? "");
  return m ? (m[1] ?? m[2] ?? "") : null;
};
const mainType = (v: string | undefined) => (v ?? "").split(";")[0]!.trim().toLowerCase();
const cleanAddr = (v: string | undefined) => {
  const s = (v ?? "").replace(/^[^;]*;/, "").trim().replace(/^<|>$/g, "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(s) ? s : null;
};
const cleanId = (v: string | undefined) => { const s = (v ?? "").trim().replace(/^<|>$/g, "").trim(); return s && s.length <= 998 ? s : null; };

/** Returns reports found in a multipart/report message, or [] for anything else (never throws). */
export function parseFeedback(bytes: Uint8Array): FeedbackReport[] {
  try {
    const text = new TextDecoder("utf-8").decode(bytes);
    const top = splitHeaders(text);
    const ct = top.headers.get("content-type");
    if (mainType(ct) !== "multipart/report") return [];
    const boundary = param(ct, "boundary");
    const reportType = (param(ct, "report-type") ?? "").toLowerCase();
    if (!boundary || (reportType !== "delivery-status" && reportType !== "feedback-report")) return [];
    const parts = top.body.split(`--${boundary}`).slice(1).filter(p => !p.startsWith("--")).map(p => splitHeaders(p.replace(/^\r?\n/, "")));
    let originalId: string | null = null;
    for (const p of parts) {
      const t = mainType(p.headers.get("content-type"));
      if (t === "message/rfc822" || t === "text/rfc822-headers") {
        const inner = splitHeaders(p.body);
        originalId = cleanId(inner.headers.get("message-id"));
        if (originalId) break;
      }
    }
    const out: FeedbackReport[] = [];
    for (const p of parts) {
      const t = mainType(p.headers.get("content-type"));
      if (reportType === "delivery-status" && t === "message/delivery-status") {
        const blocks = p.body.split(/\r?\n\r?\n/).map(b => splitHeaders(b + "\n\n").headers).slice(1);
        const recipients = new Set<string>();
        for (const b of blocks) {
          const action = (b.get("action") ?? "").toLowerCase(), status = b.get("status") ?? "";
          const rcpt = cleanAddr(b.get("final-recipient") ?? b.get("original-recipient"));
          if (rcpt && action === "failed" && status.startsWith("5")) recipients.add(rcpt);
        }
        if (recipients.size > 0) out.push({ kind: "bounce", originalMessageId: originalId, recipients: [...recipients] });
      } else if (reportType === "feedback-report" && t === "message/feedback-report") {
        const f = splitHeaders(p.body + "\n\n").headers;
        if (!COMPLAINT_TYPES.has((f.get("feedback-type") ?? "").toLowerCase())) continue;
        const rcpt = cleanAddr(f.get("original-rcpt-to") ?? f.get("removal-recipient"));
        out.push({ kind: "complaint", originalMessageId: originalId, recipients: rcpt ? [rcpt] : [] });
      }
    }
    return out;
  } catch { return []; }
}

/**
 * Applies reports. A report only counts when its original Message-ID is one of our outbound messages (of `onlyTenant`
 * when the report arrived at a tenant inbox) and the recipient is one of that message's deliveries, so a forged report
 * cannot suppress arbitrary addresses. Idempotent.
 */
export async function applyFeedback(db: D1Database, reports: FeedbackReport[], onlyTenant?: string): Promise<number> {
  let applied = 0;
  const tenants = new Set<string>();
  for (const r of reports) {
    if (!r.originalMessageId) continue;
    const msg = await db.prepare(`SELECT id, nemail_tenant_id FROM nemail_messages WHERE direction='outbound' AND message_id_header=? ${onlyTenant ? "AND nemail_tenant_id=?" : ""} LIMIT 1`)
      .bind(...[r.originalMessageId, ...(onlyTenant ? [onlyTenant] : [])]).first<{ id: string; nemail_tenant_id: string }>();
    if (!msg) continue;
    const tenantId = msg.nemail_tenant_id;
    const rows = await db.prepare("SELECT id, recipient, status FROM nemail_deliveries WHERE message_id=? AND nemail_tenant_id=?").bind(msg.id, tenantId).all<{ id: string; recipient: string; status: string }>();
    const wanted = r.recipients.length > 0 ? new Set(r.recipients) : null; // complaint without a recipient: every recipient of the message
    for (const d of rows.results) {
      if (wanted && !wanted.has(d.recipient)) continue;
      const res = await db.prepare(
        r.kind === "bounce"
          ? "UPDATE nemail_deliveries SET status='bounced', updated_at=datetime('now') WHERE id=? AND status IN ('queued','sent','delivered','unknown')"
          : "UPDATE nemail_deliveries SET status='complained', updated_at=datetime('now') WHERE id=? AND status IN ('queued','sent','delivered','unknown','bounced')"
      ).bind(d.id).run();
      if ((res.meta?.changes ?? 0) > 0) applied++;
      if (d.status === "failed") continue; // never sent: nothing to suppress
      await db.prepare("INSERT OR IGNORE INTO nemail_suppressions(id,nemail_tenant_id,address,reason) VALUES(?,?,?,?)")
        .bind(`sup_${crypto.randomUUID()}`, tenantId, d.recipient, r.kind === "bounce" ? "hard_bounce" : "complaint").run();
    }
    tenants.add(tenantId);
  }
  for (const t of tenants) await evaluateAutoPause(db, t);
  return applied;
}

/** MR-EM-5: pause when complaints > 0.3% or bounces > 5% of sends in the trailing 7 days (min 50 sends, counted since the last operator resume). */
export async function evaluateAutoPause(db: D1Database, tenantId: string): Promise<boolean> {
  const s = await db.prepare(
    `SELECT count(*) AS total, COALESCE(sum(status='bounced'),0) AS bounced, COALESCE(sum(status='complained'),0) AS complained
     FROM nemail_deliveries WHERE nemail_tenant_id=? AND status IN ('sent','delivered','bounced','complained','unknown')
     AND created_at >= MAX(datetime('now','-7 days'), COALESCE((SELECT sending_resumed_at FROM nemail_tenants WHERE id=?),'0000'))`
  ).bind(tenantId, tenantId).first<{ total: number; bounced: number; complained: number }>();
  if (!s || s.total < MIN_SAMPLE_SENDS) return false;
  const reason = s.complained / s.total > COMPLAINT_RATE_LIMIT ? "complaint_rate" : s.bounced / s.total > BOUNCE_RATE_LIMIT ? "bounce_rate" : null;
  if (!reason) return false;
  const res = await db.prepare("UPDATE nemail_tenants SET sending_paused=1, sending_paused_reason=?, sending_paused_at=datetime('now') WHERE id=? AND sending_paused=0").bind(reason, tenantId).run();
  return (res.meta?.changes ?? 0) > 0;
}
