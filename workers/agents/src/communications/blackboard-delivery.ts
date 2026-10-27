import type { AgentsEnv } from "../index.js";
import { deliverAssistantEvent } from "./delivery-policy.js";
import type { CommunicationIdentity } from "./core.js";

/** Deliver only a generic notice; request content stays in the permission-checked inbox.
 * The channel delivery service owns deduplication, quiet hours and uncertain outcomes. */
export async function sweepBlackboardDelivery(env: AgentsEnv, now = Math.floor(Date.now() / 1000)) {
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO space_blackboard_delivery(tenant_id,space_id,project_id,event_id,identity_id,status,next_at)
    SELECT e.tenant_id,e.space_id,e.project_id,e.event_id,i.id,'pending',? FROM space_blackboard_events e
    JOIN assistant_communication_identities i ON i.tenant_id=e.tenant_id AND i.space_id=e.space_id AND i.project_id=e.project_id AND i.status='active'
    WHERE NOT EXISTS (SELECT 1 FROM space_blackboard_delivery d WHERE d.tenant_id=e.tenant_id AND d.space_id=e.space_id AND d.project_id=e.project_id AND d.event_id=e.event_id AND d.identity_id=i.id)
    ORDER BY e.created_at,e.event_id LIMIT 100`).bind(now).run();
  const due = await env.PLATFORM_DB.prepare(`SELECT tenant_id,space_id,project_id,event_id,identity_id FROM space_blackboard_delivery
    WHERE (status='pending' AND next_at<=?) OR (status='running' AND lease_until<=?) ORDER BY next_at,event_id LIMIT 25`)
    .bind(now,now).all<{tenant_id:string;space_id:string;project_id:string;event_id:string;identity_id:string}>();
  await Promise.all(due.results.map(async row => {
    const key = [row.tenant_id,row.space_id,row.project_id,row.event_id,row.identity_id];
    const claim = await env.PLATFORM_DB.prepare("UPDATE space_blackboard_delivery SET status='running',attempts=attempts+1,lease_until=? WHERE tenant_id=? AND space_id=? AND project_id=? AND event_id=? AND identity_id=? AND ((status='pending' AND next_at<=?) OR (status='running' AND lease_until<=?))")
      .bind(now+120,...key,now,now).run();
    if (!claim.meta.changes) return;
    try {
      const identity = await env.PLATFORM_DB.prepare("SELECT * FROM assistant_communication_identities WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND status='active'")
        .bind(row.identity_id,row.tenant_id,row.space_id,row.project_id).first<CommunicationIdentity>();
      if (!identity) throw new Error("identity_unavailable");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([row.project_id,row.event_id,row.identity_id]))));
      const eventId = `blackboard_${[...digest].map(b=>b.toString(16).padStart(2,"0")).join("")}`;
      await deliverAssistantEvent(env,{ tenantId:row.tenant_id,spaceId:row.space_id,projectId:row.project_id,userId:identity.owner_user_id,role:"product_end_user" },identity,
        { event_id:eventId,message:"A project coordination update is available in your blackboard inbox.",urgency:"normal" });
      await env.PLATFORM_DB.prepare("UPDATE space_blackboard_delivery SET status='delegated',lease_until=NULL WHERE tenant_id=? AND space_id=? AND project_id=? AND event_id=? AND identity_id=? AND status='running' AND lease_until=?")
        .bind(...key,now+120).run();
    } catch {
      await env.PLATFORM_DB.prepare("UPDATE space_blackboard_delivery SET status='pending',next_at=?,lease_until=NULL WHERE tenant_id=? AND space_id=? AND project_id=? AND event_id=? AND identity_id=? AND status='running' AND lease_until=?")
        .bind(now+3600,...key,now+120).run();
    }
  }));
  return { checked: due.results.length };
}
