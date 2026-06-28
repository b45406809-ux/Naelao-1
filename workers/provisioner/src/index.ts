// G-Q01: Space Provisioning Queue Worker — handles space_provision and space_deprovision messages
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SPACES_KV: KVNamespace;
  SPACES_API_URL: string;
}

interface ProvisionMessage {
  type: "space_provision" | "space_deprovision";
  spaceId: string;
  tenantId: string;
  spaceTypeId: string;
  spaceName: string;
  requestedAt: string;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

async function provisionSpace(msg: ProvisionMessage, env: Env): Promise<void> {
  const { spaceId, tenantId, spaceTypeId, spaceName } = msg;
  const now = new Date().toISOString();

  // Step 1: Mark space as provisioning
  await env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'provisioning', updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(now, spaceId, tenantId).run();

  // Step 2: Store initial config in KV for fast reads
  const spaceConfig = {
    spaceId,
    tenantId,
    spaceTypeId,
    name: spaceName,
    status: "active",
    provisionedAt: now,
  };
  await env.SPACES_KV.put(`space:${tenantId}:${spaceId}`, JSON.stringify(spaceConfig), { expirationTtl: 86400 });

  // Step 3: Fetch SpaceType config to get default tools/system prompt
  const spaceType = await env.PLATFORM_DB.prepare(
    "SELECT id, name, config_json FROM space_types WHERE id = ?"
  ).bind(spaceTypeId).first<{ id: string; name: string; config_json: string }>();

  const config = spaceType ? JSON.parse(spaceType.config_json) as Record<string, unknown> : {};

  // Step 4: Write default welcome message to D1 (the SpaceDO will load it on first access)
  const welcomeMessageId = crypto.randomUUID();
  const welcomeContent = typeof config["welcome_message"] === "string"
    ? config["welcome_message"]
    : `Welcome to ${spaceName}! How can I help you today?`;

  await env.PLATFORM_DB.prepare(
    `INSERT OR IGNORE INTO space_welcome_messages (id, space_id, tenant_id, content, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    welcomeMessageId,
    spaceId,
    tenantId,
    welcomeContent,
    now
  ).run();

  // Step 5: Mark space as active
  await env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'active', updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(now, spaceId, tenantId).run();
}

async function deprovisionSpace(msg: ProvisionMessage, env: Env): Promise<void> {
  const { spaceId, tenantId } = msg;
  const now = new Date().toISOString();

  // Mark space as deleted
  await env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'deleted', updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(now, spaceId, tenantId).run();

  // Remove KV cache
  await env.SPACES_KV.delete(`space:${tenantId}:${spaceId}`);
}

export async function queue(batch: MessageBatch<ProvisionMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (message.body.type === "space_provision") {
        await provisionSpace(message.body, env);
      } else if (message.body.type === "space_deprovision") {
        await deprovisionSpace(message.body, env);
      }
      message.ack();
    } catch (err) {
      console.error("[provisioner] Error processing message:", err);
      message.retry();
    }
  }
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// GET /health — health check
app.get("/health", (c) => c.json({ ok: true, service: "provisioner" }));

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default {
  fetch: app.fetch,
  queue: queue as ExportedHandlerQueueHandler<Env>,
} satisfies ExportedHandler<Env>;
