import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim.js";
import { ConformanceSandboxDO } from "./conformance-state.js";

describe("ConformanceSandboxDO boundary handling", () => {
  it("returns client errors for malformed JSON and oversized fixtures", async () => {
    const sandbox = new ConformanceSandboxDO({ storage: createDOStorage() } as never, {} as never);
    expect((await sandbox.fetch(new Request("http://sandbox/prepare", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await sandbox.fetch(new Request("http://sandbox/prepare", { method: "POST", body: "x".repeat(524_289) }))).status).toBe(413);
  });

  it("does not seal the oracle after a rejected assertion and rejects duplicate preparation cleanly", async () => {
    const sandbox = new ConformanceSandboxDO({ storage: createDOStorage() } as never, {} as never);
    const post = (path: string, body: unknown) => sandbox.fetch(new Request(`http://sandbox${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    const seed = { schema: ["CREATE TABLE records (value TEXT)"], statements: [], files: {} };
    expect((await post("/prepare", seed)).status).toBe(200);
    expect(await (await post("/prepare", seed)).json()).toMatchObject({ error: "fixture_already_prepared" });
    expect((await post("/assert", { assertions: [{ sql: "DELETE FROM records", args: [] }] })).status).toBe(400);
    expect((await post("/sql", { sql: "INSERT INTO records(value) VALUES (?)", args: ["still-open"] })).status).toBe(200);
    const result = await post("/assert", { assertions: [{ sql: "SELECT value FROM records", args: [] }] });
    expect(await result.json()).toMatchObject({ rows: [[{ value: "still-open" }]] });
  });
});
