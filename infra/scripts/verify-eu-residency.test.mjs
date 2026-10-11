import assert from "node:assert/strict";
import test from "node:test";
import { verify } from "./verify-eu-residency.mjs";

const rows = [{ worker: "spaces", kind: "d1", resource: "eu-db", binding: "PLATFORM_DB" }];

test("accepts complete EU creation and account-control evidence", () => {
  assert.deepEqual(verify(rows, {
    resources: [{ kind: "d1", resource: "eu-db", jurisdiction: "eu", createdInJurisdiction: true, evidence: "audit://d1/eu-db" }],
    regionalServices: { enabled: true, evidence: "audit://regional-services" },
    customerMetadataBoundary: { enabled: true, evidence: "audit://cmb" },
  }), []);
});

test("fails closed when storage or account evidence is missing", () => {
  assert.deepEqual(verify(rows, { resources: [] }), [
    "spaces:PLATFORM_DB has no creation proof for d1:eu-db",
    "Regional Services is not evidenced as enabled",
    "Customer Metadata Boundary is not evidenced as enabled",
  ]);
});
