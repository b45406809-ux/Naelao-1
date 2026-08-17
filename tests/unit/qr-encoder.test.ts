/**
 * The QR encoder, proven by decoding what it produces.
 *
 * A subtly wrong mask, ECC block interleave or format-info bit still LOOKS like a QR code — it
 * just doesn't scan, which the user discovers by pointing their phone at it and getting nothing.
 * So the load-bearing test here is a round trip through a real decoder (jsqr, the same algorithm
 * a phone runs), not an eyeball of the grid.
 */

import { describe, it, expect } from "vitest";
import jsQR from "jsqr";
import qrcode from "qrcode-generator";
import { encodeQr, qrSvg, formatInfo, versionInfo, rsEncode, rsGeneratorFor } from "../../packages/ui/src/qr.js";

/**
 * Render the grid to the RGBA bitmap jsqr expects.
 *
 * SCALE matters and is not a detail: a detector locates the code by measuring finder-pattern run
 * lengths, and at one pixel per module there is nothing to measure — jsqr returns null on a
 * perfectly valid code. Rendering at 8px/module is what a phone camera actually sees. (Worth
 * remembering: this harness bug looks exactly like an encoder bug.)
 */
const PIXELS_PER_MODULE = 8;

function toBitmap(grid: boolean[][], quiet = 4) {
  const modules = grid.length + quiet * 2;
  const n = modules * PIXELS_PER_MODULE;
  const data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const gr = Math.floor(y / PIXELS_PER_MODULE) - quiet;
      const gc = Math.floor(x / PIXELS_PER_MODULE) - quiet;
      const dark = gr >= 0 && gr < grid.length && gc >= 0 && gc < grid.length && grid[gr]![gc];
      const v = dark ? 0 : 255;
      const i = (y * n + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: n, height: n };
}

function roundTrip(text: string): string | null {
  const { data, width, height } = toBitmap(encodeQr(text));
  return jsQR(data, width, height)?.data ?? null;
}

describe("encodeQr — a real decoder reads back what we encoded", () => {
  // Every one of these is a URL shape we actually generate.
  const cases: Array<[string, string]> = [
    ["a Telegram deep link", "https://t.me/naelao_bot?start=cp_8f3a2b1c9d4e5f60"],
    ["a Composio connect link", "https://connect.composio.dev/link/lk_xwDW6RUGz4Gk"],
    ["a WhatsApp click-to-chat link", "https://wa.me/15551234567?text=link%20cp_8f3a2b1c9d4e5f60"],
    [
      "a Slack OAuth install URL, which is long",
      "https://slack.com/oauth/v2/authorize?client_id=1234567890.0987654321&scope=app_mentions:read,chat:write,im:history,im:read,im:write&state=cp_8f3a2b1c9d4e5f60",
    ],
    ["a short string", "hi"],
  ];

  for (const [label, text] of cases) {
    it(`round-trips ${label}`, () => {
      expect(roundTrip(text)).toBe(text);
    });
  }

  it("round-trips at the largest size it claims to support", () => {
    // 213 characters is the documented ceiling (version 10, level M). If the block interleave for
    // the two-group versions were wrong, this is where it would show.
    const text = "https://example.com/x?v=" + "a".repeat(213 - 24);
    expect(text.length).toBe(213);
    expect(roundTrip(text)).toBe(text);
  });

  it("round-trips at every version boundary", () => {
    // Each version has its own block layout, and versions 7+ additionally carry version info.
    // Encoding one string per version exercises all of them rather than whichever happens to fit.
    for (const len of [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]) {
      const text = "x".repeat(len);
      expect(roundTrip(text), `length ${len}`).toBe(text);
    }
  });

  it("round-trips non-ASCII, which is why byte mode is the right one", () => {
    const text = "https://naelao.com/söme–päth";
    expect(roundTrip(text)).toBe(text);
  });

  it("refuses a string too long rather than silently truncating it", () => {
    // A QR that encodes half a URL is worse than an error: it looks like it worked.
    expect(() => encodeQr("x".repeat(214))).toThrow(/too long/i);
  });
});

/**
 * Read the data codeword stream out of a finished grid, the way a decoder does: work out the mask
 * from the format info, walk the zigzag skipping function patterns, unmask as you go.
 *
 * Comparing RAW grids between two encoders is the wrong test — mask selection is a free choice
 * (any of the eight is valid, the format bits say which), so two correct encoders routinely
 * disagree module for module. The codeword stream is what must match.
 */
