/**
 * A brand-new business must not be refused its own agents.
 *
 * Reproduced live on production: a business created seconds earlier returned
 * `402 insufficient_credits — "this business's wallet is empty — top up to keep this agent
 * running"` for every project-agent run. Every business auto-provisions an empty wallet project at
 * creation, and the gate blocked on the balance alone, so "never funded" and "spent everything"
 * were the same state. That is both a terrible first experience and the opposite of the platform's
 * own goal of taking a business from $0 with no owner money in.
 */

import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

function makeSpaceDO(): SpaceDO {
  return new SpaceDO({ storage: createDOStorage() } as never, { PLATFORM_SECRET: "test-secret" } as never);
}

async function call(stub: SpaceDO, path: string, method = "GET", body?: unknown) {
  const res = await stub.fetch(
    new Request(`http://space-do${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("wallet balance reports whether it was ever funded", () => {
  it("a freshly provisioned wallet reads zero balance AND zero credited", async () => {
    const stub = makeSpaceDO();
    const project = await call(stub, "/projects", "POST", {
      space_id: "space1", tenant_id: "tenant1", name: "Wallet", kind: "wallet", visibility: "private",
      // The provisioner's seedWallet path: a server-derived system caller, the only way a
      // feature-kind project is created without a resolvable member.
      system_caller: true,
    });
    const balance = await call(stub, `/projects/${project.json["id"]}/wallet/balance`);

    expect(balance.status).toBe(200);
    expect(balance.json["balance_cents"]).toBe(0);
    // The field the gate needs: nothing has ever gone in, so this is a starting state, not an
    // exhausted one.
    expect(balance.json["credited_cents"]).toBe(0);
  });

  it("a wallet that was funded and then spent reports the funding it received", async () => {
    const stub = makeSpaceDO();
    const project = await call(stub, "/projects", "POST", {
      space_id: "space1", tenant_id: "tenant1", name: "Wallet", kind: "wallet", visibility: "private",
      // The provisioner's seedWallet path: a server-derived system caller, the only way a
      // feature-kind project is created without a resolvable member.
      system_caller: true,
    });
    const id = project.json["id"];
    await call(stub, `/projects/${id}/wallet/credit?tenant_id=tenant1`, "POST", { cents: 500, reason: "top up" });
    await call(stub, `/projects/${id}/wallet/debit?tenant_id=tenant1`, "POST", { cents: 500, reason: "llm usage" });

    const balance = await call(stub, `/projects/${id}/wallet/balance`);
    expect(balance.json["balance_cents"]).toBe(0);
    // Genuinely depleted — money went in and is gone. This one SHOULD stop the agent.
    expect(balance.json["credited_cents"]).toBe(500);
  });

  it("counts only money in, never netting debits against it", async () => {
    const stub = makeSpaceDO();
    const project = await call(stub, "/projects", "POST", {
      space_id: "space1", tenant_id: "tenant1", name: "Wallet", kind: "wallet", visibility: "private",
      // The provisioner's seedWallet path: a server-derived system caller, the only way a
      // feature-kind project is created without a resolvable member.
      system_caller: true,
    });
    const id = project.json["id"];
    await call(stub, `/projects/${id}/wallet/credit?tenant_id=tenant1`, "POST", { cents: 1000, reason: "top up" });
    await call(stub, `/projects/${id}/wallet/debit?tenant_id=tenant1`, "POST", { cents: 250, reason: "usage" });

    const balance = await call(stub, `/projects/${id}/wallet/balance`);
    expect(balance.json["balance_cents"]).toBe(750);
    expect(balance.json["credited_cents"]).toBe(1000);
  });
});
