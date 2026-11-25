import { describe, expect, it } from "vitest";
import { createSubspaceBlackboardMessage, isImmediateActiveSiblingPair, visibleSubspaceBlackboardMessages, type SubspaceBlackboardMessage, type SubspaceBlackboardRoute, type SubspaceHierarchyRow } from "./subspace-blackboard.js";

const route: SubspaceBlackboardRoute = {
  id: "route-sales-research", sourceSubspaceId: "dept-a", targetSubspaceId: "dept-b",
  allowedKinds: ["question", "blocker", "completion"], allowReply: true, status: "active",
};
const now = "2026-11-25T12:00:00.000Z";

describe("directed subspace blackboard messages", () => {
  it("accepts only active immediate children of the resolved root", () => {
    const root: SubspaceHierarchyRow = { id: "root", parentId: null, depth: 0, status: "active" };
    const sales: SubspaceHierarchyRow = { id: "dept-a", parentId: "root", depth: 1, status: "active" };
    const research: SubspaceHierarchyRow = { id: "dept-b", parentId: "root", depth: 1, status: "active" };
    const other: SubspaceHierarchyRow = { id: "other-dept", parentId: "other-root", depth: 1, status: "active" };
    expect(isImmediateActiveSiblingPair(root, sales, research)).toBe(true);
    expect(isImmediateActiveSiblingPair(root, sales, other)).toBe(false);
    expect(isImmediateActiveSiblingPair(root, sales, { ...research, status: "suspended" })).toBe(false);
    expect(isImmediateActiveSiblingPair({ ...root, depth: 1 }, sales, research)).toBe(false);
  });

  it("creates source messages and permits one linked target reply", () => {
    const question = createSubspaceBlackboardMessage({ id: "q1", kind: "question", text: "Can you verify this?" }, route, "dept-a", "sales-user", [], now);
    const reply = createSubspaceBlackboardMessage({ id: "r1", kind: "completion", text: "Verified.", replyTo: "q1" }, route, "dept-b", "research-user", [question], now);
    expect(reply).toMatchObject({ routeId: route.id, sourceSubspaceId: "dept-a", targetSubspaceId: "dept-b", senderSubspaceId: "dept-b", replyTo: "q1" });
    expect(visibleSubspaceBlackboardMessages(route, "dept-a", [question, reply])).toHaveLength(2);
    expect(visibleSubspaceBlackboardMessages(route, "dept-b", [question, reply])).toHaveLength(2);
    expect(visibleSubspaceBlackboardMessages(route, "other-dept", [question, reply])).toEqual([]);
  });

  it("denies a target's unlinked message, an unauthorized kind, and a second reply", () => {
    const question = createSubspaceBlackboardMessage({ id: "q1", kind: "question", text: "Question" }, route, "dept-a", "sales-user", [], now);
    const reply = createSubspaceBlackboardMessage({ id: "r1", kind: "completion", text: "Done", replyTo: "q1" }, route, "dept-b", "research-user", [question], now);
    expect(() => createSubspaceBlackboardMessage({ id: "free", kind: "completion", text: "Unlinked" }, route, "dept-b", "research-user", [question], now)).toThrow("direction_denied");
    expect(() => createSubspaceBlackboardMessage({ id: "bad-kind", kind: "artifact", text: "Not allowed" }, route, "dept-a", "sales-user", [], now)).toThrow("message_invalid");
    expect(() => createSubspaceBlackboardMessage({ id: "r2", kind: "completion", text: "Again", replyTo: "q1" }, route, "dept-b", "research-user", [question, reply], now)).toThrow("reply_scope_denied");
  });

  it("hides messages after route revocation and rejects stale or forged route data", () => {
    const message: SubspaceBlackboardMessage = { id: "q1", routeId: route.id, sourceSubspaceId: "dept-a", targetSubspaceId: "dept-b", senderSubspaceId: "dept-a", senderId: "sales-user", kind: "question", text: "Question", createdAt: now };
    expect(visibleSubspaceBlackboardMessages({ ...route, status: "revoked" }, "dept-b", [message])).toEqual([]);
    expect(visibleSubspaceBlackboardMessages(route, "dept-b", [{ ...message, targetSubspaceId: "other-dept" }])).toEqual([]);
  });
});
