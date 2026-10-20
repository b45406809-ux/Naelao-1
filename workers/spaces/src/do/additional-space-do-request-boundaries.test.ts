import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { BuilderAccountDO } from "./BuilderAccountDO.js";
import { FeatureFlagDO } from "./FeatureFlagDO.js";
import { LockDO } from "./LockDO.js";
import { MicroAppDO } from "./MicroAppDO.js";
import { ProductUserDO } from "./ProductUserDO.js";
import { SpaceTypeRegistryDO } from "./SpaceTypeRegistryDO.js";
import { TransactionCoordinatorDO } from "./TransactionCoordinatorDO.js";

const cases = [
  ["BuilderAccountDO", 256 * 1024, BuilderAccountDO],
  ["FeatureFlagDO", 1024 * 1024, FeatureFlagDO],
  ["LockDO", 16 * 1024, LockDO],
  ["MicroAppDO", 4 * 1024 * 1024, MicroAppDO],
  ["ProductUserDO", 1024 * 1024, ProductUserDO],
  ["SpaceTypeRegistryDO", 2 * 1024 * 1024, SpaceTypeRegistryDO],
  ["TransactionCoordinatorDO", 1024 * 1024, TransactionCoordinatorDO],
] as const;

describe.each(cases)(
  "%s direct request body limit",
  (name, maxBytes, DOClass) => {
    it("rejects a streamed request above its ceiling before routing", async () => {
      const storage = createDOStorage();
      const object = new DOClass({ storage } as never, {} as never);
      const response = await object.fetch(
        new Request(`http://${name}/request`, {
          method: "POST",
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(maxBytes + 1));
              controller.close();
            },
          }),
          duplex: "half",
        } as RequestInit)
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        error_code: "request_body_too_large",
      });
    });
  }
);
