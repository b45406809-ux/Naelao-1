import { describe, expect, it } from "vitest";
import { foldTerminalOutput, terminalText } from "../../apps/shell/src/lib/terminal-output";

describe("terminal output presentation", () => {
  it("keeps concise output intact and folds completed logs beyond the display budget", () => {
    expect(foldTerminalOutput("ok\n")).toMatchObject({ folded: false, preview: "ok\n" });
    const large = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join("\n");
    const folded = foldTerminalOutput(large);
    expect(folded.folded).toBe(true);
    expect(folded.estimatedTokens).toBeGreaterThan(1_500);
    expect(folded.hiddenLines).toBeGreaterThan(1_800);
    expect(folded.preview).toContain("… output folded …");
    expect(folded.preview).toContain("line 1999");
  });

  it("unwraps structured stdout/stderr before rendering terminal output", () => {
    expect(terminalText(JSON.stringify({ stdout: "passed", stderr: "warning" }))).toBe("passed\nwarning");
  });
});
