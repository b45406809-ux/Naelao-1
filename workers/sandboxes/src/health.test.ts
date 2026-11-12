import { describe, expect, it } from "vitest";
import worker from "./index";

describe("Sandboxes health endpoint", () => {
  it("reports service readiness without requiring a tenant token or provider credentials", async () => {
    const response = await worker.fetch(new Request("https://sandboxes/health"), {
      ENVIRONMENT: "staging",
    } as never, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "sandboxes", env: "staging", providers: "configured_only" });
  });
});
