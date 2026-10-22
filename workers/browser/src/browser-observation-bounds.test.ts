import { describe, expect, it } from "vitest";
import { boundedValues, collectBoundedFrameIds, type BrowserFrameTreeNode } from "./browser-observation-bounds.js";

describe("browser observation traversal bounds", () => {
  it("caps returned frame ids and avoids walking an unbounded sibling list", () => {
    const root: BrowserFrameTreeNode = {
      frame: { id: "root" },
      childFrames: Array.from({ length: 50_000 }, (_, index) => ({ frame: { id: `child-${index}` } })),
    };
    expect(collectBoundedFrameIds(root)).toHaveLength(16);
  });

  it("uses an explicit visit ceiling for deeply nested frames", () => {
    let root: BrowserFrameTreeNode = { frame: { id: "frame-0" } };
    let current = root;
    for (let index = 1; index < 10_000; index++) {
      const child: BrowserFrameTreeNode = { frame: { id: `frame-${index}` } };
      current.childFrames = [child];
      current = child;
    }
    expect(collectBoundedFrameIds(root, 1_000, 32)).toHaveLength(32);
  });

  it("reads only the configured prefix of a huge accessibility tree", () => {
    let reads = 0;
    const nodes = new Proxy({ length: 1_000_000 }, {
      get(target, key) {
        if (key === "length") return target.length;
        reads++;
        return reads;
      },
    }) as unknown as readonly number[];
    expect([...boundedValues(nodes, 2048)]).toHaveLength(2048);
    expect(reads).toBe(2048);
  });
});
