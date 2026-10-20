import { describe, expect, it } from "vitest";
import { mayStartProvisioning } from "./provisioning-state.js";

describe("provisioning status gate", () => {
  it.each(["provisioning", "error"])("allows retryable status %s", (status) => {
    expect(mayStartProvisioning(status)).toBe(true);
  });

  it.each(["active", "deleted", "deleting", "suspended", "unknown", null, undefined])(
    "does not restart a space in %s state",
    (status) => expect(mayStartProvisioning(status)).toBe(false),
  );
});
