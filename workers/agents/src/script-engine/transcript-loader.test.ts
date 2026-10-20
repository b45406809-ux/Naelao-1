import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_MAX_BYTES,
  loadTranscriptPages,
} from "./transcript-loader.js";

describe("bounded transcript page loading", () => {
  it("treats an oversized page as unavailable before JSON parsing", async () => {
    const result = await loadTranscriptPages(() =>
      Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: {
            "content-length": String(TRANSCRIPT_MAX_BYTES + 256 * 1024 + 1),
          },
        })
      )
    );
    expect(result).toBeUndefined();
  });

  it("rejects a cursor that the transcript service could not apply", async () => {
    let calls = 0;
    const result = await loadTranscriptPages<{ id: string; content: string }>(() => {
      calls++;
      return Promise.resolve(Response.json({
        data: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, content: "x" })),
        cursor_applied: false,
      }));
    });
    expect(result).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("rejects repeated pages instead of duplicating transcript content", async () => {
    let calls = 0;
    const page = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, content: "x" }));
    const result = await loadTranscriptPages<{ id: string; content: string }>(() => {
      calls++;
      return Promise.resolve(Response.json({ data: page, cursor_applied: true }));
    });
    expect(result).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("continues after a short page explicitly marked as byte-trimmed", async () => {
    let calls = 0;
    const result = await loadTranscriptPages<{ id: string; content: string }>(() => {
      calls++;
      return Promise.resolve(calls === 1
        ? Response.json({ data: [{ id: "new-2", content: "new" }], has_more: true })
        : Response.json({ data: [{ id: "old-1", content: "old" }], cursor_applied: true, has_more: false }));
    });
    expect(result?.map((message) => message.id)).toEqual(["old-1", "new-2"]);
    expect(calls).toBe(2);
  });
});
