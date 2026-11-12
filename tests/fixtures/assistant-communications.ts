import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import type { CommunicationScope } from "../../workers/agents/src/communications/core.js";
export function fixture() {
  const db = createFakeD1([
    "CREATE TABLE orgs(id TEXT PRIMARY KEY,status TEXT,plan_tier TEXT NOT NULL DEFAULT 'free',owner_id TEXT); INSERT INTO orgs(id,status,plan_tier,owner_id) VALUES('tenant','active','free','user'); CREATE TABLE org_members(org_id TEXT,user_id TEXT,role TEXT,joined_at TEXT); CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT,status TEXT,parent_space_id TEXT,config_json TEXT,created_by TEXT); INSERT INTO spaces VALUES('space','tenant','active','root','{}','user'); CREATE TABLE space_members(space_id TEXT,end_user_id TEXT,role TEXT,suspended_at TEXT,tenant_id TEXT DEFAULT 'tenant'); INSERT INTO space_members(space_id,end_user_id,role,suspended_at,tenant_id) VALUES('space','user','owner',NULL,'tenant'),('space','other','member',NULL,'tenant'); CREATE TABLE agent_email_addresses(address_hash TEXT,tenant_id TEXT,space_id TEXT,agent_id TEXT,status TEXT,created_at TEXT); CREATE TABLE project_agent_email_addresses(address_hash TEXT,tenant_id TEXT,space_id TEXT,project_id TEXT,agent_id TEXT,status TEXT,created_at TEXT); CREATE TABLE business_memberships(business_space_id TEXT,end_user_id TEXT,role TEXT,status TEXT);",
    readFileSync(new URL("../../infra/migrations/0097_customer_voice_telephony.sql", import.meta.url), "utf8"),
    readFileSync(
      new URL(
        "../../infra/migrations/0130_assistant_communications.sql",
        import.meta.url
      ),
      "utf8"
    ),
  ]);
  db.db.exec(
    readFileSync(
      new URL(
        "../../infra/migrations/0131_assistant_phones.sql",
        import.meta.url
      ),
      "utf8"
    )
  );
  db.db.exec(
    readFileSync(
      new URL(
        "../../infra/migrations/0132_assistant_sms_verification.sql",
        import.meta.url
      ),
      "utf8"
    )
  );
  db.db.exec(
    readFileSync(
      new URL(
        "../../infra/migrations/0133_phone_extension_handlers.sql",
        import.meta.url
      ),
      "utf8"
    )
  );
  db.db.exec(
    readFileSync(
      new URL(
        "../../infra/migrations/0134_assistant_live_calls.sql",
        import.meta.url
      ),
      "utf8"
    )
  );
  db.db.exec(
    readFileSync(
      new URL(
        "../../infra/migrations/0135_assistant_coordination.sql",
        import.meta.url
      ),
      "utf8"
    )
  );
  db.db.exec(readFileSync(new URL("../../infra/migrations/0136_phone_provider_identity.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0137_telnyx_ingress_receipts.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0138_telnyx_usage_receipts.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0139_telnyx_cost_polling.sql", import.meta.url), "utf8"));
  for (const migration of ["0140_telnyx_live_calls.sql", "0141_managed_carrier_billing.sql", "0142_managed_phone_rentals.sql", "0143_managed_telnyx_inbound_costs.sql", "0155_telnyx_extension_calls.sql"]) {
    db.db.exec(readFileSync(new URL(`../../infra/migrations/${migration}`, import.meta.url), "utf8"));
  }
  db.db.exec(readFileSync(new URL("../../infra/migrations/0172_assistant_agentmail_accounts.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0179_managed_services_control_plane.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0180_managed_service_credit_reservations.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0181_managed_service_ownership_and_audit.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0182_managed_service_plan_entitlements.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0183_managed_service_reconciliation_schedule.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0188_managed_service_model_entitlements.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0192_managed_service_provider_cost_receipts.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0193_agentport_assistant_routing.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0194_agentport_scoped_managed_service_spend.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0195_telnyx_number_order_journal.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0200_telnyx_number_order_reconciliation.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0203_telnyx_number_release_reconciliation.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0202_telnyx_managed_service_account_registry.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0207_managed_service_provider_cost_observations.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0208_managed_service_agentport_link_state.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0209_managed_service_model_price_contract.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0210_managed_model_operation_results.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0211_managed_service_cost_budgets.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0217_managed_service_cost_budget_alerts.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0218_telnyx_voice_call_cost_receipts.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0219_managed_service_cost_budget_alert_delivery.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0220_managed_service_operation_quotes.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0212_userport_agentport_connector_sync.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0215_agentmail_usage_snapshots.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0216_agentmail_connection_region.sql", import.meta.url), "utf8"));
  db.db.exec(readFileSync(new URL("../../infra/migrations/0196_higgsfield_customer_owned_media.sql", import.meta.url), "utf8"));
  const objects = new Map<string, string>();
  const fetch = vi.fn(async (req: Request) =>
    req.url.includes("assistant-access")
      ? Response.json({
          effective_role: req.url.includes("user_id=other")
            ? "editor"
            : "owner",
        })
      : Response.json({
          preferences: { enabled: { email: true, phone: false } },
        })
  );
  const send = vi.fn(async (_input: unknown) => ({ messageId: "provider-id" }));
  const env = {
    PLATFORM_SECRET: "secret",
    HIGGSFIELD_BYO_ENABLED: "false",
    AGENTMAIL_WEBHOOK_URL:"https://api.example.test/internal/agentmail/webhook",
    AGENTPORT_EVENT_RECEIVER_URL:"https://api.example.test/internal/agentport/event",
    EMAIL_INGRESS_DOMAIN: "mail.example.com",
    EMAIL_SENDING_DOMAIN: "mail.example.com",
    PLATFORM_DB: db,
    SPACES_WORKER: { fetch },
    EMAIL: { send },
    CHANNEL_SESSIONS: { send: vi.fn(async () => undefined) },
    SCRIPTS_R2: {
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys])
          objects.delete(key);
      },
      put: async (key: string, value: string) => objects.set(key, value),
      get: async (key: string) =>
        objects.has(key)
          ? {
              size: objects.get(key)!.length,
              arrayBuffer: async () => new TextEncoder().encode(objects.get(key)!).buffer,
              json: async () => JSON.parse(objects.get(key)!),
            }
          : null,
    },
    AGENTS_WORKER: {
      fetch: vi.fn(async () => Response.json({ run_id: "run" })),
    },
    AGENTPORT_WORKER: {
      fetch: vi.fn(async (request:Request) => {
        const path=new URL(request.url).pathname;
        if(path.endsWith("/agents"))return Response.json({agent:{id:"naelao_agent",status:"active"}},{status:201});
        if(path.endsWith("/identity"))return Response.json({identity:{id:"naelao_agent",status:"active",principal:{id:"prn-org:tenant",type:"organization"}}});
        if(path.endsWith("/principals"))return Response.json({principal:{id:"prn-user:tenant:user",principal_type:"individual",external_id:"user"}},{status:201});
        if(path.endsWith("/accounts"))return Response.json({account:{id:"ap_account",status:"pending"}},{status:201});
        if(path.endsWith("/channels")&&request.method==="GET")return Response.json({channels:[]});
        if(path.endsWith("/channels"))return Response.json({channel:{id:"ap_channel"}},{status:201});
        if(path.endsWith("/access/check"))return Response.json({authorized:true});
        if(path.endsWith("/actions/authorize"))return Response.json({decision:"allow",authorizationId:"receipt-test",contentStored:false});
        if(path.endsWith("/events/subscriptions"))return Response.json({subscription:{id:"ap_subscription"},webhookSecret:"agentport-event-webhook-secret"},{status:201});
        if(path.endsWith("/claim"))return Response.json({claimed:true,event:{id:"event-1"}});
        if(path.endsWith("/ack"))return Response.json({acknowledged:true,status:"delivered"});
        return Response.json({active:true,revoked:true,subscription:{id:"sub"},grant:{id:"grant"}});
      }),
    },
  } as unknown as AgentsEnv;
  return { db, objects, env, send, fetch };
}
export const scope: CommunicationScope = {
  tenantId: "tenant",
  spaceId: "space",
  userId: "user",
  role: "product_end_user",
};
export function incoming(
  to: string,
  subject = "Hello",
  id = "message-1",
  text = "Do this task"
) {
  return {
    to,
    rawSize: 100,
    headers: new Headers(),
    setReject: vi.fn(),
    raw: new Blob([
      `From: owner@example.com\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.com>\r\nContent-Type: text/plain\r\n\r\n${text}`,
    ]).stream(),
  } as unknown as ForwardableEmailMessage;
}
