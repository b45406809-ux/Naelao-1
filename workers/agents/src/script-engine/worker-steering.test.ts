import { describe, it, expect } from "vitest";
import { mintInternalToken } from "@naelao/http";
import {
  parseSteering,
  receiveSteering,
  drainSteering,
  type SteeringScope,
} from "./worker-steering.js";
const secret = "secret";
function storage(scope: SteeringScope) {
  const map = new Map<string, unknown>([["worker:scope", scope]]);
  return {
    map,
    get: async <T>(k: string) => map.get(k) as T | undefined,
    put: async <T>(k: string, v: T) => {
      map.set(k, v);
    },
  };
}
async function request(extra: Record<string, unknown> = {}) {
  return new Request("http://worker/internal/steering", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant",
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant"),
    },
    body: JSON.stringify({
      spaceId: "space",
      actorId: "user",
      workerId: "worker",
      commandId: "command",
      action: "instruct",
      instruction: "Only optimize thumbnails",
      ...extra,
    }),
  });
}
describe("scoped cooperative worker steering", () => {
  it.each([undefined, "project"])(
    "delivers once and acknowledges at a boundary in scope %s",
    async (project) => {
      const s = storage({
        tenantId: "tenant",
        spaceId: "space",
        actorId: "user",
        workerId: "worker",
        ...(project ? { projectId: project } : {}),
      });
      const payload = { ...(project ? { projectId: project } : {}) };
      expect(
        await (await receiveSteering(await request(payload), secret, s)).json()
      ).toMatchObject({ status: "requested" });
      expect(await drainSteering(s)).toEqual(["Only optimize thumbnails"]);
      expect(
        await (await receiveSteering(await request(payload), secret, s)).json()
      ).toMatchObject({ status: "applied" });
      expect(await drainSteering(s)).toEqual([]);
    }
  );
  it("rejects scope changes and reuse of an operation ID for different instructions", async () => {
    const s = storage({
      tenantId: "tenant",
      spaceId: "space",
      actorId: "user",
      workerId: "worker",
    });
    expect(
      (await receiveSteering(await request({ actorId: "other" }), secret, s))
        .status
    ).toBe(403);
    expect(
      (await receiveSteering(await request({ projectId: "other" }), secret, s))
        .status
    ).toBe(403);
    await receiveSteering(await request(), secret, s);
    expect(
      (
        await receiveSteering(
          await request({ instruction: "Delete everything" }),
          secret,
          s
        )
      ).status
    ).toBe(409);
  });
  it("pauses/resumes the same session without terminating an in-flight action", async () => {
    const s = storage({
      tenantId: "tenant",
      spaceId: "space",
      actorId: "user",
      workerId: "worker",
    });
    await receiveSteering(await request({ action: "pause" }), secret, s);
    expect(s.map.get("worker:paused")).toBeUndefined();
    await drainSteering(s);
    expect(s.map.get("worker:paused")).toBe(true);
    await receiveSteering(
      await request({ commandId: "resume", action: "resume" }),
      secret,
      s
    );
    await drainSteering(s);
    expect(s.map.get("worker:paused")).toBe(false);
  });
  it("bounds queued changes and validates missing IDs", async () => {
    const s = storage({
      tenantId: "tenant",
      spaceId: "space",
      actorId: "user",
      workerId: "worker",
    });
    for (let n = 0; n < 16; n++)
      expect(
        (
          await receiveSteering(
            await request({ commandId: "c" + n }),
            secret,
            s
          )
        ).status
      ).toBe(200);
    expect(
      (
        await receiveSteering(
          await request({ commandId: "overflow" }),
          secret,
          s
        )
      ).status
    ).toBe(429);
    expect(() => parseSteering({ action: "pause" })).toThrow(
      "invalid_worker_steering"
    );
  });
});
