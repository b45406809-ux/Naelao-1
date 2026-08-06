/**
 * A QR encoder, because connecting a channel should take a phone and 60 seconds.
 *
 * Every channel we support is something the owner already has open on their phone — Telegram,
 * Slack, Discord, WhatsApp. The setup we had asked them to do the opposite: create a bot in a
 * developer console on a laptop, copy a signing secret, paste a webhook URL back. A QR turns
 * that into "point your camera at this", which is the only version a non-technical owner
 * actually completes.
 *
 * Written by hand rather than pulled in as a dependency: this runs in a Worker-adjacent bundle
 * where every kilobyte is budgeted, and the encoder is small and stable. Scope is deliberately
 * narrow — byte mode, error-correction level M, versions 1 through 10 — which covers every URL
 * we generate (up to 213 characters) and nothing else. A longer input throws rather than
 * silently truncating: a QR that encodes half a URL is worse than an error, because it looks
 * like it worked.
 *
 * Correctness is proven by round-tripping through a real decoder in the tests, not by eyeballing
 * the grid. A subtly wrong mask or ECC block layout still LOOKS like a QR code.
 *
 * Reference: ISO/IEC 18004. Terminology below matches it — codewords, blocks, format info.
 */

/** Error-correction level M: recovers ~15% damage. The usual choice for a URL — enough
 *  tolerance for a phone camera at an angle without inflating the module count. */
const ECC_LEVEL_BITS = 0b00;

/** Per version (index 0 = version 1): EC codewords per block, then the block groups. */
interface VersionSpec {
  /** Error-correction codewords in each block. */
  eccPerBlock: number;
  /** [blockCount, dataCodewordsPerBlock] for each group. Most versions have one group. */
  groups: Array<[number, number]>;
}

const VERSIONS: VersionSpec[] = [
  { eccPerBlock: 10, groups: [[1, 16]] }, // 1
  { eccPerBlock: 16, groups: [[1, 28]] }, // 2
  { eccPerBlock: 26, groups: [[1, 44]] }, // 3
  { eccPerBlock: 18, groups: [[2, 32]] }, // 4
  { eccPerBlock: 24, groups: [[2, 43]] }, // 5
  { eccPerBlock: 16, groups: [[4, 27]] }, // 6
  { eccPerBlock: 18, groups: [[4, 31]] }, // 7
  { eccPerBlock: 22, groups: [[2, 38], [2, 39]] }, // 8
  { eccPerBlock: 22, groups: [[3, 36], [2, 37]] }, // 9
  { eccPerBlock: 26, groups: [[4, 43], [1, 44]] }, // 10
];

/** Row/column centres of the alignment patterns, per version. Version 1 has none. */
const ALIGNMENT_CENTRES: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const MAX_VERSION = VERSIONS.length;

function dataCodewords(spec: VersionSpec): number {
  return spec.groups.reduce((sum, [blocks, per]) => sum + blocks * per, 0);
}

// ── GF(256) arithmetic for Reed-Solomon ──────────────────────────────────────
// The field is built once at module load; it is 512 bytes and deterministic.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR field's primitive polynomial
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/**
 * The generator polynomial for `degree` error-correction codewords: the product of (x - α^i)
 * for i in [0, degree). Coefficients are stored highest-degree first.
 *
 * The two contributions have to land the right way round. Multiplying by (x + α^i) raises every
 * term's degree by one — so the `x` half keeps a coefficient at its own index and the `α^i` half
 * pushes it one further along. Swapping them yields the REVERSED polynomial, which is still a
 * perfectly good polynomial: division by it succeeds, the remainder is self-consistent, and a
 * "the generator divides the result exactly" test passes happily while the code decodes as
 * nothing. Only comparing against a real encoder catches it.
 */
export function rsGeneratorFor(degree: number): Uint8Array {
  return rsGenerator(degree);
}

function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j]! ^ poly[j]!) & 0xff;
      next[j + 1] = (next[j + 1]! ^ gfMul(poly[j]!, GF_EXP[i]!)) & 0xff;
    }
    poly = next;
  }
  return poly;
}

/** Remainder of `data` divided by the generator — the error-correction codewords. */
export function rsEncode(data: Uint8Array, eccCount: number): Uint8Array {
  const gen = rsGenerator(eccCount);
  const remainder = new Uint8Array(eccCount);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[eccCount - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < eccCount; i++) {
        remainder[i] = (remainder[i]! ^ gfMul(gen[i + 1]!, factor)) & 0xff;
      }
    }
  }
  return remainder;
}

// ── BCH codes for the format and version information areas ───────────────────

function bch(value: number, generator: number, generatorBits: number): number {
  let d = value << (generatorBits - 1);
  while (bitLength(d) >= generatorBits) {
    d ^= generator << (bitLength(d) - generatorBits);
  }
  return d;
}

function bitLength(n: number): number {
  let len = 0;
  while (n !== 0) {
    len += 1;
    n >>>= 1;
  }
  return len;
}

