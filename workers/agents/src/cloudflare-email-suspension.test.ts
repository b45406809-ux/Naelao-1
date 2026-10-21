import { describe, expect, it, vi } from "vitest";
import { handleCloudflareEmail } from "./index.js";
import type { AgentsEnv } from "./index.js";

const rawEmail = [
  "From: customer@example.test",
  "To: reply-abc@example.test",
  "Subject: Question",
  "Message-ID: <event-a@example.test>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello",
  "",
].join("\r\n");
const rawEmailWithAttachment = [
  "From: customer@example.test",
  "To: reply-abc@example.test",
  "Subject: Attachment",
  "Message-ID: <event-b@example.test>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="boundary-a"',
  "",
  "--boundary-a",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "See file",
  "--boundary-a",
  'Content-Type: application/pdf; name="invoice.pdf"',
  'Content-Disposition: attachment; filename="invoice.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQ=",
  "--boundary-a--",
  "",
].join("\r\n");

describe("Cloudflare email ingress suspension boundary", () => {
  it("rejects if the tenant is suspended while the inbound MIME message is parsed", async () => {
    let activeChecks = 0;
    const prepare = vi.fn((sql: string) => ({
      bind: (..._values: unknown[]) => ({
        first: async () => {
          if (sql.includes("FROM email_reply_routes")) return { tenant_id: "tenant-a", space_id: "space-a", task_id: "task-a", agent_id: "agent-a", project_id: null };
          if (sql.includes("SELECT s.status FROM spaces")) return { status: "active" };
          if (sql.includes("SELECT s.id FROM spaces s")) return ++activeChecks === 1 ? null : { id: "space-a" };
          return null;
        },
      }),
    }));
    const get = vi.fn();
    const message = {
      to: "reply-abc@agents.example.test",
      rawSize: new TextEncoder().encode(rawEmail).byteLength,
      raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(rawEmail)); controller.close(); } }),
      setReject: vi.fn(),
    };
    const env = {
      PLATFORM_SECRET: "cloudflare-email-suspension-secret",
      EMAIL_INGRESS_DOMAIN: "agents.example.test",
      PLATFORM_DB: { prepare },
      NAELAO_AGENT_DO: { idFromName: vi.fn(value => value), get },
    } as unknown as AgentsEnv;

    await handleCloudflareEmail(message as never, env);

    expect(message.setReject).toHaveBeenCalledWith("Naelao workspace is unavailable");
    expect(activeChecks).toBe(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("deletes an attachment written just before tenant suspension and skips metadata writes", async () => {
    let activeChecks = 0;
    const writes: string[] = [];
    const prepare = vi.fn((sql: string) => ({
      bind: (..._values: unknown[]) => ({
        first: async () => {
          if (sql.includes("FROM email_reply_routes")) return { tenant_id: "tenant-a", space_id: "space-a", task_id: "task-a", agent_id: "agent-a", project_id: null };
          if (sql.includes("SELECT s.status FROM spaces")) return { status: "active" };
          if (sql.includes("SELECT s.id FROM spaces s")) return ++activeChecks < 3 ? { id: "space-a" } : null;
          return null;
        },
        run: async () => { writes.push(sql); return { success: true }; },
      }),
    }));
    const put = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const get = vi.fn();
    const message = {
      to: "reply-abc@agents.example.test",
      rawSize: new TextEncoder().encode(rawEmailWithAttachment).byteLength,
      raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(rawEmailWithAttachment)); controller.close(); } }),
      setReject: vi.fn(),
    };
    const env = {
      PLATFORM_SECRET: "cloudflare-email-suspension-secret",
      EMAIL_INGRESS_DOMAIN: "agents.example.test",
      PLATFORM_DB: { prepare },
      SCRIPTS_R2: { put, delete: remove },
      NAELAO_AGENT_DO: { idFromName: vi.fn(value => value), get },
    } as unknown as AgentsEnv;

    await handleCloudflareEmail(message as never, env);

    expect(message.setReject).toHaveBeenCalledWith("Naelao workspace is unavailable");
    expect(activeChecks).toBe(3);
    expect(put).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});
