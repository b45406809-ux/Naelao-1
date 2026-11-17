import { describe, expect, it } from "vitest";
import { signHmac } from "@naelao/crypto";
import { MicroAppDO } from "./MicroAppDO.js";

const cursor = <T>(rows: T[] = []) => ({
  toArray: () => rows,
  one: () => rows[0],
  raw: function* () { for (const row of rows) yield row; },
  [Symbol.iterator]: function* () { for (const row of rows) yield row; },
});

async function previewAndPublish(instance: MicroAppDO, actorId: string, draft: unknown) {
  const reviewed = await instance.fetch(new Request("https://do/page/review", {
    method: "POST", body: JSON.stringify({ actor_id: actorId, draft }),
  }));
  if (!reviewed.ok) return { reviewed, published: reviewed, reviewId: "" };
  const receipt = await reviewed.json() as { review_id: string };
  const published = await instance.fetch(new Request("https://do/page/publish-reviewed", {
    method: "POST", body: JSON.stringify({ actor_id: actorId, review_id: receipt.review_id, draft }),
  }));
  return { reviewed, published, reviewId: receipt.review_id };
}

describe("isolated public dynamic pages", () => {
  it("unpublishes the exact page and makes public rendering return not found", async () => {
    const pages = new Map<string, { html: string; actions_json: string }>();
    const reviews = new Map<string, { actor_id: string; slug: string; artifact_sha256: string; expires_at: number }>();
    const sql = { exec(query: string, ...args: unknown[]) {
      if (query.startsWith("INSERT INTO public_page_review_receipts")) reviews.set(String(args[0]), { actor_id: String(args[1]), slug: String(args[2]), artifact_sha256: String(args[3]), expires_at: Number(args[4]) });
      if (query.startsWith("SELECT actor_id,slug,artifact_sha256,expires_at FROM public_page_review_receipts")) {
        const receipt = reviews.get(String(args[0])); return cursor(receipt ? [receipt] : []);
      }
      if (query.startsWith("DELETE FROM public_page_review_receipts WHERE review_id=")) reviews.delete(String(args[0]));
      if (query.startsWith("INSERT INTO gadget_public_pages")) {
        pages.set(String(args[0]), { html: String(args[1]), actions_json: String(args[2]) });
        return { ...cursor(), rowsWritten: 1 };
      }
      if (query.startsWith("DELETE FROM gadget_public_pages")) {
        const removed = pages.delete(String(args[0]));
        return { ...cursor(), rowsWritten: removed ? 1 : 0 };
      }
      if (query.includes("SELECT html,actions_json FROM gadget_public_pages")) {
        const page = pages.get(String(args[0])); return cursor(page ? [page] : []);
      }
      return cursor();
    } };
    const instance = new MicroAppDO({ storage: { sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: "test-secret" });
    const draft = {
      slug: "spring-signup", html: "<form>{{NAELAO_ACTION_TOKEN:submit}}</form>", actions: { submit: { key: "signup", fields: ["email"] } },
    };
    const reviewed = await instance.fetch(new Request("https://do/page/review", { method: "POST",
      body: JSON.stringify({ actor_id: "owner-a", draft }) }));
    expect(reviewed.status).toBe(200);
    const reviewId = (await reviewed.json() as { review_id: string }).review_id;
    const mismatched = await instance.fetch(new Request("https://do/page/publish-reviewed", { method: "POST",
      body: JSON.stringify({ actor_id: "owner-a", review_id: reviewId, draft: { ...draft, html: "<main>{{NAELAO_ACTION_TOKEN:submit}}</main>" } }) }));
    expect(mismatched.status).toBe(409);
    const published = await instance.fetch(new Request("https://do/page/publish-reviewed", { method: "POST",
      body: JSON.stringify({ actor_id: "owner-a", review_id: reviewId, draft }) }));
    expect(published.status).toBe(201);
    const replay = await instance.fetch(new Request("https://do/page/publish-reviewed", { method: "POST",
      body: JSON.stringify({ actor_id: "owner-a", review_id: reviewId, draft }) }));
    expect(replay.status).toBe(409);
    const takenDown = await instance.fetch(new Request("https://do/page/unpublish?slug=spring-signup", { method: "DELETE" }));
    expect(await takenDown.json()).toEqual({ unpublished: true, removed: true, slug: "spring-signup" });
    expect((await instance.fetch(new Request("https://do/page/render?spaceId=s&slug=spring-signup"))).status).toBe(404);
  });

  it("limits public actions per client and page using only the HMAC client key", async () => {
    const metadata = new Map<string, string>();
    const pages = new Map<string, { html: string; actions_json: string }>();
    const rateCounts = new Map<string, number>();
    const reviews = new Map<string, { actor_id: string; slug: string; artifact_sha256: string; expires_at: number }>();
    const consumed = new Set<string>();
    const sql = { exec(query: string, ...args: unknown[]) {
      if (query.startsWith("INSERT OR REPLACE INTO gadget_metadata") && args.length === 5) {
        ["app_id", "scope", "gadget_tier", "html", "html_sha256"].forEach((key, index) => metadata.set(key, String(args[index])));
      }
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = 'app_id'")) return cursor(metadata.has("app_id") ? [{ value: metadata.get("app_id")! }] : []);
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = ?")) return cursor(metadata.has(String(args[0])) ? [{ value: metadata.get(String(args[0]))! }] : []);
      if (query.startsWith("INSERT INTO gadget_public_pages")) pages.set(String(args[0]), { html: String(args[1]), actions_json: String(args[2]) });
      if (query.startsWith("INSERT INTO public_page_review_receipts")) reviews.set(String(args[0]), { actor_id: String(args[1]), slug: String(args[2]), artifact_sha256: String(args[3]), expires_at: Number(args[4]) });
      if (query.startsWith("SELECT actor_id,slug,artifact_sha256,expires_at FROM public_page_review_receipts")) {
        const receipt = reviews.get(String(args[0])); return cursor(receipt ? [receipt] : []);
      }
      if (query.startsWith("DELETE FROM public_page_review_receipts WHERE review_id=")) reviews.delete(String(args[0]));
      if (query.includes("SELECT html,actions_json FROM gadget_public_pages")) {
        const page = pages.get(String(args[0])); return cursor(page ? [page] : []);
      }
      if (query.includes("SELECT actions_json FROM gadget_public_pages")) {
        const page = pages.get(String(args[0])); return cursor(page ? [{ actions_json: page.actions_json }] : []);
      }
      if (query.startsWith("SELECT request_count FROM public_page_action_rate_buckets")) {
        const key = `${String(args[0])}:${String(args[1])}`; return cursor(rateCounts.has(key) ? [{ request_count: rateCounts.get(key)! }] : []);
      }
      if (query.startsWith("INSERT INTO public_page_action_rate_buckets")) {
        const key = `${String(args[0])}:${String(args[1])}`; rateCounts.set(key, (rateCounts.get(key) ?? 0) + 1);
      }
      if (query.startsWith("INSERT INTO consumed_public_action_nonces")) {
        const nonce = String(args[0]); if (consumed.has(nonce)) throw new Error("unique constraint"); consumed.add(nonce);
      }
      return cursor();
    } };
    const instance = new MicroAppDO({ storage: { sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: "test-secret" });
    expect((await instance.fetch(new Request("https://do/initialize", { method: "POST", body: JSON.stringify({ appId: "rate_limit", scope: "SPACE_SHARED", gadgetTier: 3 }) }))).status).toBe(201);
    expect((await previewAndPublish(instance, "owner-a", {
      slug: "signup", html: "<form><input name='email'><input type='hidden' value='{{NAELAO_ACTION_TOKEN:submit}}'></form>", actions: { submit: { key: "signup", fields: ["email"] } },
    })).published.status).toBe(201);
    for (let i = 0; i < 31; i++) {
      const page = await instance.fetch(new Request("https://do/page/render?spaceId=s&slug=signup"));
      const token = (await page.text()).match(/value='([^']+)'/)?.[1];
      const response = await instance.fetch(new Request("https://do/page/action?spaceId=s&slug=signup&action=submit", {
        method: "POST", headers: { "x-naelao-page-client": "b".repeat(64) }, body: JSON.stringify({ token, payload: { email: `person${i}@example.test` } }),
      }));
      expect(response.status).toBe(i < 30 ? 202 : 429);
    }
  });

  it("verifies the stored Canvas artifact before serving it", async () => {
    const metadata = new Map<string, string>();
    const sql = { exec(query: string, ...args: unknown[]) {
      if (query.startsWith("INSERT OR REPLACE INTO gadget_metadata") && args.length === 5) {
        ["app_id", "scope", "gadget_tier", "html", "html_sha256"].forEach((key, index) => metadata.set(key, String(args[index])));
      }
      if (query.includes("VALUES('release_proof',?)")) metadata.set("release_proof", String(args[0]));
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = 'html'")) return cursor(metadata.has("html") ? [{ value: metadata.get("html")! }] : []);
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = ?")) return cursor(metadata.has(String(args[0])) ? [{ value: metadata.get(String(args[0]))! }] : []);
      return cursor();
    } };
    const instance = new MicroAppDO({ storage: { sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: "test-secret" });
    await instance.fetch(new Request("https://do/initialize", { method: "POST", body: JSON.stringify({ appId: "canvas", scope: "PROJECT_BOUND", gadgetTier: 3, html: "<main>trusted</main>" }) }));
    expect((await instance.fetch(new Request("https://do/app"))).status).toBe(200);
    metadata.set("html", "<main>changed</main>");
    expect((await instance.fetch(new Request("https://do/app"))).status).toBe(503);
  });

  it("binds a project Canvas artifact to its host-attested package release on initialize and render", async () => {
    const metadata = new Map<string, string>();
    const sql = { exec(query: string, ...args: unknown[]) {
      if (query.startsWith("INSERT OR REPLACE INTO gadget_metadata") && args.length === 5) {
        ["app_id", "scope", "gadget_tier", "html", "html_sha256"].forEach((key, index) => metadata.set(key, String(args[index])));
      }
      if (query.includes("VALUES('release_proof',?)")) metadata.set("release_proof", String(args[0]));
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = 'html'")) return cursor(metadata.has("html") ? [{ value: metadata.get("html")! }] : []);
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = ?")) return cursor(metadata.has(String(args[0])) ? [{ value: metadata.get(String(args[0]))! }] : []);
      return cursor();
    } };
    const secret = "canvas-release-test-secret", extensionId = "ext_course_canvas", version = "1.0.0", path = "./index.html";
    const manifestJson = JSON.stringify({ id: extensionId, bundle: { id: extensionId, version, primitives: [{ kind: "canvas", component: path }] } });
    const html = "<main>signed package canvas</main>";
    const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const artifactSha256 = "a".repeat(64), canvasSha256 = await hash(html);
    const hostSignature = await signHmac(JSON.stringify([extensionId, version, manifestJson, artifactSha256]), secret);
    const bindingPayload = JSON.stringify([extensionId, version, manifestJson, artifactSha256, hostSignature, path, canvasSha256]);
    const releaseProof = { extensionId, version, manifestJson, artifactSha256, hostSignature, canvasPath: path, canvasSha256, bindingSignature: await signHmac(bindingPayload, secret) };
    const instance = new MicroAppDO({ storage: { sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: secret });
    const initialized = await instance.fetch(new Request("https://do/initialize", { method: "POST", body: JSON.stringify({ appId: "course_canvas", scope: "PROJECT_BOUND", gadgetTier: 3, html, releaseProof }) }));
    expect(initialized.status).toBe(201);
    expect((await instance.fetch(new Request("https://do/app"))).status).toBe(200);
    const directOverwrite = await instance.fetch(new Request("https://do/initialize", { method: "POST", body: JSON.stringify({ appId: "course_canvas", scope: "PROJECT_BOUND", gadgetTier: 3, html: "<main>overwrite</main>" }) }));
    expect(directOverwrite.status).toBe(409);
    const tampered = { ...releaseProof, canvasSha256: await hash("<main>tampered</main>") };
    metadata.set("release_proof", JSON.stringify(tampered));
    expect((await instance.fetch(new Request("https://do/app"))).status).toBe(503);
  });

  it("renders single-use signed actions and rejects replay or fields outside the published contract", async () => {
    const metadata = new Map<string, string>();
    const pages = new Map<string, { html: string; actions_json: string }>();
    const reviews = new Map<string, { actor_id: string; slug: string; artifact_sha256: string; expires_at: number }>();
    const data = new Map<string, string>();
    const consumed = new Set<string>();
    const sql = { exec(query: string, ...args: unknown[]) {
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = 'app_id'")) {
        const value = metadata.get("app_id"); return cursor(value ? [{ value }] : []);
      }
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = ?")) {
        const value = metadata.get(String(args[0])); return cursor(value ? [{ value }] : []);
      }
      if (query.startsWith("INSERT OR REPLACE INTO gadget_metadata") && args.length === 5) {
        metadata.set("app_id", String(args[0])); metadata.set("scope", String(args[1])); metadata.set("gadget_tier", String(args[2])); metadata.set("html", String(args[3])); metadata.set("html_sha256", String(args[4]));
      }
      if (query.startsWith("INSERT INTO gadget_public_pages")) pages.set(String(args[0]), { html: String(args[1]), actions_json: String(args[2]) });
      if (query.startsWith("INSERT INTO public_page_review_receipts")) reviews.set(String(args[0]), { actor_id: String(args[1]), slug: String(args[2]), artifact_sha256: String(args[3]), expires_at: Number(args[4]) });
      if (query.startsWith("SELECT actor_id,slug,artifact_sha256,expires_at FROM public_page_review_receipts")) {
        const receipt = reviews.get(String(args[0])); return cursor(receipt ? [receipt] : []);
      }
      if (query.startsWith("DELETE FROM public_page_review_receipts WHERE review_id=")) reviews.delete(String(args[0]));
      if (query.includes("SELECT html,actions_json FROM gadget_public_pages")) {
        const page = pages.get(String(args[0])); return cursor(page ? [page] : []);
      }
      if (query.includes("SELECT actions_json FROM gadget_public_pages")) {
        const page = pages.get(String(args[0])); return cursor(page ? [{ actions_json: page.actions_json }] : []);
      }
      if (query.startsWith("INSERT INTO consumed_public_action_nonces")) {
        const nonce = String(args[0]); if (consumed.has(nonce)) throw new Error("unique constraint"); consumed.add(nonce);
      }
      if (query.startsWith("INSERT INTO gadget_data")) data.set(String(args[0]), String(args[1]));
      return cursor();
    } };
    const instance = new MicroAppDO({ storage: { sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: "test-secret" });
    expect((await instance.fetch(new Request("https://do/initialize", { method: "POST", body: JSON.stringify({ appId: "contracts", scope: "SPACE_SHARED", gadgetTier: 3 }) }))).status).toBe(201);
    const unsafeMigration = await instance.fetch(new Request("https://do/initialize", { method: "POST", body: JSON.stringify({ appId: "contracts", scope: "SPACE_SHARED", gadgetTier: 3, migrations: [{ version: 1, description: "drop table", up: "DROP TABLE gadget_data;" }] }) }));
    expect(unsafeMigration.status).toBe(400);

    const unsafe = await instance.fetch(new Request("https://do/page/review", { method: "POST", body: JSON.stringify({ actor_id: "owner", draft: { slug: "sign", html: "<script>alert(1)</script>", actions: { submit: { key: "result", fields: ["email"] } } } }) }));
    expect(unsafe.status).toBe(400);
    const { reviewed, published } = await previewAndPublish(instance, "owner", {
      slug: "sign", html: "<form action='/p/s/contracts/sign/actions/submit'><input name='email'><input type='hidden' value='{{NAELAO_ACTION_TOKEN:submit}}'></form>",
      actions: { submit: { key: "signed-result", fields: ["email"] } },
    });
    expect(reviewed.status).toBe(200);
    expect(published.status).toBe(201);

    const page = await instance.fetch(new Request("https://do/page/render?spaceId=s&slug=sign"));
    const html = await page.text();
    const token = html.match(/value='([^']+)'/)?.[1];
    expect(token).toBeTruthy();
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const post = (payload: Record<string, unknown>) => instance.fetch(new Request("https://do/page/action?spaceId=s&slug=sign&action=submit", {
      method: "POST", headers: { "x-naelao-page-client": "a".repeat(64) }, body: JSON.stringify({ token, payload }),
    }));
    expect((await post({ email: "ok@example.test", admin: true })).status).toBe(400);
    expect((await post({ email: "ok@example.test" })).status).toBe(202);
    expect(JSON.parse(data.get("signed-result") ?? "null")).toEqual({ email: "ok@example.test" });
    expect((await post({ email: "ok@example.test" })).status).toBe(409);
  });
});
