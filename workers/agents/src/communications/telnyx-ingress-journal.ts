/** Journal authenticated Telnyx event deliveries before any extension dispatch. A claimed
 * event is never replayed automatically: a crash may have occurred after the handler acted. */
export async function claimTelnyxIngress(db: D1Database, bindingId: string, eventId: string, rawBody: string) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(bindingId) || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)
    || new TextEncoder().encode(rawBody).byteLength > 256 * 1024) throw new Error("telnyx_ingress_invalid");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const now = Math.floor(Date.now() / 1000);
  const inserted = await db.prepare("INSERT OR IGNORE INTO assistant_telnyx_ingress_receipts(binding_id,event_id,payload_hash,state,created_at,updated_at) VALUES(?,?,?,'claimed',?,?)")
    .bind(bindingId, eventId, hash, now, now).run();
  if (inserted.meta.changes === 1) return { state: "claimed" as const, acquired: true };
  const row = await db.prepare("SELECT payload_hash,state FROM assistant_telnyx_ingress_receipts WHERE binding_id=? AND event_id=?")
    .bind(bindingId, eventId).first<{ payload_hash: string; state: "claimed" | "completed" | "indeterminate" }>();
  if (!row || row.payload_hash !== hash) throw new Error("telnyx_ingress_event_conflict");
  return { state: row.state, acquired: false };
}

export async function finishTelnyxIngress(db: D1Database, bindingId: string, eventId: string, state: "completed" | "indeterminate") {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(bindingId) || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)
    || !["completed", "indeterminate"].includes(state)) throw new Error("telnyx_ingress_invalid");
  const update = await db.prepare("UPDATE assistant_telnyx_ingress_receipts SET state=?,updated_at=? WHERE binding_id=? AND event_id=? AND state='claimed'")
    .bind(state, Math.floor(Date.now() / 1000), bindingId, eventId).run();
  if (update.meta.changes !== 1) throw new Error("telnyx_ingress_claim_not_active");
}
