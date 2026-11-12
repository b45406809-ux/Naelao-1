import { afterEach, describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { sealConnection } from "./connection-crypto.js";
import app from "./index.js";

const secret = "agent37-verification-test-secret";

async function setup(status = "configured_unverified") {
  const sealed = await sealConnection(secret, "tenant-a", "user-a", "connection-a", JSON.stringify({ apiKey: "agent37-api-secret", instanceKey: "agent37-instance-secret" }));
  const connection: Record<string, unknown> = {id:"connection-a",tenant_id:"tenant-a",owner_id:"user-a",provider:"agent37",status,
    ownership:"customer_owned",
    credential_ciphertext:sealed.ciphertext,credential_iv:sealed.iv,credential_check_status:"not_checked",credential_check_error_code:null,control_plane_verified_at:null};
  const writes: Array<{sql:string;values:unknown[]}> = [];
  const db = { prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...bound: unknown[]) { values=bound; return statement; },
      async first<T>() {
        if (!sql.includes("FROM sandbox_connections") || values[0]!==connection.id || values[1]!==connection.tenant_id || values[2]!==connection.owner_id) return null;
        return {...connection} as T;
      },
      async run() {
        writes.push({sql,values});
        if (connection.status === "revoked") return {meta:{changes:0}};
        if (sql.includes("credential_check_status='verified'")) {
          connection.credential_check_status="verified";connection.credential_check_error_code=null;connection.control_plane_verified_at=values[0];
        } else if (sql.includes("credential_check_status='failed'")) {
          connection.credential_check_status="failed";connection.credential_check_error_code=values[0];
        }
        return {meta:{changes:1}};
      },
    };
    return statement;
  }};
  const env = { PLATFORM_DB: db, PLATFORM_SECRET: secret } as never;
  const token = await mintInternalToken(secret, "tenant-a");
  const sendPath = (path:string,userId = "user-a", role = "owner") => app.fetch(new Request(`https://sandbox.test${path}`, {
    method: "POST",
    headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": userId, "x-naelao-role": role, "x-naelao-internal-token": token },
  }), env);
  const send = (userId = "user-a", role = "owner") => sendPath("/connections/connection-a/verify",userId,role);
  const getUsage = (from:string,to:string,userId="user-a",role="owner") => app.fetch(new Request(`https://sandbox.test/connections/connection-a/usage?from=${from}&to=${to}`, {
    method:"GET",headers:{"x-naelao-tenant-id":"tenant-a","x-naelao-user-id":userId,"x-naelao-role":role,"x-naelao-internal-token":token},
  }),env);
  return { connection, send, sendPath, getUsage, writes };
}

describe("Agent37 connection verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("checks control-plane credentials without claiming runtime acceptance", async () => {
    const f = await setup();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ instances: [] }));
    vi.stubGlobal("fetch", fetcher);
    const response = await f.send();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ credentialCheckStatus: "verified", runtimeCapabilitiesVerified: false, executionKeyVerified: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBeInstanceOf(URL);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.agent37.com/v1/instances?limit=1");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer agent37-api-secret");
    expect(f.connection).toMatchObject({status:"configured_unverified",credential_check_status:"verified",control_plane_verified_at:expect.any(String),credential_check_error_code:null});
  });

  it("scopes checks to the owner and records provider failure without exposing credentials", async () => {
    const f = await setup();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: "unauthorized" }, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    expect((await f.send("other-user")).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await f.send();
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("http_401");
    expect(body).not.toContain("agent37-api-secret");
    expect(body).not.toContain("agent37-instance-secret");
    expect(f.connection).toMatchObject({credential_check_status:"failed",credential_check_error_code:"http_401"});
  });

  it("does not run checks for revoked provider connections", async () => {
    const f = await setup("revoked");
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    expect((await f.send()).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not report a successful check when the connection is revoked during the provider request", async () => {
    const f = await setup();
    const fetcher = vi.fn<typeof fetch>(async () => {
      f.connection.status = "revoked";
      return Response.json({instances:[]});
    });
    vi.stubGlobal("fetch", fetcher);
    expect((await f.send()).status).toBe(409);
    expect(f.connection.credential_check_status).toBe("not_checked");
  });

  it("fetches, minimizes, and persists owner-authorized account usage without exposing model or instance data", async () => {
    const f = await setup();
    f.connection.credential_check_status = "verified";
    f.connection.control_plane_verified_at = new Date().toISOString();
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.agent37.com/v1/usage?from=2026-11-01&to=2026-11-02");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer agent37-api-secret");
      return Response.json({ from:"2026-11-01",to:"2026-11-02",total_micros:9000,
        by_integration:{compute:{cost_micros:3000,awake_minutes:4},llm:{cost_micros:6000}},
        by_model:[{model:"private-model-name",cost_micros:6000}],instances:[{id:"provider-instance-id",total_micros:9000}] });
    });
    vi.stubGlobal("fetch",fetcher);

    expect((await f.getUsage("2026-11-01","2026-11-02","user-a","editor")).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    const response=await f.getUsage("2026-11-01","2026-11-02");
    expect(response.status).toBe(200);
    const body=await response.json() as Record<string,unknown>;
    expect(body).toMatchObject({scope:"agent37_workspace_account",currency:"USD",provenance:"provider_api_observed",
      usage:{from:"2026-11-01",to:"2026-11-02",totalMicros:9000,byIntegration:[
        {kind:"compute",costMicros:3000,awakeMinutes:4},{kind:"llm",costMicros:6000},
      ]}});
    expect(JSON.stringify(body)).not.toContain("private-model-name");
    expect(JSON.stringify(body)).not.toContain("provider-instance-id");
    expect(JSON.stringify(body)).toContain("may include Agent37 activity outside Naelao computers");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.sql).toContain("sandbox_agent37_usage_snapshots");
    expect(f.writes[0]?.values).not.toContain("connection-a");
  });

  it("does not return or persist usage if the owner revokes the connection during the provider read", async () => {
    const f = await setup();
    f.connection.credential_check_status = "verified";
    f.connection.control_plane_verified_at = new Date().toISOString();
    vi.stubGlobal("fetch", vi.fn(async () => {
      f.connection.status = "revoked";
      return Response.json({ from:"2026-11-01",to:"2026-11-02",total_micros:1,by_integration:{compute:{cost_micros:1}} });
    }));

    const response = await f.getUsage("2026-11-01","2026-11-02");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({error_code:"provider_connection_revoked"});
    expect(f.writes).toHaveLength(0);
  });
});
