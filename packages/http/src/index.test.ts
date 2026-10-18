import { describe, expect, it } from "vitest";
import * as http from "./index.js";

describe("public HTTP package exports", () => {
  it("exports the package's shared route, auth, storage, and realtime helpers", () => {
    for (const name of [
      "errorResponse",
      "requestId",
      "cors",
      "safeKvPut",
      "safeKvGet",
      "broadcastSpaceEvent",
      "readDeskSession",
      "verifyInternalToken",
      "verifyLocalTunnelToken",
      "jwtAuth",
      "requireInternalHmac",
    ]) {
      expect(http).toHaveProperty(name);
    }
  });
});
