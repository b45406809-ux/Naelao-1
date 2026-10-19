import { describe, expect, it } from "vitest";
import {
  type ToolDefinition,
  ToolRegistry,
  validateToolInput,
} from "./index.js";

function toolRow(overrides: Partial<ToolDefinition> = {}) {
  return {
    id: "tool-a",
    space_id: "space-a",
    tenant_id: "tenant-a",
    name: "Lookup",
    description: "Read a record",
    input_schema: JSON.stringify({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    }),
    output_schema: null,
    tool_type: "builtin",
    config: JSON.stringify({ type: "builtin", builtin_name: "kb_search" }),
    requires_confirmation: 0,
    enabled: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function database(rows: Array<ReturnType<typeof toolRow>>): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const matching = () =>
            rows.filter(
              (row) =>
                row.id === params[0] &&
                row.tenant_id === params[1] &&
                row.space_id === params[2]
            );
          return {
            first: async () => matching()[0] ?? null,
            all: async () => ({
              results: sql.includes("space_id = ?") ? matching() : [],
            }),
            run: async () => {
              if (!sql.startsWith("DELETE")) return { meta: { changes: 0 } };
              const before = rows.length;
              const matches = new Set(matching());
              for (let index = rows.length - 1; index >= 0; index--) {
                const row = rows[index];
                if (row && matches.has(row)) rows.splice(index, 1);
              }
              return { meta: { changes: before - rows.length } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("tool runtime boundaries", () => {
  it("requires own properties and validates supported JSON primitive types", () => {
    const inherited = Object.create({ id: "inherited" }) as Record<
      string,
      unknown
    >;
    expect(validateToolInput(inherited, { required: ["id"] }).valid).toBe(
      false
    );
    expect(
      validateToolInput(
        { count: 1.5, whole: 1, enabled: "yes" },
        {
          properties: {
            count: { type: "integer" },
            whole: { type: "number" },
            enabled: { type: "boolean" },
          },
        }
      ).errors
    ).toHaveLength(2);
  });

  it("rejects additional fields, malformed schemas, cycles and oversized inputs", () => {
    expect(
      validateToolInput(
        { id: "ok", extra: true },
        {
          properties: { id: { type: "string" } },
          additionalProperties: false,
        }
      ).valid
    ).toBe(false);
    expect(
      validateToolInput({ id: "ok" }, { required: "id" as unknown as string[] })
        .valid
    ).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateToolInput(cyclic, {}).valid).toBe(false);
    expect(validateToolInput({ data: "x".repeat(1_000_001) }, {}).valid).toBe(
      false
    );
  });

  it("scopes tool reads and deletes to tenant and space", async () => {
    const registry = new ToolRegistry(database([toolRow()]));

    await expect(
      registry.getTool("tool-a", "tenant-a", "space-b")
    ).resolves.toBeNull();
    await expect(
      registry.getTool("tool-a", "tenant-b", "space-a")
    ).resolves.toBeNull();
    await expect(
      registry.getTool("tool-a", "tenant-a", "space-a")
    ).resolves.toMatchObject({
      id: "tool-a",
      config: { type: "builtin", builtin_name: "kb_search" },
    });
    await expect(
      registry.deleteTool("tool-a", "tenant-a", "space-b")
    ).resolves.toBe(false);
    await expect(
      registry.deleteTool("tool-a", "tenant-a", "space-a")
    ).resolves.toBe(true);
  });
});
