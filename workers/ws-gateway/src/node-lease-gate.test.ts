import { describe, expect, it } from "vitest";
import { blocksNodeEdit } from "./node-lease-gate";

describe("document node lease gate", () => {
  it("blocks another human's active lease and permits the owner", () => {
    const lease = { active: true, holder_type: "HUMAN", holder_id: "user-a" };
    expect(blocksNodeEdit(lease, "user-b")).toBe(true);
    expect(blocksNodeEdit(lease, "user-a")).toBe(false);
  });

  it("does not block an expired lease or an agent lease", () => {
    expect(blocksNodeEdit({ active: false, holder_type: "HUMAN", holder_id: "user-a" }, "user-b")).toBe(false);
    expect(blocksNodeEdit({ active: true, holder_type: "AGENT", holder_id: "agent-a" }, "user-b")).toBe(false);
  });
});
