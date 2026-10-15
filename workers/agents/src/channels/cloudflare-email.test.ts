import { describe, expect, it } from "vitest";
import {
  createAgentEmailAddress, createReplyAddress, emailReplyBody, hashEmailAddress, normalizeIngressDomain,
  parseCloudflareEmail, safeFilename,
} from "./cloudflare-email.js";

function stream(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

const MIME = [
  "From: Vendor <vendor@example.test>",
  "To: reply-abc@example.test",
  "Subject: Invoice reply",
  "Message-ID: <msg-1@example.test>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="naelao-boundary"',
  "",
  "--naelao-boundary",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "The invoice is attached.",
  "--naelao-boundary",
  'Content-Type: application/pdf; name="invoice.pdf"',
  'Content-Disposition: attachment; filename="invoice.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQ=",
  "--naelao-boundary--",
  "",
].join("\r\n");

describe("Cloudflare email ingress helpers", () => {
  it("derives one opaque stable address per tenant, Space, and task", async () => {
    const input = { domain: "agents.example.test", tenantId: "t1", spaceId: "s1", taskId: "run1", secret: "platform-secret" };
    const address = await createReplyAddress(input);
    expect(address).toBe(await createReplyAddress(input));
    expect(address).toMatch(/^reply-[a-f0-9]{32}@agents\.example\.test$/);
    expect(await createReplyAddress({ ...input, taskId: "run2" })).not.toBe(address);
    expect(await hashEmailAddress(address.toUpperCase())).toBe(await hashEmailAddress(address));
  });

  it("derives a distinct stable address for each agent without exposing its identifiers", async () => {
    const input = { domain: "agents.example.test", tenantId: "tenant-secret", spaceId: "space-secret", agentId: "agent-secret", secret: "platform-secret" };
    const address = await createAgentEmailAddress(input);
    expect(address).toBe(await createAgentEmailAddress(input));
    expect(address).toMatch(/^agent-[a-f0-9]{32}@agents\.example\.test$/);
    expect(address).not.toContain("tenant-secret");
    expect(await createAgentEmailAddress({ ...input, agentId: "another-agent" })).not.toBe(address);
  });

  it("parses bounded text and MIME attachments from Cloudflare's raw stream", async () => {
    const parsed = await parseCloudflareEmail(stream(MIME));
    expect(parsed).toMatchObject({ from: "vendor@example.test", subject: "Invoice reply", messageId: "<msg-1@example.test>", text: "The invoice is attached." });
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: "invoice.pdf", mimeType: "application/pdf" });
    expect(new TextDecoder().decode(parsed.attachments[0]!.bytes)).toBe("%PDF-1.4");
  });

  it("normalizes domains, sanitizes attachment paths, and emits task/attachment context", () => {
    expect(normalizeIngressDomain(" Agents.Example.Test. ")).toBe("agents.example.test");
    expect(normalizeIngressDomain("bad..example")).toBeNull();
    expect(safeFilename("../../invoice.pdf")).toBe("_.._invoice.pdf");
    expect(emailReplyBody({ taskId: "run1", subject: "Invoice", text: "See attached", attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", key: "spaces/s/email/a.pdf" }] }))
      .toContain("r2://spaces/s/email/a.pdf");
  });
});
