import { describe, expect, it } from "vitest";
import { consumeEphemeralActionGrant, mintEphemeralActionGrant } from "./ephemeral-grant.js";
import { EgressDlpBlockError, scanAndScrubEgress } from "./dlp.js";

describe("egress DLP", () => {
  it("redacts only Luhn-valid PANs, SSNs, and private keys", () => {
    const result = scanAndScrubEgress({ pan: "4111 1111 1111 1111", invalid: "4111 1111 1111 1112", ssn: "123-45-6789", key: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----" });
    expect(result.payload).toEqual({ pan: "[REDACTED_CREDIT_CARD]", invalid: "4111 1111 1111 1112", ssn: "[REDACTED_SSN]", key: "[REDACTED_PRIVATE_KEY]" });
    expect(JSON.stringify(result.audit)).not.toContain("4111");
    expect(() => scanAndScrubEgress("123-45-6789", "block")).toThrow(EgressDlpBlockError);
  });
});

describe("ephemeral action grants", () => {
  it("binds params, expires at 15 seconds, and consumes once", async () => {
    const now = 1_000_000;
    const grant = await mintEphemeralActionGrant("calendar.create", { title: "Meet" }, "secret", now);
    const used = new Set<string>();
    const store = { exec: (_sql: string, nonce: unknown) => { if (used.has(String(nonce))) throw new Error("unique"); used.add(String(nonce)); } };
    await expect(consumeEphemeralActionGrant(store, grant, "calendar.create", { title: "Meet" }, "secret", now + 14_999)).resolves.toBe(true);
    await expect(consumeEphemeralActionGrant(store, grant, "calendar.create", { title: "Meet" }, "secret", now + 14_999)).resolves.toBe(false);
    const expired = await mintEphemeralActionGrant("calendar.create", {}, "secret", now);
    await expect(consumeEphemeralActionGrant(store, expired, "calendar.create", {}, "secret", now + 16_000)).resolves.toBe(false);
  });
});
