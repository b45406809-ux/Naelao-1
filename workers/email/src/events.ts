// Delivery-status events for the nemail_events outbox (MS-34). References only: no subject, body or headers.
import type { WebhookEventType } from "./webhooks.js";

export type DeliveryEventType = Extract<WebhookEventType, "email.delivery.sent" | "email.delivery.failed" | "email.delivery.bounced" | "email.delivery.complained">;

const INSERT_FROM_DELIVERY = `INSERT OR IGNORE INTO nemail_events(id,nemail_tenant_id,event_type,inbox_id,message_id,thread_id,delivery_id)
  SELECT ?, d.nemail_tenant_id, ?, d.inbox_id, d.message_id, m.thread_id, d.id
  FROM nemail_deliveries d JOIN nemail_messages m ON m.id = d.message_id`;

/** Outbox row for one delivery, located by id (used where the delivery row is already known). */
export function deliveryEventByIdStmt(db: D1Database, type: DeliveryEventType, deliveryId: string): D1PreparedStatement {
  return db.prepare(`${INSERT_FROM_DELIVERY} WHERE d.id = ?`).bind(`evt_${crypto.randomUUID()}`, type, deliveryId);
}

/** Outbox row for one recipient of one outbound message (the send path knows message and recipient, not the delivery id). */
export function deliveryEventByRecipientStmt(db: D1Database, type: DeliveryEventType, tenantId: string, messageId: string, recipient: string): D1PreparedStatement {
  return db.prepare(`${INSERT_FROM_DELIVERY} WHERE d.nemail_tenant_id = ? AND d.message_id = ? AND d.recipient = ?`)
    .bind(`evt_${crypto.randomUUID()}`, type, tenantId, messageId, recipient);
}
