import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import type { CommunicationScope } from "../../workers/agents/src/communications/core.js";
export function fixture() {
  const db = createFakeD1([
    "CREATE TABLE orgs(id TEXT PRIMARY KEY,status TEXT); INSERT INTO orgs VALUES('tenant','active'); CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT,status TEXT,parent_space_id TEXT,config_json TEXT,created_by TEXT); INSERT INTO spaces VALUES('space','tenant','active','root','{}','user'); CREATE TABLE space_members(space_id TEXT,end_user_id TEXT,role TEXT,suspended_at TEXT); INSERT INTO space_members VALUES('space','user','owner',NULL); INSERT INTO space_members VALUES('space','other','member',NULL); CREATE TABLE agent_email_addresses(address_hash TEXT,tenant_id TEXT,space_id TEXT,agent_id TEXT,status TEXT,created_at TEXT); CREATE TABLE project_agent_email_addresses(address_hash TEXT,tenant_id TEXT,space_id TEXT,project_id TEXT,agent_id TEXT,status TEXT,created_at TEXT); CREATE TABLE business_memberships(business_space_id TEXT,end_user_id TEXT,role TEXT,status TEXT);",
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
    EMAIL_INGRESS_DOMAIN: "mail.example.com",
    EMAIL_SENDING_DOMAIN: "mail.example.com",
    PLATFORM_DB: db,
    SPACES_WORKER: { fetch },
    EMAIL: { send },
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
              json: async () => JSON.parse(objects.get(key)!),
            }
          : null,
    },
    AGENTS_WORKER: {
      fetch: vi.fn(async () => Response.json({ run_id: "run" })),
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
