import { describe, expect, it } from "vitest";
import { inspectMutation, signGatekeeperToken, WriteGuardViolation } from "@naelao/security";
import { executeVirtualPosix } from "./virtual-posix.js";

const options = { secret: "test-secret", resourceId: "project-1" };
describe("WriteGuard", () => {
  it.each(["DROP TABLE customers", "DELETE FROM customers", "UPDATE customers SET active=0", "TRUNCATE customers", "ALTER TABLE customers DROP COLUMN email"])("blocks destructive SQL: %s", async (sql) => {
    await expect(inspectMutation(sql, { ...options, kind: "sql" })).rejects.toBeInstanceOf(WriteGuardViolation);
  });
  it.each(["rm -rf /", "rm -fr /*", "rm --no-preserve-root -rf ~", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda"])("blocks catastrophic shell: %s", async (command) => {
    await expect(inspectMutation(command, { ...options, kind: "shell" })).rejects.toBeInstanceOf(WriteGuardViolation);
  });
  it("allows only a signed, unexpired, action/resource-bound capability", async () => {
    const token = await signGatekeeperToken({ actions: ["sql.drop"], resources: ["project-1"], exp: Date.now() + 10_000 }, options.secret);
    await expect(inspectMutation("DROP TABLE customers", { ...options, kind: "sql", token })).resolves.toBeUndefined();
    await expect(inspectMutation("TRUNCATE customers", { ...options, kind: "sql", token })).rejects.toBeInstanceOf(WriteGuardViolation);
  });
  it("gates virtual POSIX before touching storage", async () => {
    let reads = 0;
    const result = await executeVirtualPosix("rm -rf /", { read: async () => { reads++; return ""; }, list: async () => [] }, { writeGuard: { ...options } });
    expect(result.exit_code).toBe(1); expect(result.stderr).toContain("WriteGuard blocked"); expect(reads).toBe(0);
  });
});
