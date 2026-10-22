import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const matrix = readFileSync(
  fileURLToPath(new URL("../../docs/requirements-trace-matrix.md", import.meta.url)),
  "utf8"
);
const rows = matrix.split("\n").filter((line) => /^\|\s*\d+\s*\|/.test(line));

describe("requirements-to-code trace matrix", () => {
  it("contains exactly one ordered row for build-plan items 1 through 87", () => {
    expect(rows).toHaveLength(87);
    expect(rows.map((row) => Number(row.match(/^\|\s*(\d+)/)?.[1]))).toEqual(
      Array.from({ length: 87 }, (_, index) => index + 1)
    );
  });

  it("links every requirement to source, production, persistence/bindings and verification", () => {
    for (const row of rows) {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      expect(cells, row).toHaveLength(5);
      for (const cell of cells.slice(1))
        expect(cell.length, row).toBeGreaterThan(20);
      expect(cells[1], row).toMatch(/Blueprint/);
      // Column position is the persistence/binding contract; requiring a particular product
      // name here would reject valid mechanisms such as the nonce ledger or turn lock.
      expect(cells[3], row).not.toMatch(/^(none|n\/a|todo)[.!]?$/i);
      expect(cells[4], row).toMatch(/test/i);
    }
  });

  it("records the later-authority reconciliation rules", () => {
    expect(matrix).toContain("Later material wins");
    expect(matrix).toContain("workflow is orthogonal");
    expect(matrix).toContain("cannot mix");
    expect(matrix).toContain("script-first six-operation control plane");
    expect(matrix).toContain("Composio is the default managed broker");
    expect(matrix).toContain(
      "A helper, type, comment, mocked unit, or empty shell is **not** end-to-end evidence"
    );
  });
});
