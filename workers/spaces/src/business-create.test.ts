import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim";
import { LockDO } from "./do/LockDO.js";
import { acquireBusinessCreationLease, validateCreateOptions, type CreateBusinessOptions } from "./business-create.js";

const baseOptions: CreateBusinessOptions = {
  resellerProductSpaceId: "product-1", userId: "end-user-1", name: "New venture", spacetypeId: "launchpad",
};

function lockNamespace() {
  const objects = new Map<string, LockDO>();
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let object = objects.get(id);
      if (!object) { object = new LockDO({ storage: createDOStorage() } as never, {} as never); objects.set(id, object); }
      return { fetch: (request: Request) => object!.fetch(request) };
    },
  } as unknown as DurableObjectNamespace;
}

describe("customer business creation boundaries", () => {
  it("bounds names, identifiers, template fan-out, and config overrides", () => {
    expect(validateCreateOptions(baseOptions)).toBeNull();
    expect(validateCreateOptions({ ...baseOptions, name: "\n" })).not.toBeNull();
    expect(validateCreateOptions({ ...baseOptions, name: "x".repeat(101) })).not.toBeNull();
    expect(validateCreateOptions({ ...baseOptions, spacetypeId: "../other" })).not.toBeNull();
    expect(validateCreateOptions({ ...baseOptions, templateIds: Array.from({ length: 11 }, (_, i) => `tpl-${i}`) })).not.toBeNull();
    expect(validateCreateOptions({ ...baseOptions, templateIds: ["tpl-a", "tpl-a"] })).not.toBeNull();
    expect(validateCreateOptions({ ...baseOptions, configOverrides: { note: "x".repeat(64 * 1024) } })).not.toBeNull();
  });

  it("serializes concurrent creates for one user while isolating different users", async () => {
    const env = { PLATFORM_SECRET: "test-secret", LOCK_DO: lockNamespace() } as never;
    const first = await acquireBusinessCreationLease(env, "product-1", "user-1");
    const competing = await acquireBusinessCreationLease(env, "product-1", "user-1");
    const otherUser = await acquireBusinessCreationLease(env, "product-1", "user-2");
    expect(first.acquired).toBe(true);
    expect(competing.acquired).toBe(false);
    expect(otherUser.acquired).toBe(true);
    await first.release();
    const retry = await acquireBusinessCreationLease(env, "product-1", "user-1");
    expect(retry.acquired).toBe(true);
    await retry.release();
    await otherUser.release();
  });
});
