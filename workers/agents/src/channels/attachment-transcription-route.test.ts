import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "../index.js";

const secret = "transcription-route-secret";
function env(options: { owned?: boolean; airGapped?: boolean; mime?: string; oversizedMediaResponse?: boolean } = {}) {
  let reads = 0;
  let mediaCalls = 0;
  const ai = { run: vi.fn(async (_model: string, input?: Record<string, unknown>) => input?.task === "query" ? ({ answer: "A red truck at a loading dock." }) : ({ text: "recognized words" })) };
  const value = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare(sql: string) { return { bind(...values: unknown[]) { return { async first() {
      if (sql.includes("SELECT status,config_json FROM spaces")) return { status: "active", config_json: JSON.stringify({ productConfig: { compliance: { airGappedOnly: options.airGapped ?? false }, attachmentOcr: { enabled: true } } }) };
      if (sql.includes("SELECT config_json FROM spaces")) return { config_json: JSON.stringify({ productConfig: { compliance: { airGappedOnly: options.airGapped ?? false }, attachmentOcr: { enabled: true } } }) };
      if (sql.includes("FROM channel_attachments")) {
        expect(values.slice(0, 4)).toEqual(["attachment-1", "tenant-a", "space-a", "task-a"]);
        return options.owned === false ? null : { object_key: "private/key", mime_type: options.mime ?? "audio/ogg", size_bytes: options.mime?.startsWith("image/") ? 24 : 3 };
      }
      if (sql.includes("INSERT INTO email_attachment_ocr_usage")) return { meta: { changes: 1 } };
      throw new Error(`unexpected SQL: ${sql}`);
    }, async run() { return { meta: { changes: 1 } }; } }; } }; } },
    SCRIPTS_R2: { async get(key: string) { reads++; expect(key).toBe("private/key"); return { async arrayBuffer() {
      if (options.mime?.startsWith("image/")) { const png = new Uint8Array(24); png.set([137,80,78,71,13,10,26,10], 0); png.set([73,72,68,82], 12); png[19] = 5; png[23] = 5; return png.buffer; }
      return new Uint8Array([1, 2, 3]).buffer;
    } }; } },
    MEDIA_SANDBOX: { idFromName: (name: string) => name, get: (id: string) => ({ async fetch(request: Request) {
      mediaCalls++;
      expect(id).toBe("attachment-media:space-a:_assistant");
      expect(new URL(request.url).pathname).toBe("/media/extract-audio");
      const input = await request.json() as { tenantId: string; spaceId: string; taskId: string; videoBase64: string };
      expect(input).toMatchObject({ tenantId: "tenant-a", spaceId: "space-a", taskId: "task-a", videoBase64: "AQID" });
      if (options.oversizedMediaResponse) {
        let chunks = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks++;
            if (chunks <= 3) controller.enqueue(new Uint8Array(1024 * 1024));
            else controller.close();
          },
        }));
      }
      return Response.json({ audioBase64: btoa("OggS"), mimeType: "audio/ogg", durationLimitSeconds: 60 });
    } }) },
    AI: ai,
  };
  return { value: value as never, reads: () => reads, mediaCalls: () => mediaCalls, ai };
}

async function post(value: never) {
  return app.request("/internal/attachments/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
    body: JSON.stringify({ tenantId: "tenant-a", spaceId: "space-a", taskId: "task-a", id: "attachment-1" }),
  }, value);
}

async function describeImage(value: never, options: { owned?: boolean; question?: string } = {}) {
  return app.request("/internal/attachments/describe-image", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
    body: JSON.stringify({ tenantId: "tenant-a", spaceId: "space-a", taskId: "task-a", id: "attachment-1", question: options.question ?? "What is shown?" }),
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
    const videoResponse = await post(video.value);
    expect(videoResponse.status).toBe(200);
    expect(await videoResponse.json()).toMatchObject({ source_media: "video_audio_track", extracted_duration_limit_seconds: 60, task: "transcribe", text: expect.stringContaining("recognized words") });
    expect(video.reads()).toBe(1);
    expect(video.mediaCalls()).toBe(1);
    expect(video.ai.run).toHaveBeenCalledTimes(1);

    const airGapped = env({ airGapped: true });
    expect((await post(airGapped.value)).status).toBe(403);
    expect(airGapped.reads()).toBe(0);
  });

  it("rejects oversized media sandbox output before calling the transcription provider", async () => {
    const state = env({ mime: "video/mp4", oversizedMediaResponse: true });
    const response = await post(state.value);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error_code: "video_audio_output_limit" });
    expect(state.ai.run).not.toHaveBeenCalled();
  });

  it("answers visual questions only for an authorized image after owner and egress checks", async () => {
    const state = env({ mime: "image/png" });
    const response = await describeImage(state.value);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ task: "describe_image", width: 5, height: 5, text: expect.stringContaining("A red truck") });
    expect(state.ai.run).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ task: "query", question: expect.stringContaining("What is shown?") }), expect.any(Object));
    const foreign = env({ mime: "image/png", owned: false });
    expect((await describeImage(foreign.value)).status).toBe(404);
    expect(foreign.reads()).toBe(0);
  });
});
