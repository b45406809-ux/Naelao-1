import { describe, expect, it } from "vitest";
import { expireToolOutputs, scheduleToolOutputExpiry, TOOL_OUTPUT_EXPIRY_PREFIX, type ToolOutputExpiryIndex } from "./tool-output-expiry.js";

function fakeIndex() {
  const values = new Map<string, { value: string; metadata?: Record<string, unknown> }>();
  const index: ToolOutputExpiryIndex = {
    get: async key => values.get(key)?.value ?? null,
    put: async (key, value, options) => { values.set(key, { value, ...(options?.metadata ? { metadata: options.metadata } : {}) }); },
    delete: async key => { values.delete(key); },
    list: async ({ prefix, cursor, limit }) => {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!cursor || key > cursor)).sort().slice(0, limit);
      const allRemaining = [...values.keys()].filter(key => key.startsWith(prefix) && (!cursor || key > cursor)).sort();
      const last = keys.at(-1);
      const complete = !last || allRemaining.length <= keys.length;
      return { keys: keys.map(name => ({ name, metadata: values.get(name)?.metadata })), list_complete: complete, ...(complete || !last ? {} : { cursor: last }) };
    },
  };
  return { index, values };
}

describe("private tool-output physical expiry", () => {
  it("indexes object keys without contents and physically deletes only expired entries", async () => {
    const { index, values } = fakeIndex();
    await scheduleToolOutputExpiry(index, "private/tool-output/a/old.log", 100);
    await scheduleToolOutputExpiry(index, "private/tool-output/a/new.log", 500);
    const deleted: string[] = [];
    const result = await expireToolOutputs(index, { delete: async key => { deleted.push(String(key)); } } as never, 200);
    expect(result).toEqual({ scanned: 2, deleted: 1 });
    expect(deleted).toEqual(["private/tool-output/a/old.log"]);
    expect([...values.values()].map(value => value.metadata?.storageKey)).toContain("private/tool-output/a/new.log");
    expect([...values.keys()].every(key => key.startsWith(TOOL_OUTPUT_EXPIRY_PREFIX))).toBe(true);
  });

  it("rejects paths outside the private output namespace", async () => {
    const { index } = fakeIndex();
    await expect(scheduleToolOutputExpiry(index, "spaces/s1/workspace/log.txt", 100)).rejects.toThrow("invalid_tool_output_expiry");
  });
});