function readCodewords(at: (r: number, c: number) => boolean, n: number): number[] {
  const masks: Array<(r: number, c: number) => boolean> = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  let format = 0;
  for (let i = 0; i < 15; i++) {
    const bit = i < 6 ? at(i, 8) : i < 8 ? at(i + 1, 8) : at(n - 15 + i, 8);
    format |= (bit ? 1 : 0) << i;
  }
  const mask = [0, 1, 2, 3, 4, 5, 6, 7].find((m) => formatInfo(0, m) === format);
  if (mask === undefined) throw new Error(`format info ${format.toString(2)} matches no level-M mask`);

  const version = (n - 17) / 4;
  const reserved = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const mark = (r: number, c: number) => {
    if (r >= 0 && r < n && c >= 0 && c < n) reserved[r]![c] = true;
  };
  for (const [br, bc] of [[0, 0], [0, n - 7], [n - 7, 0]] as Array<[number, number]>) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(br + r, bc + c);
  }
  for (let i = 0; i < n; i++) { mark(6, i); mark(i, 6); }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, n - 1 - i); mark(n - 1 - i, 8); }
  const centres = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]][version - 1]!;
  for (const cr of centres) {
    for (const cc of centres) {
      const atFinder = (cr === 6 && cc === 6) || (cr === 6 && cc === n - 7) || (cr === n - 7 && cc === 6);
      if (atFinder) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(cr + dr, cc + dc);
    }
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3);
      const c = (i % 3) + n - 11;
      mark(r, c);
      mark(c, r);
    }
  }

  const bits: number[] = [];
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    const colBase = right <= 6 ? right - 1 : right;
    for (let i = 0; i < n; i++) {
      const row = upward ? n - 1 - i : i;
      for (const c of [colBase, colBase - 1]) {
        if (reserved[row]![c]) continue;
        bits.push((at(row, c) ? 1 : 0) ^ (masks[mask]!(row, c) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    out.push(b);
  }
  return out;
}

describe("differential against a mature encoder", () => {
  it("produces the same codewords as a reference implementation", () => {
    // jsqr proves the code SCANS; this proves WHERE a regression is. When the generator polynomial
    // came out reversed, jsqr could only say "null" — it took comparing codewords against
    // qrcode-generator to localise it to the ECC tail. Worth keeping for the next subtle break.
    for (const text of ["hi", "https://t.me/naelao_bot?start=cp_8f3a2b1c9d4e5f60", "x".repeat(180)]) {
      const mine = encodeQr(text);
      const ref = qrcode(0, "M");
      ref.addData(text, "Byte");
      ref.make();
      expect(ref.getModuleCount(), text.slice(0, 20)).toBe(mine.length);
      const a = readCodewords((r, c) => mine[r]![c]!, mine.length);
      const b = readCodewords((r, c) => ref.isDark(r, c), ref.getModuleCount());
      expect(a, `codewords for ${JSON.stringify(text.slice(0, 30))}`).toEqual(b);
    }
  });
});

describe("format and version information", () => {
  it("matches the spec's published format strings", () => {
    // From ISO/IEC 18004's own table. These are the values a decoder looks for first, so a wrong
    // one makes the whole code unreadable regardless of what the data modules say.
    expect(formatInfo(0b00, 0)).toBe(0b101010000010010); // level M, mask 0
    expect(formatInfo(0b01, 0)).toBe(0b111011111000100); // level L, mask 0
    expect(formatInfo(0b00, 5)).toBe(0b100000011001110); // level M, mask 5
  });

  it("matches the spec's published version strings", () => {
    expect(versionInfo(7)).toBe(0x07c94);
    expect(versionInfo(10)).toBe(0x0a4d3);
  });
});

describe("Reed-Solomon", () => {
  it("matches the spec's published generator polynomial", () => {
    // This is the assertion that actually pins the implementation. A "the generator divides the
    // result exactly" property test looks rigorous and is not: build the generator with its two
    // terms swapped and you get the REVERSED polynomial, division by which is still division, so
    // the property holds while every code you produce is undecodable. Only a real reference value
    // catches that.
    expect([...rsGeneratorFor(10)]).toEqual([1, 216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
    expect([...rsGeneratorFor(7)]).toEqual([1, 127, 122, 154, 164, 11, 68, 117]);
  });

  it("still satisfies the divisibility property", () => {
    // Kept as a cheap check on the GF(256) arithmetic itself, now that the generator above is
    // independently pinned.
    const data = new Uint8Array([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
    const ecc = rsEncode(data, 10);
    expect(ecc.length).toBe(10);
    expect([...rsEncode(new Uint8Array([...data, ...ecc]), 10)]).toEqual(new Array(10).fill(0));
  });
});

describe("qrSvg", () => {
  it("carries a light background so it still scans on a dark page", () => {
    // A QR needs real contrast. Going transparent-on-dark with the theme is the obvious mistake
    // and produces a code that silently stops working for half the users.
    const svg = qrSvg("https://t.me/naelao_bot?start=x");
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#000"');
  });

  it("includes the quiet zone scanners need", () => {
    const grid = encodeQr("https://t.me/naelao_bot?start=x");
    const svg = qrSvg("https://t.me/naelao_bot?start=x");
    expect(svg).toContain(`viewBox="0 0 ${grid.length + 8} ${grid.length + 8}"`);
  });

  it("is a single self-contained element with no external reference", () => {
    const svg = qrSvg("https://example.com");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toContain("http://www.w3.org/1999/xlink");
    expect(svg).not.toMatch(/<image|<use/);
  });
});
