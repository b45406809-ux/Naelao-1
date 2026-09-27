import { describe, expect, it, vi } from "vitest";
import { VirtualCliDispatcher } from "./virtual-cli.js";

describe("VirtualCliDispatcher", () => {
  it.each([
    [["stripe", "customers", "list"], "STRIPE_KEY", "api.stripe.com"],
    [["gh", "repos", "list"], "GITHUB_TOKEN", "api.github.com"],
  ] as const)("dispatches %s through a logical vault credential", async (words, credential, host) => {
    const fetchWithAuth = vi.fn(async () => Response.json({ ok: true }));
    const cli = new VirtualCliDispatcher({ vault: { fetchWithAuth }, tenantId: "tenant", spaceId: "space", projectId: "project" });
    expect((await cli.execute([...words]))?.exit_code).toBe(0);
    expect(fetchWithAuth).toHaveBeenCalledOnce();
    expect(fetchWithAuth.mock.calls[0]![0]).toContain(host);
    expect(fetchWithAuth.mock.calls[0]![1].credentialName).toBe(credential);
  });
  it("synthesizes a durable command at the hot-mounted path", async () => {
    const files = new Map<string, string>();
    const cli = new VirtualCliDispatcher({ vault: { fetchWithAuth: vi.fn() }, tenantId: "t", spaceId: "s" }, {
      read: async (path) => files.get(path) ?? null,
      write: async (path, source) => { files.set(path, source); },
    });
    const source = "export async function run(args: string[], ctx: RuntimeContext) { return args.join(' '); }";
    await expect(cli.registerSynthesized("hello", source)).resolves.toBe("/.avos/bin/hello.ts");
    expect(files.get("/.avos/bin/hello.ts")).toBe(source);
    expect(() => VirtualCliDispatcher.validateSynthesized("bad", "export async function run(args: string[], ctx: RuntimeContext) { eval(args[0]); }")).toThrow("unsafe_synthesized_command");
  });
});
