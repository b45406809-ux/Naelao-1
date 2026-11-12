import { describe, expect, it } from "vitest";
import worker from "./index.js";

describe("AgentPort health endpoint", () => {
  it("reports service readiness and the configured environment without database reads", async () => {
    const response = await worker.fetch!(new Request("https://agentport/health"), {
      ENVIRONMENT: "staging",
    } as never, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", service: "AgentPort", env: "staging" });
  });
});
