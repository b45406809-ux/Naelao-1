import { describe, expect, it } from "vitest";
import { applyToolResultLimit } from "./tool-surface.js";

describe("tool result pagination bounds", () => {
  const items = Array.from({ length: 500 }, (_, id) => ({ id }));

  it.each([0, -10, 0.5])("clamps invalid page limit %s to one advancing item", (limit) => {
    const result = applyToolResultLimit({ items }, { limit, offset: 0 }) as {
      items: Array<{ id: number }>;
      _pagination: { offset: number; limit: number; next_offset: number };
    };
    expect(result.items).toEqual([{ id: 0 }]);
    expect(result._pagination).toMatchObject({ offset: 0, limit: 1, next_offset: 1 });
  });

  it("caps oversized requested pages and normalizes offsets", () => {
    const result = applyToolResultLimit({ items }, { limit: Number.MAX_VALUE, offset: -3 }) as {
      items: Array<{ id: number }>;
      _pagination: { offset: number; limit: number; has_more: boolean; next_offset: number };
    };
    expect(result.items).toHaveLength(200);
    expect(result._pagination).toMatchObject({ offset: 0, limit: 200, has_more: true, next_offset: 200 });
  });

  it("measures and truncates Unicode output by UTF-8 bytes", () => {
    const result = applyToolResultLimit({ content: "漢".repeat(6_000) }, {}) as {
      _truncated: boolean;
      _total_bytes: number;
      preview: string;
    };
    expect(result._truncated).toBe(true);
    expect(result._total_bytes).toBeGreaterThan(16_000);
    expect(new TextEncoder().encode(result.preview).byteLength).toBeLessThanOrEqual(16_000);
  });
});
