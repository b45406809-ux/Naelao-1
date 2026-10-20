import { describe, expect, it, vi } from "vitest";
import { RepositoryDO } from "./RepositoryDO.js";

describe("RepositoryDO direct request body limit", () => {
  it("rejects streamed bodies over 16 MiB before entering the serialized state gate", async () => {
    const blockConcurrencyWhile = vi.fn(
      async (callback: () => Promise<Response>) => callback()
    );
    const repository = new RepositoryDO(
      { blockConcurrencyWhile } as never,
      {} as never
    );
    const response = await repository.fetch(
      new Request("http://repository/commit", {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit)
    );
    expect(response.status).toBe(413);
    expect(blockConcurrencyWhile).not.toHaveBeenCalled();
  });
});
