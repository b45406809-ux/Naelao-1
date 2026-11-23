import { describe, expect, it, vi } from "vitest";
import { compileWorkflowEntrypoint } from "./workflow-compiler.js";

describe("workflow search context", () => {
  it("sends public web and published Knowledge searches through distinct durable effects", async () => {
    const { source } = await compileWorkflowEntrypoint(`
      export async function execute(step, ctx) {
        const web = await ctx.search.web("public-docs", { query: "public policy", limit: 4 });
        const knowledge = await ctx.resources.knowledge.search("published-docs", "policy",
          { query: "refund policy", publicationId: "pub_support" });
        return { web, knowledge };
      }
    `);
    const compiled = source.replace('import { WorkflowEntrypoint } from "cloudflare:workers";',
      "class WorkflowEntrypoint { constructor(env) { this.env = env; } }");
    const module = await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiled)}`);
    const web = { configured: true, provider: "exa", results: [{ url: "https://example.com/" }] };
    const knowledge = { resultJson: '{"data":[]}' };
    const effect = vi.fn().mockResolvedValueOnce({ ok: true, output: web }).mockResolvedValueOnce(knowledge);
    const entrypoint = new module.CompiledWorkflow({ CONTROL: {
      authorize: async () => ({ runId: "run" }),
      input: async () => ({}),
      effect,
      state: async () => undefined,
      finish: async () => undefined,
      putArtifact: async (_id: string, value: unknown) => value,
    } });
    const result = await entrypoint.run({ payload: { runId: "run" } }, {
      do: (_name: string, callback: () => Promise<unknown>) => callback(),
    });

    expect(effect.mock.calls).toEqual([
      ["run", "public-docs", "search", { query: "public policy", max_results: 4, snippets_only: true }],
      ["run", "published-docs", "extension.resource.knowledge", {
        requirement_id: "policy", operation: "search", input: { query: "refund policy", publicationId: "pub_support" },
      }],
    ]);
    expect(result).toEqual({ web, knowledge });
  });
});