/** 15-bit format information: EC level + mask, BCH-protected and masked. */
export function formatInfo(eccBits: number, mask: number): number {
  const data = (eccBits << 3) | mask;
  return (((data << 10) | bch(data, 0x537, 11)) ^ 0x5412) & 0x7fff;
}

/** 18-bit version information, present only from version 7 up. */
export function versionInfo(version: number): number {
  return ((version << 12) | bch(version, 0x1f25, 13)) & 0x3ffff;
}

// ── Encoding ─────────────────────────────────────────────────────────────────

/** How many characters fit at each version, so we can pick the smallest that works. */
function byteCapacity(version: number): number {
  const spec = VERSIONS[version - 1]!;
  const countBits = version >= 10 ? 16 : 8;
  return Math.floor((dataCodewords(spec) * 8 - 4 - countBits) / 8);
}

function chooseVersion(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (byteLength <= byteCapacity(v)) return v;
  }
  throw new Error(
    `Too long for a QR code at this size: ${byteLength} bytes, maximum ${byteCapacity(MAX_VERSION)}.`
  );
}

class BitWriter {
  private bits: number[] = [];
  write(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
  toCodewords(total: number): Uint8Array {
    // Terminator, then pad to a byte boundary, then the two alternating pad codewords.
    const capacity = total * 8;
    const terminator = Math.min(4, capacity - this.bits.length);
    for (let i = 0; i < terminator; i++) this.bits.push(0);
    while (this.bits.length % 8 !== 0) this.bits.push(0);

    const out = new Uint8Array(total);
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      out[i / 8] = byte;
    }
    for (let i = Math.ceil(this.bits.length / 8); i < total; i++) {
      out[i] = (i - Math.ceil(this.bits.length / 8)) % 2 === 0 ? 0xec : 0x11;
    }
    return out;
  }
}

/** Interleave data and error-correction codewords across blocks, as the spec requires. */
function buildCodewords(data: Uint8Array, spec: VersionSpec): Uint8Array {
  const blocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(offset, offset + size);
      offset += size;
      blocks.push(block);
      eccBlocks.push(rsEncode(block, spec.eccPerBlock));
    }
  }

  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < spec.eccPerBlock; i++) {
    for (const block of eccBlocks) out.push(block[i]!);
  }
  return new Uint8Array(out);
}

// ── Matrix construction ──────────────────────────────────────────────────────

/** -1 = free, 0 = light, 1 = dark. `reserved` marks modules the data must skip. */
interface Matrix {
  size: number;
  modules: Int8Array;
  reserved: Uint8Array;
}

function makeMatrix(size: number): Matrix {
  return { size, modules: new Int8Array(size * size).fill(-1), reserved: new Uint8Array(size * size) };
}

function set(m: Matrix, row: number, col: number, dark: boolean, reserve = true): void {
  m.modules[row * m.size + col] = dark ? 1 : 0;
  if (reserve) m.reserved[row * m.size + col] = 1;
}

function isReserved(m: Matrix, row: number, col: number): boolean {
  return m.reserved[row * m.size + col] === 1;
}

function placeFinder(m: Matrix, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= m.size || cc < 0 || cc >= m.size) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(m, rr, cc, inRing || inCore);
    }
  }
}

function placeAlignment(m: Matrix, version: number): void {
  const centres = ALIGNMENT_CENTRES[version - 1]!;
  for (const r of centres) {
    for (const c of centres) {
      // The three corners already hold finder patterns.
      const atFinder =
        (r === 6 && c === 6) || (r === 6 && c === m.size - 7) || (r === m.size - 7 && c === 6);
      if (atFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          set(m, r + dr, c + dc, ring !== 1);
        }
      }
    }
  }
}

