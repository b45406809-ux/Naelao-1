import { describe, expect, it, vi } from "vitest";
import { codeExec } from "./code-exec.js";
import type { ScriptEngineEnv } from "../types.js";
import { sha256Bytes } from "../r2-cas.js";

describe("project LSP virtual Bash integration", () => {
  it("indexes only scoped project source files through the authenticated project daemon", async () => {
    const content = new TextEncoder().encode("export interface User { id: string }");
    const fetch = vi.fn(async (request: Request) => {
      const body = await request.json() as { params: { name: string; arguments: { files: Array<{ path: string; content: string }>; replace: boolean } } };
      expect(new URL(request.url).pathname).toBe("/spaces/space/projects/project/daemons/tree-sitter/mcp");
      expect(request.headers.get("x-naelao-tenant-id")).toBe("tenant");
      expect(body.params.name).toBe("daemon_tree-sitter_index");
      expect(body.params.arguments).toMatchObject({ replace: true, files: [{ path: "src/types.ts", content: "export interface User { id: string }" }] });
      return Response.json({ result: { structuredContent: { files: 1, symbols: 1 } } });
    });
    const bucket = {
      list: async () => ({ objects: [
        { key: "spaces/space/projects/project/workspace/src/types.ts", size: content.byteLength, customMetadata: {} },
        { key: "spaces/space/projects/project/workspace/notes.txt", size: 5, customMetadata: {} },
      ], truncated: false }),
      head: async (key: string) => key.endsWith("types.ts") ? { etag: "e1", customMetadata: { sha256: await sha256Bytes(content) } } : null,
      get: async (key: string) => key.endsWith("types.ts") ? { arrayBuffer: async () => content.slice().buffer } : null,
    };
    const ctx = { env: { tenantId: "tenant", spaceId: "space", projectId: "project", platformSecret: "test-secret",
      agentsWorker: { fetch }, scriptsBucket: bucket, workspaceBucket: bucket }, run: vi.fn() } as unknown as Parameters<typeof codeExec.operations["code.execute_bash"]>[1];

    const result = await codeExec.operations["code.execute_bash"]({ commands: "lsp index" }, ctx);
    expect(result).toMatchObject({ exit_code: 0, stdout: JSON.stringify({ files: 1, symbols: 1 }, null, 2), virtual: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(ctx.run).not.toHaveBeenCalled();
  });

  it("refuses to run the indexer outside a project scope", async () => {
    const ctx = { env: { tenantId: "tenant", spaceId: "space", scriptsBucket: { list: vi.fn() } } as unknown as ScriptEngineEnv,
      run: vi.fn() } as unknown as Parameters<typeof codeExec.operations["code.execute_bash"]>[1];
    await expect(codeExec.operations["code.execute_bash"]({ commands: "lsp status" }, ctx)).rejects.toThrow("lsp_requires_project_workspace");
  });
});
