import { describe, expect, it } from "vitest";
import { readBoundedBrowserScreenshot } from "./browser-perception.js";

describe("browser screenshot byte bounds", () => {
  it("reads a bounded image response", async () => {
    const response = new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    await expect(readBoundedBrowserScreenshot(response)).resolves.toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    );
  });

  it("rejects streamed overflow without relying on Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        controller.close();
      },
    });

    await expect(
      readBoundedBrowserScreenshot(new Response(body))
    ).rejects.toThrow("browser_screenshot_limit");
  });
});
