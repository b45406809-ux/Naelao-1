import { describe, expect, it } from "vitest";
import { markdownSection, markdownTableOfContents, parseSkillReadOptions, skillLineWindow } from "./skill-markdown.js";

const manual = "# Guide\n\n## Alpha\nA\n### Detail\nB\n\n```md\n## Hidden\n```\n\n## Beta\nC";

describe("bounded skill manual reads", () => {
  it("parses full, outline, fuzzy-section and line-window modes strictly", () => {
    expect(parseSkillReadOptions([])).toEqual({ mode: "full" });
    expect(parseSkillReadOptions(["--headers"])).toEqual({ mode: "toc" });
    expect(parseSkillReadOptions(["--section", "alph"])).toEqual({ mode: "section", section: "alph" });
    expect(parseSkillReadOptions(["--lines", "2-8"])).toEqual({ mode: "lines", start: 2, end: 8 });
    expect(() => parseSkillReadOptions(["--toc", "--section", "Alpha"])).toThrow("usage: skill read");
    expect(() => parseSkillReadOptions(["--lines", "1-401"])).toThrow("skill_lines_invalid");
  });

  it("lists headings outside fenced code and reads only a matching heading section", () => {
    const toc = markdownTableOfContents(manual);
    expect(toc.totalHeadings).toBe(4);
    expect(toc.text).toContain("## Alpha");
    expect(toc.text).not.toContain("Hidden");
    expect(markdownSection(manual, "alph").text).toBe("## Alpha\nA\n### Detail\nB\n\n```md\n## Hidden\n```");
    expect(markdownSection(manual, "missing")).toEqual({ matches: [] });
    expect(markdownSection("## Alpha One\nA\n## Alpha Two\nB", "alpha").matches).toHaveLength(2);
  });

  it("returns bounded one-based line windows with total size", () => {
    expect(skillLineWindow("a\nb\nc", 2, 3)).toEqual({ text: "b\nc", totalLines: 3 });
  });
});
