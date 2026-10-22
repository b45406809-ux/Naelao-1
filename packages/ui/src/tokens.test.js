import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  if (!block) throw new Error(`Missing CSS token block: ${selector}`);
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]),
  );
}

function contrastRatio(foreground, background) {
  const luminance = (color) => {
    const channels = color.match(/[\da-f]{2}/gi)?.map((channel) => parseInt(channel, 16) / 255);
    if (!channels || channels.length !== 3) throw new Error(`Expected a six-digit hex color: ${color}`);
    const linear = channels.map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("theme secondary text contrast", () => {
  it.each([":root", '[data-theme="dark"]', ':root:not([data-theme="light"])'])(
    "keeps --text3 readable in %s",
    (selector) => {
      const base = declarations(":root");
      const theme = selector === ":root" ? base : { ...base, ...declarations(selector) };
      for (const background of [theme["--bg"], theme["--surface"]]) {
        expect(contrastRatio(theme["--text3"], background)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});
