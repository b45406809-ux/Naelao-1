import { describe, expect, it, vi } from "vitest";
import { interceptPlatformCli, VirtualCliDispatcher } from "./virtual-cli.js";

describe("VirtualCliDispatcher", () => {
  it("supports bounded conversation search pagination and document research chains", () => {
    expect(interceptPlatformCli('conversation search "launch decision" --limit 8 --scan-limit 400 --before-id msg-200'))
      .toEqual({ operation: "conversation.search", params: { query: "launch decision", limit: 8, scan_limit: 400, before_id: "msg-200" } });
    expect(interceptPlatformCli(`conversation research "retention window" --process extract --entities '{"duration":"retention period"}' --before-id msg-50`))
      .toEqual({ operation: "conversation.research", params: { query: "retention window", process: "extract", entities: { duration: "retention period" }, before_id: "msg-50" } });
    expect(() => interceptPlatformCli("conversation export --all")).toThrow("usage: conversation");
    expect(() => interceptPlatformCli("conversation search")).toThrow("usage: conversation");
  });

  it("routes document tasks through authorized operations without executing a shell/provider command", () => {
    expect(interceptPlatformCli("document summarize --path /workspace/report.txt --max-output-tokens 300")).toEqual({ operation: "document.summarize", params: { path: "/workspace/report.txt", maxOutputTokens: 300 } });
    expect(interceptPlatformCli(`document extract --path /workspace/report.txt --entities '{"vendor":"vendor name"}'`)).toEqual({ operation: "document.extract", params: { path: "/workspace/report.txt", entities: { vendor: "vendor name" } } });
    expect(interceptPlatformCli('knowledge brief --query "renewal date" --top-k 2')).toEqual({ operation: "knowledge.search_brief", params: { query: "renewal date", top_k: 2 } });
    expect(() => interceptPlatformCli("document classify --path /workspace/report.txt")).toThrow("usage: document");
  });
  it("routes task-scoped attachment commands to typed operations", () => {
    expect(interceptPlatformCli("attachment list")).toEqual({ operation: "attachment.list", params: {} });
    expect(interceptPlatformCli("attachment inspect a1b2")).toEqual({ operation: "attachment.inspect", params: { id: "a1b2" } });
    expect(interceptPlatformCli("attachment copy a1b2 uploads/scan.png")).toEqual({ operation: "attachment.copy", params: { id: "a1b2", path: "uploads/scan.png" } });
    expect(interceptPlatformCli("attachment read a1b2")).toEqual({ operation: "attachment.read", params: { id: "a1b2" } });
    expect(interceptPlatformCli("attachment ocr a1b2")).toEqual({ operation: "attachment.ocr", params: { id: "a1b2" } });
    expect(() => interceptPlatformCli("attachment read")).toThrow("usage: attachment");
  });
  it("parses read-only skill discovery and tool help commands without shell execution", () => {
    expect(interceptPlatformCli("skill list")).toEqual({ operation: "skill.list", params: {} });
    expect(interceptPlatformCli('skill search "invoice reconciliation"')).toEqual({ operation: "skill.search", params: { query: "invoice reconciliation" } });
    expect(interceptPlatformCli("skill read invoice-playbook")).toEqual({ operation: "skill.read", params: { name: "invoice-playbook", args: [] } });
    expect(interceptPlatformCli("tool help invoice.create")).toEqual({ operation: "tools.describe", params: { name: "invoice.create" } });
    expect(interceptPlatformCli('naelao project agents list --query "invoice reconciliation"')).toEqual({
      operation: "thread.list_project_agents", params: { query: "invoice reconciliation" },
    });
  });
  it("requests Markdown-for-agents through the scoped fetch callback and reports honest fallbacks", async () => {
    const fetchMarkdown = vi.fn(async () => ({
      url: "https://example.com/guide.md",
      status: 200,
      content: "# Guide",
      content_type: "text/markdown; charset=utf-8",
      format: "markdown",
    }));
    const cli = new VirtualCliDispatcher({ tenantId: "tenant", spaceId: "space", fetchMarkdown });
    await expect(cli.execute(["fetch-md", "https://example.com/guide.md"])).resolves.toMatchObject({ exit_code: 0, stdout: "# Guide" });
    expect(fetchMarkdown).toHaveBeenCalledWith("https://example.com/guide.md");

    const htmlCli = new VirtualCliDispatcher({ tenantId: "tenant", spaceId: "space", fetchMarkdown: vi.fn(async () => ({
      url: "https://example.com/",
      status: 200,
      content: "<h1>Example</h1>",
      content_type: "text/html",
      format: "source",
    })) });
    await expect(htmlCli.execute(["fetch-md", "https://example.com/"])).resolves.toMatchObject({
      exit_code: 0,
      stderr: expect.stringContaining("unconverted source"),
    });
  });

  it("validates fetch-md input and surfaces non-success status", async () => {
    const cli = new VirtualCliDispatcher({ tenantId: "t", spaceId: "s", fetchMarkdown: vi.fn(async () => ({ url: "https://example.com/", status: 503, content: "unavailable" })) });
    await expect(cli.execute(["fetch-md", "file:///etc/passwd"])).rejects.toThrow("usage: fetch-md");
    await expect(cli.execute(["fetch-md", "https://example.com/"])).resolves.toMatchObject({ exit_code: 1, stderr: expect.stringContaining("HTTP 503") });
  });

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
  it("routes unsupported first-party API endpoints through the scoped Vault proxy without exposing credentials", async () => {
    const fetchWithAuth = vi.fn(async () => Response.json({ id: "cus_1" }));
    const cli = new VirtualCliDispatcher({ vault: { fetchWithAuth }, tenantId: "tenant", spaceId: "space", projectId: "project" });
    await expect(cli.execute(["api", "request", "GET", "https://api.stripe.com/v1/new_endpoint", "--credential", "STRIPE_KEY", "--headers", '{"Stripe-Version":"2026-10-01"}']))
      .resolves.toMatchObject({ exit_code: 0, stdout: '{\n  "id": "cus_1"\n}' });
    expect(fetchWithAuth).toHaveBeenCalledWith("https://api.stripe.com/v1/new_endpoint", expect.objectContaining({
      credentialName: "STRIPE_KEY", method: "GET", headers: { "Stripe-Version": "2026-10-01" },
    }));
    await expect(cli.execute(["api", "request", "POST", "https://api.stripe.com/v1/new_endpoint", "--credential", "STRIPE_KEY", "--body", '{"amount":100}', "--idempotency-key", "request-1"]))
      .resolves.toMatchObject({ exit_code: 0 });
    expect(fetchWithAuth).toHaveBeenLastCalledWith("https://api.stripe.com/v1/new_endpoint", expect.objectContaining({
      credentialName: "STRIPE_KEY", method: "POST", body: { amount: 100 }, idempotencyKey: "request-1",
    }));
    await expect(cli.execute(["api", "request", "GET", "http://127.0.0.1/", "--credential", "STRIPE_KEY"]))
      .rejects.toThrow("api_https_url_required");
    await expect(cli.execute(["api", "request", "GET", "https://api.stripe.com/v1/new_endpoint", "--credential", "STRIPE_KEY", "--body", "{}"]))
      .rejects.toThrow("api_body_not_allowed_for_read");
    await expect(cli.execute(["api", "request", "POST", "https://api.stripe.com/v1/new_endpoint", "--credential", "STRIPE_KEY", "--body", "{}"]))
      .rejects.toThrow("api_idempotency_key_required");
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });
  it("maps Stripe actions to resource URLs and form-encodes writes", async () => {
    const fetchWithAuth = vi.fn(async () => Response.json({ id: "cus_1" }));
    const cli = new VirtualCliDispatcher({ vault: { fetchWithAuth }, tenantId: "tenant", spaceId: "space" });
    await cli.execute(["stripe", "customers", "list", "--limit", "5"]);
    expect(fetchWithAuth).toHaveBeenLastCalledWith("https://api.stripe.com/v1/customers?limit=5", expect.objectContaining({ method: "GET" }));

    await cli.execute(["stripe", "customers", "retrieve", "cus_123"]);
    expect(fetchWithAuth).toHaveBeenLastCalledWith("https://api.stripe.com/v1/customers/cus_123", expect.objectContaining({ method: "GET" }));

    await expect(cli.execute(["stripe", "customers", "create", "--name", "A & B", "--idempotency-key", "stripe-run-1"]))
      .resolves.toMatchObject({ exit_code: 0 });
    expect(fetchWithAuth).toHaveBeenLastCalledWith("https://api.stripe.com/v1/customers", expect.objectContaining({
      method: "POST",
      idempotencyKey: "stripe-run-1",
      body: "name=A+%26+B",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }));
    await expect(cli.execute(["stripe", "customers", "retrieve"]))
      .rejects.toThrow("stripe_resource_id_required");
    await expect(cli.execute(["stripe", "customers", "create", "--name", "Missing key"]))
      .rejects.toThrow("api_idempotency_key_required");
    expect(fetchWithAuth).toHaveBeenCalledTimes(3);
  });

  it("requires and forwards idempotency for built-in provider writes without sending it in the provider body", async () => {
    const fetchWithAuth = vi.fn(async () => Response.json({ id: "email_1" }));
    const cli = new VirtualCliDispatcher({ vault: { fetchWithAuth }, tenantId: "tenant", spaceId: "space" });
    await expect(cli.execute(["resend", "emails", "send", "--from", "sender@example.com", "--to", "customer@example.com", "--subject", "Hello", "--html", "<p>Hello</p>"]))
      .rejects.toThrow("api_idempotency_key_required");
    expect(fetchWithAuth).not.toHaveBeenCalled();

    await expect(cli.execute(["resend", "emails", "send", "--from", "sender@example.com", "--to", "customer@example.com", "--subject", "Hello", "--html", "<p>Hello</p>", "--idempotency-key", "email-run-1"]))
      .resolves.toMatchObject({ exit_code: 0 });
    expect(fetchWithAuth).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
      credentialName: "RESEND_API_KEY",
      method: "POST",
      idempotencyKey: "email-run-1",
      body: { from: "sender@example.com", to: "customer@example.com", subject: "Hello", html: "<p>Hello</p>" },
    }));
  });
  it("rejects oversized API replies while streaming", async () => {
    const fetchWithAuth = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); } })));
    const cli = new VirtualCliDispatcher({ vault: { fetchWithAuth }, tenantId: "tenant", spaceId: "space" });
    await expect(cli.execute(["stripe", "customers", "list"])).rejects.toThrow("virtual_cli_response_too_large");
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
  it("routes extension, automation, and housekeeping namespaces independently", async () => {
    const daemons = { execute: vi.fn(async () => ({ kind: "extension" })) };
    const automations = { execute: vi.fn(async () => ({ kind: "automation" })) };
    const chores = { execute: vi.fn(async () => ({ kind: "chore" })) };
    const cli = new VirtualCliDispatcher({ vault: { fetchWithAuth: vi.fn() }, tenantId: "t", spaceId: "s", daemons, automations, chores });
    await cli.execute(["ext:tree-sitter", "query", "User"]);
    await cli.execute(["auto:stripe-sync", "trigger"]);
    await cli.execute(["avos", "chore", "repomix-pack"]);
    expect(daemons.execute).toHaveBeenCalledWith("tree-sitter", ["query", "User"]);
    expect(automations.execute).toHaveBeenCalledWith("stripe-sync", ["trigger"]);
    expect(chores.execute).toHaveBeenCalledWith("repomix-pack", []);
  });
});
