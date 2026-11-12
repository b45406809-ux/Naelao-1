import { describe, expect, it } from "vitest";
import worker from "./index";

describe("Eval health endpoint", () => {
  it("reports only its service and deployed environment", async () => {
    const response = await worker.fetch(new Request("https://eval/health"), {
      PLATFORM_SECRET: "test-secret", EVAL_LLM_KEY: "test-key", ENVIRONMENT: "staging",
    } as never, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "eval", env: "staging" });
  });
});
