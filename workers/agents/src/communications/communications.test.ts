import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { mintInternalToken } from "@naelao/http";
import {
  ensureIdentity,
  storeBody,
  readBody,
  sendDraft,
  type CommunicationScope,
} from "./core.js";
import { receiveAssistantEmail } from "./inbound.js";
import { registerCommunicationRoutes } from "./routes.js";
import type { AgentsEnv } from "../index.js";
import {
  fixture,
  scope,
  incoming,
} from "../../../../tests/fixtures/assistant-communications.js";
async function draft(f: ReturnType<typeof fixture>) {
  const identity = await ensureIdentity(f.env, scope),
    key = await storeBody(f.env, identity, "draft", {
      text: "private-message",
    });
  await f.db
    .prepare(
      "INSERT INTO assistant_communication_messages(id,identity_id,direction,sender,recipient,subject,status,body_key) VALUES('draft',?,'outbound','assistant','friend@example.com','Hello','approved',?)"
    )
    .bind(identity.id, key)
    .run();
  return identity;
}
describe("scoped assistant communications", () => {
  it("isolates Space identities and denies first-reader ownership of project mail", async () => {
    const f = fixture();
    expect((await ensureIdentity(f.env, scope)).id).not.toBe(
      (await ensureIdentity(f.env, { ...scope, userId: "other" })).id
    );
    await expect(
      ensureIdentity(f.env, { ...scope, userId: "other", projectId: "project" })
    ).rejects.toThrow("owner_setup");
  });
  it("encrypts mail and binds it to the exact assistant", async () => {
    const f = fixture(),
      identity = await draft(f);
    expect([...f.objects.values()].join("")).not.toContain("private-message");
    expect(
      await readBody(
        f.env,
        identity,
        "draft",
        `spaces/space/communications/${identity.id}/draft.json`
      )
    ).toEqual({ text: "private-message" });
    await expect(
      readBody(
        f.env,
        { ...identity, id: "other" },
        "draft",
        `spaces/space/communications/${identity.id}/draft.json`
      )
    ).rejects.toThrow("scope");
  });
  it("sends once and reuses the saved receipt", async () => {
    const f = fixture(),
      identity = await draft(f);
    await sendDraft(f.env, scope, identity, "draft");
    await sendDraft(f.env, scope, identity, "draft");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({
      headers: { "X-Naelao-Message-ID": "draft" },
    });
  });
  it("never repeats an ambiguous provider send", async () => {
    const f = fixture(),
      identity = await draft(f);
    f.send.mockRejectedValue(new Error("lost response"));
    await expect(sendDraft(f.env, scope, identity, "draft")).rejects.toThrow(
      "reconciliation"
    );
    await expect(sendDraft(f.env, scope, identity, "draft")).rejects.toThrow(
      "approval"
    );
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("refuses recipients outside standing permissions", async () => {
    const f = fixture(),
      identity = await draft(f);
    await f.db
      .prepare(
        "UPDATE assistant_communication_messages SET status='draft' WHERE id='draft'"
      )
      .bind()
      .run();
    identity.autonomy_json = JSON.stringify({
      mode: "standing",
      recipients: ["different@example.com"],
      dailySendLimit: 20,
    });
    await expect(sendDraft(f.env, scope, identity, "draft")).rejects.toThrow(
      "approval"
    );
    expect(f.send).not.toHaveBeenCalled();
  });
  it("stores forged owner messages as pending and deduplicates delivery", async () => {
    const f = fixture(),
      identity = await ensureIdentity(f.env, scope);
    await f.db
      .prepare(
        "INSERT INTO assistant_communication_controllers(identity_id,user_id,channel,address,verified_at) VALUES(?,'user','email','owner@example.com',datetime('now'))"
      )
      .bind(identity.id)
      .run();
    await receiveAssistantEmail(incoming(identity.email_address!), f.env);
    await receiveAssistantEmail(incoming(identity.email_address!), f.env);
    expect(
      (
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM assistant_communication_messages")
          .first<{ n: number }>()
      )?.n
    ).toBe(1);
    expect(
      (
        await f.db
          .prepare("SELECT status FROM assistant_communication_commands")
          .first<{ status: string }>()
      )?.status
    ).toBe("pending");
    expect(f.env.CHANNEL_SESSIONS?.send).toHaveBeenCalledTimes(1);
    expect(f.env.CHANNEL_SESSIONS?.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "inbound_channel", channel_type: "email", space_id: "space", tenant_id: "tenant",
      end_user_id: "owner@example.com", content: expect.stringContaining("Subject: Hello"),
      metadata: expect.objectContaining({ providerMessageId: "<message-1@example.com>", trustLevel: "unverified" }),
    }));
    expect(f.env.AGENTS_WORKER.fetch).not.toHaveBeenCalled();
  });
  it("downloads only an attached inbound file for its mailbox owner with bounded binary headers", async () => {
    const f = fixture(),
      identity = await ensureIdentity(f.env, scope),
      messageId = "mail-large",
      attachmentId = `${messageId}-a0`,
      size = 1024 * 1024 + 17,
      bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32 * 1024)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
    const metadata = { id: attachmentId, filename: "quarterly report.bin", mimeType: "application/octet-stream", sizeBytes: size };
    const attachmentKey = await storeBody(f.env, identity, attachmentId, {
      data: btoa(binary), filename: metadata.filename, mimeType: metadata.mimeType, sizeBytes: size,
    });
    const messageKey = await storeBody(f.env, identity, messageId, { text: "See attached", attachments: [metadata], untrusted: true });
    expect(attachmentKey).toBe(`spaces/space/communications/${identity.id}/${attachmentId}.json`);
    await f.db.prepare(
      "INSERT INTO assistant_communication_messages(id,identity_id,direction,sender,recipient,subject,status,body_key) VALUES(?,?,'inbound','sender@example.com','owner@example.com','Report','received',?)"
    ).bind(messageId, identity.id, messageKey).run();

    const app = new Hono<{ Bindings: AgentsEnv }>();
    registerCommunicationRoutes(app);
    const headers = {
      "x-naelao-tenant-id": "tenant",
      "x-naelao-user-id": "user",
      "x-naelao-role": "owner",
      "x-naelao-internal-token": await mintInternalToken("secret", "tenant"),
    };
    const response = await app.request(
      `/spaces/space/assistant-communications?action=attachment&id=${messageId}&attachment_id=${attachmentId}`,
      { headers },
      f.env
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''quarterly%20report.bin");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const foreign = await app.request(
      `/spaces/space/assistant-communications?action=attachment&id=${messageId}&attachment_id=unrelated-file`,
      { headers },
      f.env
    );
    expect(foreign.status).toBe(404);
  }, 30_000);
  it("requires project mailbox ownership before returning attachment bytes", async () => {
    const f = fixture(),
      projectScope = { ...scope, projectId: "project" },
      identity = await ensureIdentity(f.env, projectScope),
      messageId = "mail-project",
      attachmentId = `${messageId}-a0`,
      metadata = { id: attachmentId, filename: "private.txt", mimeType: "text/plain", sizeBytes: 6 };
    await storeBody(f.env, identity, attachmentId, { data: btoa("secret"), filename: metadata.filename, mimeType: metadata.mimeType, sizeBytes: metadata.sizeBytes });
    const messageKey = await storeBody(f.env, identity, messageId, { text: "See attached", attachments: [metadata] });
    await f.db.prepare(
      "INSERT INTO assistant_communication_messages(id,identity_id,direction,sender,recipient,subject,status,body_key) VALUES(?,?,'inbound','sender@example.com','owner@example.com','Private','received',?)"
    ).bind(messageId, identity.id, messageKey).run();
    const app = new Hono<{ Bindings: AgentsEnv }>();
    registerCommunicationRoutes(app);
    const response = await app.request(
      `/spaces/space/assistant-communications?action=attachment&project_id=project&id=${messageId}&attachment_id=${attachmentId}`,
      { headers: {
        "x-naelao-tenant-id": "tenant",
        "x-naelao-user-id": "other",
        "x-naelao-role": "product_end_user",
        "x-naelao-internal-token": await mintInternalToken("secret", "tenant"),
      } },
      f.env
    );
    expect(response.status).toBe(403);
  });
  it("uses project membership as a mailbox read grant while keeping private verification and command controls owner-scoped", async () => {
    const f = fixture(),
      projectScope = { ...scope, projectId: "project" },
      identity = await ensureIdentity(f.env, projectScope),
      messageId = "mail-private",
      messageKey = await storeBody(f.env, identity, messageId, {
        text: "Shared project message",
        private_text: "Owner-only verification code 123456",
        private_subject: "Private verification",
        private_actor_id: "user",
        untrusted: true,
      });
    await f.db.prepare(
      "INSERT INTO assistant_communication_messages(id,identity_id,direction,sender,recipient,subject,status,body_key) VALUES(?,?,'inbound','sender@example.com','project@example.com','Shared subject','received',?)"
    ).bind(messageId, identity.id, messageKey).run();
    await f.db.prepare(
      "INSERT INTO assistant_communication_commands(id,identity_id,message_id,controller_user_id) VALUES('command-1',?,?,?)"
    ).bind(identity.id, messageId, "user").run();

    const app = new Hono<{ Bindings: AgentsEnv }>();
    registerCommunicationRoutes(app);
    const memberHeaders = {
      "x-naelao-tenant-id": "tenant",
      "x-naelao-user-id": "other",
      "x-naelao-role": "product_end_user",
      "x-naelao-internal-token": await mintInternalToken("secret", "tenant"),
    };
    const list = await app.request(
      "/spaces/space/assistant-communications?action=messages&project_id=project",
      { headers: memberHeaders },
      f.env
    );
    expect(list.status).toBe(200);
    expect((await list.json<{ data: Array<{ id: string }> }>()).data[0]?.id).toBe(messageId);
    const read = await app.request(
      `/spaces/space/assistant-communications?action=message&project_id=project&id=${messageId}`,
      { headers: memberHeaders },
      f.env
    );
    const memberBody = await read.json<{ body: Record<string, unknown> }>();
    expect(read.status).toBe(200);
    expect(memberBody.body.text).toBe("Shared project message");
    expect(memberBody.body).not.toHaveProperty("private_text");
    expect(memberBody.body).not.toHaveProperty("private_subject");
    const commands = await app.request(
      "/spaces/space/assistant-communications?action=commands&project_id=project",
      { headers: memberHeaders },
      f.env
    );
    expect(commands.status).toBe(403);

    const ownerRead = await app.request(
      `/spaces/space/assistant-communications?action=message&project_id=project&id=${messageId}`,
      { headers: {
        ...memberHeaders,
        "x-naelao-user-id": "user",
        "x-naelao-role": "owner",
      } },
      f.env
    );
    expect((await ownerRead.json<{ body: { text: string; subject?: string } }>()).body).toMatchObject({
      text: "Owner-only verification code 123456",
      subject: "Private verification",
    });
  });
  it("blocks protected worker operations and unsigned requests", async () => {
    const f = fixture(),
      app = new Hono<{ Bindings: AgentsEnv }>();
    registerCommunicationRoutes(app);
    expect(
      (await app.request("/spaces/space/assistant-communications", {}, f.env))
        .status
    ).toBe(403);
    const r = await app.request(
      "/internal/assistant-communications",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant",
          "x-naelao-user-id": "user",
          "x-naelao-role": "product_end_user",
          "x-naelao-internal-token": await mintInternalToken(
            "secret",
            "tenant"
          ),
        },
        body: JSON.stringify({
          spaceId: "space",
          action: "set-policy",
          policy: { mode: "standing", recipients: [], dailySendLimit: 20 },
        }),
      },
      f.env
    );
    expect(r.status).toBe(403);
  });
});
