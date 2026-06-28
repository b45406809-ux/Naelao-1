import { describe, it, expect } from "vitest";
import {
  nextToolState,
  canDeploy,
  isStuck,
  type ToolState,
} from "../../workers/agents/src/whop/tool-lifecycle.js";

// The micro-tool lifecycle exists to enforce one property: nothing deploys to
// paying customers unless build+test passed first (§02 "the tool must actually work").

describe("nextToolState — happy path", () => {
  it("walks draft → building → tested → deploying → live", () => {
    expect(nextToolState("draft", "start_build")).toBe("building");
    expect(nextToolState("building", "build_passed")).toBe("tested");
    expect(nextToolState("tested", "start_deploy")).toBe("deploying");
    expect(nextToolState("deploying", "deploy_succeeded")).toBe("live");
  });
});

describe("nextToolState — the §02 deploy gate", () => {
  it("cannot deploy from any state except tested (or a retryable deploy_failed)", () => {
    const cannot: ToolState[] = ["draft", "building", "build_failed", "live"];
    for (const s of cannot) {
      expect(nextToolState(s, "start_deploy"), `must not deploy from ${s}`).toBeNull();
    }
    expect(nextToolState("tested", "start_deploy")).toBe("deploying");
    expect(nextToolState("deploy_failed", "start_deploy")).toBe("deploying"); // retry a tested build
  });

  it("a failed build cannot be deployed", () => {
    expect(nextToolState("building", "build_failed")).toBe("build_failed");
    expect(nextToolState("build_failed", "start_deploy")).toBeNull();
  });
});

describe("nextToolState — illegal transitions return null", () => {
  it("rejects nonsense events", () => {
    expect(nextToolState("draft", "deploy_succeeded")).toBeNull();
    expect(nextToolState("tested", "build_passed")).toBeNull();
    expect(nextToolState("live", "start_build")).toBeNull();
  });
});

describe("revise resets to draft from any settled state", () => {
  it("supersedes build_failed, tested, live, deploy_failed", () => {
    for (const s of ["build_failed", "tested", "live", "deploy_failed"] as ToolState[]) {
      expect(nextToolState(s, "revise")).toBe("draft");
    }
  });
});

describe("canDeploy / isStuck", () => {
  it("canDeploy is true only for tested", () => {
    expect(canDeploy("tested")).toBe(true);
    for (const s of ["draft", "building", "build_failed", "deploying", "live", "deploy_failed"] as ToolState[]) {
      expect(canDeploy(s)).toBe(false);
    }
  });

  it("isStuck flags failure states needing a human/revision", () => {
    expect(isStuck("build_failed")).toBe(true);
    expect(isStuck("deploy_failed")).toBe(true);
    expect(isStuck("building")).toBe(false);
    expect(isStuck("live")).toBe(false);
  });
});
