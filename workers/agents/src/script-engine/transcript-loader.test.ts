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
});