function placeTimingAndStatics(m: Matrix, version: number): void {
  for (let i = 8; i < m.size - 8; i++) {
    set(m, 6, i, i % 2 === 0);
    set(m, i, 6, i % 2 === 0);
  }
  // The lone dark module, always just above the bottom-left finder's separator.
  set(m, m.size - 8, 8, true);

  // Reserve the format areas; the real bits go in after masking.
  for (let i = 0; i < 9; i++) {
    if (!isReserved(m, 8, i)) set(m, 8, i, false);
    if (!isReserved(m, i, 8)) set(m, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!isReserved(m, 8, m.size - 1 - i)) set(m, 8, m.size - 1 - i, false);
    if (!isReserved(m, m.size - 1 - i, 8)) set(m, m.size - 1 - i, 8, false);
  }

  if (version >= 7) {
    const info = versionInfo(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((info >>> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = (i % 3) + m.size - 11;
      set(m, r, c, bit);
      set(m, c, r, bit);
    }
  }
}

function placeData(m: Matrix, codewords: Uint8Array): void {
  let bitIndex = 0;
  let upward = true;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    const col = right <= 6 ? right - 1 : right; // column 6 is the vertical timing pattern
    for (let i = 0; i < m.size; i++) {
      const row = upward ? m.size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (isReserved(m, row, c)) continue;
        const byte = codewords[bitIndex >> 3] ?? 0;
        const bit = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
        m.modules[row * m.size + c] = bit ? 1 : 0;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m: Matrix, mask: number): Matrix {
  const out: Matrix = { size: m.size, modules: Int8Array.from(m.modules), reserved: m.reserved };
  const fn = MASKS[mask]!;
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (isReserved(m, r, c)) continue;
      if (fn(r, c)) out.modules[r * m.size + c] = out.modules[r * m.size + c] === 1 ? 0 : 1;
    }
  }
  return out;
}

/**
 * The 15 format bits, written twice so the code survives damage to one corner.
 *
 * The direction is the thing to get right and easy to get backwards: the LOW bits sit at the TOP
 * of column 8 and at the RIGHT end of row 8, running inward. Reversing it produces a format
 * string that is still a valid one — just for a different mask — so the code looks perfect and
 * decodes as nothing at all.
 */
function writeFormat(m: Matrix, mask: number): void {
  const info = formatInfo(ECC_LEVEL_BITS, mask);
  const n = m.size;
  for (let i = 0; i < 15; i++) {
    const bit = ((info >>> i) & 1) === 1;

    // Copy 1: down column 8. Row 6 is the timing pattern, hence the skip; the run resumes at the
    // bottom seven rows, which stops short of the permanently-dark module at (n-8, 8).
    if (i < 6) set(m, i, 8, bit);
    else if (i < 8) set(m, i + 1, 8, bit);
    else set(m, n - 15 + i, 8, bit);

    // Copy 2: along row 8, right to left, with the same skip for the column-6 timing pattern.
    if (i < 8) set(m, 8, n - i - 1, bit);
    else if (i === 8) set(m, 8, 7, bit);
    else set(m, 8, 14 - i, bit);
  }
}

/** The spec's four penalty rules. Lower is more scannable. */
function penalty(m: Matrix): number {
  const n = m.size;
  const at = (r: number, c: number) => m.modules[r * n + c] === 1;
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < n; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        const prev = horizontal ? at(i, j - 1) : at(j - 1, i);
        const cur = horizontal ? at(i, j) : at(j, i);
        if (cur === prev) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules on either side.
  const pattern = [true, false, true, true, true, false, true];
  const light4 = [false, false, false, false];
  const matches = (cells: boolean[], seq: boolean[], start: number) =>
    seq.every((v, k) => cells[start + k] === v);
  for (let i = 0; i < n; i++) {
    const row: boolean[] = [];
    const col: boolean[] = [];
    for (let j = 0; j < n; j++) {
      row.push(at(i, j));
      col.push(at(j, i));
    }
    for (const cells of [row, col]) {
      for (let j = 0; j + 7 <= n; j++) {
        if (!matches(cells, pattern, j)) continue;
        const before = j >= 4 && matches(cells, light4, j - 4);
        const after = j + 11 <= n && matches(cells, light4, j + 7);
        if (before || after) score += 40;
      }
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (let i = 0; i < n * n; i++) if (m.modules[i] === 1) dark += 1;
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** The finished code as a square grid of booleans, dark = true. No quiet zone. */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const spec = VERSIONS[version - 1]!;
  const size = 17 + version * 4;

  const writer = new BitWriter();
  writer.write(0b0100, 4); // byte mode
  writer.write(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) writer.write(b, 8);
  const codewords = buildCodewords(writer.toCodewords(dataCodewords(spec)), spec);

  const base = makeMatrix(size);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);
  placeAlignment(base, version);
  placeTimingAndStatics(base, version);
  placeData(base, codewords);

  // Try every mask and keep the least penalised — this is what makes it scannable, not optional.
  let best: Matrix | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(base, mask);
    writeFormat(candidate, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  const chosen = best!;
  const grid: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) row.push(chosen.modules[r * size + c] === 1);
    grid.push(row);
  }
  return grid;
}

/**
 * The code as an SVG string, sized in module units so the caller controls pixel size with CSS.
 *
 * `currentColor` for the dark modules and an explicit light background: a QR needs real contrast
 * to scan, so it must NOT go transparent-on-dark when the page theme flips. The white background
 * is deliberate, not an oversight.
 */
export function qrSvg(text: string, opts: { quietZone?: number; title?: string } = {}): string {
  const grid = encodeQr(text);
  const quiet = opts.quietZone ?? 4; // the spec's minimum; below this many scanners fail
  const size = grid.length + quiet * 2;

  let path = "";
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid.length; c++) {
      if (grid[r]![c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }

  const title = opts.title ? `<title>${opts.title.replace(/[<>&]/g, "")}</title>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `shape-rendering="crispEdges" role="img">${title}` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/></svg>`
  );
}
