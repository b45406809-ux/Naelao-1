import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { restartLocalWorkers, retrieveSeededSpace, seedSpace } from "./support/runtime";

describe("Step 01 local baseline", () => {
  it("runs a cross-platform preflight and reports optional live dependencies", () => {
    const output = execFileSync(process.execPath, ["infra/scripts/plan-preflight.mjs"], { cwd: new URL("../..", import.meta.url), encoding: "utf8" });
    expect(output).toContain("Naelao plan preflight");
    expect(output).toMatch(/PASS|WARN|LIVE_REQUIRED/);
    expect(output).toContain("service:shell");
  });

  it("seeds a disposable space and retrieves the same state after a restart probe", async () => {
    const seeded = await seedSpace();
    await restartLocalWorkers();
    await expect(retrieveSeededSpace()).resolves.toEqual(seeded);
  });
});
