import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "../index.js";

const secret = "transcription-route-secret";
function env(options: { owned?: boolean; airGapped?: boolean; mime?: string } = {}) {
  let reads = 0;
  const ai = { run: vi.fn(async () => ({ text: "recognized words" })) };
  const value = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare(sql: string) { return { bind(...values: unknown[]) { return { async first() {
      if (sql.includes("SELECT config_json FROM spaces")) return { config_json: JSON.stringify({ productConfig: { compliance: { airGappedOnly: options.airGapped ?? false } } }) };
      if (sql.includes("FROM channel_attachments")) {
        expect(values.slice(0, 4)).toEqual(["attachment-1", "tenant-a", "space-a", "task-a"]);
        return options.owned === false ? null : { object_key: "private/key", mime_type: options.mime ?? "audio/ogg", size_bytes: 3 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    } }; } }; } },
    SCRIPTS_R2: { async get(key: string) { reads++; expect(key).toBe("private/key"); return { async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; } }; } },
    AI: ai,
  };
  return { value: value as never, reads: () => reads, ai };
}

async function post(value: never) {
  return app.request("/internal/attachments/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
    body: JSON.stringify({ tenantId: "tenant-a", spaceId: "space-a", taskId: "task-a", id: "attachment-1" }),
  }, value);
}

describe("task-scoped audio transcription route", () => {
  it("transcribes only an authorized audio attachment and returns untrusted text", async () => {
    const state = env();
    const response = await post(state.value);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ task: "transcribe", provider: "cloudflare_workers_ai", text: expect.stringContaining("recognized words") });
    expect(state.reads()).toBe(1);
    expect(state.ai.run).toHaveBeenCalledOnce();
  });

  it("does not read foreign tasks, video, or files from an air-gapped Space", async () => {
    const foreign = env({ owned: false });
    expect((await post(foreign.value)).status).toBe(404);
    expect(foreign.reads()).toBe(0);

    const video = env({ mime: "video/mp4" });
    expect((await post(video.value)).status).toBe(415);
    expect(video.reads()).toBe(0);

    const airGapped = env({ airGapped: true });
    expect((await post(airGapped.value)).status).toBe(403);
    expect(airGapped.reads()).toBe(0);
  });
});
