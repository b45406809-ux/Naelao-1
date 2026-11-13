import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { app } from "../index.js";

const secret = "ocr-settings-test-secret";

function database(configJson: string, memberRole?: string) {
  const storage = createDOStorage();
  storage.sql.exec("CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,status TEXT NOT NULL,config_json TEXT,updated_at TEXT)");
  storage.sql.exec("INSERT INTO spaces(id,tenant_id,status,config_json) VALUES('space-1','tenant-1','active',?)", configJson);
  storage.sql.exec("CREATE TABLE space_members(space_id TEXT NOT NULL,end_user_id TEXT NOT NULL,role TEXT NOT NULL,suspended_at TEXT)");
  if (memberRole) storage.sql.exec("INSERT INTO space_members(space_id,end_user_id,role) VALUES('space-1','user-1',?)", memberRole);
  const db = {
    prepare(sql: string) {
      return { bind(...values: unknown[]) {
        return {
          first: async <T>() => storage.sql.exec<T>(sql, ...values).toArray()[0] ?? null,
          run: async () => ({ meta: { changes: storage.sql.exec(sql, ...values).rowsWritten } }),
          all: async <T>() => ({ results: storage.sql.exec<T>(sql, ...values).toArray() }),
        };
      } };
    },
  };
  return { db: db as never, storage };
}

async function request(path: string, method: string, db: never, role = "admin", body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant-1",
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-1"),
      "x-naelao-user-id": "user-1",
      "x-naelao-role": role,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { PLATFORM_SECRET: secret, PLATFORM_DB: db } as never);
}

describe("owner-controlled hosted attachment OCR settings", () => {
  it("saves the opt-in without clobbering unrelated Space configuration", async () => {
    const state = database('{"template_id":"retail","productConfig":{"modelConfig":{"model":"claude-haiku-4-5-20251001"}}}');
    const response = await request("/spaces/space-1/assistant/attachment-ocr", "PATCH", state.db, "admin", { enabled: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    expect(state.storage.sql.exec<{ config_json: string }>("SELECT config_json FROM spaces WHERE id='space-1'").toArray()[0]!.config_json).toEqual(
      '{"template_id":"retail","productConfig":{"modelConfig":{"model":"claude-haiku-4-5-20251001"},"attachmentOcr":{"enabled":true}}}',
    );
  });

  it("keeps OCR disabled for an air-gapped Space", async () => {
    const state = database('{"compliance":{"airGappedOnly":true}}');
    const response = await request("/spaces/space-1/assistant/attachment-ocr", "PATCH", state.db, "admin", { enabled: true });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "attachment_ocr_egress_denied" });
    expect(JSON.parse(state.storage.sql.exec<{ config_json: string }>("SELECT config_json FROM spaces WHERE id='space-1'").toArray()[0]!.config_json).productConfig).toBeUndefined();
  });

  it("reads the setting for members but rejects product users without verified business membership", async () => {
    const state = database('{"productConfig":{"attachmentOcr":{"enabled":true}}}');
    const read = await request("/spaces/space-1/assistant/attachment-ocr", "GET", state.db, "member");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ enabled: true });
    const denied = await request("/spaces/space-1/assistant/attachment-ocr", "PATCH", state.db, "product_end_user", { enabled: false });
    expect(denied.status).toBe(403);
  });
});

describe("owner-controlled hosted video frame analysis settings", () => {
  it("persists an independent opt-in without enabling image OCR or changing other configuration", async () => {
    const state = database('{"template_id":"retail","productConfig":{"modelConfig":{"model":"claude-haiku-4-5-20251001"}}}');
    const response = await request("/spaces/space-1/assistant/video-frame-analysis", "PATCH", state.db, "admin", { enabled: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    expect(state.storage.sql.exec<{ config_json: string }>("SELECT config_json FROM spaces WHERE id='space-1'").toArray()[0]!.config_json).toEqual(
      '{"template_id":"retail","productConfig":{"modelConfig":{"model":"claude-haiku-4-5-20251001"},"attachmentVideoFrameAnalysis":{"enabled":true}}}',
    );
    expect((await request("/spaces/space-1/assistant/attachment-ocr", "GET", state.db, "admin")).status).toBe(200);
    expect(await (await request("/spaces/space-1/assistant/attachment-ocr", "GET", state.db, "admin")).json()).toEqual({ enabled: false });
  });

  it("keeps video analysis off by default, blocks air-gapped enablement, and rejects non-admin writes", async () => {
    const state = database("{}", "member");
    const read = await request("/spaces/space-1/assistant/video-frame-analysis", "GET", state.db, "product_end_user");
    expect(await read.json()).toEqual({ enabled: false });
    const airGapped = database('{"compliance":{"airGappedOnly":true}}');
    expect((await request("/spaces/space-1/assistant/video-frame-analysis", "PATCH", airGapped.db, "admin", { enabled: true })).status).toBe(403);
    expect((await request("/spaces/space-1/assistant/video-frame-analysis", "PATCH", state.db, "product_end_user", { enabled: true })).status).toBe(403);
  });
});
