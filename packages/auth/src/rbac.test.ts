import type { UserRole } from "@naelao/types";
import { describe, expect, it } from "vitest";
import { assertPermission, hasPermission } from "./rbac.js";

describe("RBAC role boundaries", () => {
  it.each([
    ["owner", "admin:all", true],
    ["admin", "admin:all", false],
    ["admin", "billing:write", false],
    ["editor", "members:write", false],
    ["viewer", "spaces:write", false],
    ["product_end_user", "spaces:read", false],
    ["agent", "spaces:read", false],
  ] as const)("role %s has permission %s: %s", (role, permission, expected) => {
    expect(hasPermission(role, permission as never)).toBe(expected);
  });

  it("fails closed for malformed runtime role and permission values", () => {
    expect(
      hasPermission("administrator" as UserRole, "admin:all" as never)
    ).toBe(false);
    expect(hasPermission("owner", "billing:root" as never)).toBe(false);
    expect(() =>
      assertPermission("administrator" as UserRole, "admin:all" as never)
    ).toThrow();
  });

  it("throws before a guarded action can run", () => {
    let actionRan = false;
    try {
      assertPermission("viewer", "spaces:delete" as never);
      actionRan = true;
    } catch {
      // A denied permission must not reach the protected action.
    }
    expect(actionRan).toBe(false);
  });
});
