import { DurableObject } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import type { Browser, Page } from "@cloudflare/puppeteer";
import { mintInternalToken, readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";
import { checkSsrf } from "@naelao/security";
import { assertBrowserAction, assertBrowserUrl, browserEngineFor, validateBrowserScope,
  type BrowserObservation, type BrowserRuntimeScope, type BrowserScopedAction } from "@naelao/agent-sdk";
import { BrowserActionJournal, sameBrowserOwner, type BrowserSessionRecord } from "./browser-session-state.js";

export interface BrowserEnv {
  ENVIRONMENT: string; PLATFORM_SECRET: string; BROWSER?: Fetcher;
  BROWSER_SESSION_DO?: DurableObjectNamespace; SPACES_WORKER?: Fetcher; BROWSER_ARTIFACTS?: R2Bucket;
}
export interface BrowserRequest {
  scope: BrowserRuntimeScope; url?: string; action?: BrowserScopedAction;
  interactive?: boolean; visual?: boolean; pixelAccurate?: boolean; webgl?: boolean; path?: string;
}
interface AXNode { backendDOMNodeId?: number; frameId?: string; role?: { value?: string }; name?: { value?: string }; properties?: Array<{ name: string; value?: { value?: unknown } }> }
interface ElementReference { backendNodeId: number; frameId: string; role: string; name: string }
const IDLE_MS = 120_000;
const RECORD = "browser-session";

/** One task-owned remote page. CDP/provider identifiers never cross the agent boundary. */
export class BrowserSessionDO extends DurableObject<BrowserEnv> {
  private browser: Browser | undefined;
  private pending = Promise.resolve();
  private cancelled = false;

  override async fetch(request: Request): Promise<Response> {
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      try { request = new Request(request, { body: await readBoundedRequestBytes(request, 1024 * 1024) }); }
      catch (error) {
        if (error instanceof RequestBodyTooLargeError) return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
        return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
      }
    }
    let body: BrowserRequest;
    try { body = await request.json<BrowserRequest>(); validateBrowserScope(body.scope); }
    catch { return Response.json({ error_code: "browser_scope_invalid" }, { status: 400 }); }
    const method = new URL(request.url).pathname.split("/").pop() ?? "";
    // Cancellation must interrupt work, rather than sit behind the running navigation.
    if (method === "close" || method === "cancel") {
      const record = await this.ctx.storage.get<BrowserSessionRecord>(RECORD);
      if (!record || !sameBrowserOwner(record.scope, body.scope)) return Response.json({ error_code: "browser_session_not_found" }, { status: 404 });
      await this.closeSession(record);
      return Response.json({ ok: true, session_id: body.scope.sessionId, status: "closed" });
    }
    const before = this.pending;
    let unlock!: () => void;
    this.pending = new Promise<void>(resolve => { unlock = resolve; });
    await before;
    try {
      await this.authorize(body.scope, method === "act");
      const existing = await this.ctx.storage.get<BrowserSessionRecord>(RECORD);
      if (existing && (!sameBrowserOwner(existing.scope, body.scope) || existing.status !== "open" || existing.scope.expiresAt <= Date.now())) throw new Error("browser_session_closed");
      if (existing) {
        // A subsequent call may narrow a grant, but cannot extend its first scope or lifetime.
        if (body.scope.maxTier < (existing.engine === "chromium" ? 5 : 4) || existing.scope.authorizedOrigins.some(origin => !body.scope.authorizedOrigins.includes(origin))) throw new Error("browser_scope_changed");
        body.scope = { ...existing.scope, authorizedActions: existing.scope.authorizedActions.filter(action => body.scope.authorizedActions.includes(action)) };
      }
      if (method === "see") return await this.see(existing, body);
      if (method === "snapshot") {
        if (!existing?.observation || existing.observation.expiresAt <= Date.now()) throw new Error("browser_observation_stale");
        return Response.json({ ok: true, result: existing.observation, engine_used: existing.engine });
      }
      const result = await this.operate(existing, body, method);
      return Response.json({ ok: true, result, engine_used: result.engine });
    } catch (error) {
      const code = error instanceof Error ? error.message : "browser_operation_failed";
      // Do not expose provider stack traces, credentials or page contents in error messages.
      const safe = /^(?:browser_[a-z_]+|SSRF_blocked)$/.test(code) ? code : "browser_provider_error";
      if (safe === "browser_grant_revoked" || this.cancelled) {
        const record = await this.ctx.storage.get<BrowserSessionRecord>(RECORD);
        if (record) await this.closeSession(record).catch(() => undefined);
      }
      return Response.json({ ok: false, error_code: safe, message: safe.replaceAll("_", " ") }, { status: safe.includes("revoked") || safe.includes("authorized") || safe === "SSRF_blocked" ? 403 : safe.includes("reconciliation") || safe.includes("stale") || safe.includes("conflict") ? 409 : safe.includes("unavailable") ? 503 : 422 });
    } finally { unlock(); }
  }

  private async authorize(scope: BrowserRuntimeScope, mutation: boolean): Promise<void> {
    validateBrowserScope(scope);
    if (this.cancelled) throw new Error("browser_session_closed");
    if (!this.env.SPACES_WORKER) throw new Error("browser_authorization_unavailable");
    const headers = { "x-naelao-tenant-id": scope.tenantId, "x-naelao-user-id": scope.actorId,
      "x-naelao-internal-token": await mintInternalToken(this.env.PLATFORM_SECRET, scope.tenantId) };
    const response = await this.env.SPACES_WORKER.fetch(new Request("http://spaces-worker/spaces/" + encodeURIComponent(scope.spaceId) + "/members", { headers }));
    if (!response.ok) throw new Error("browser_grant_revoked");
    const members = await response.json<{ data?: Array<{ user_id: string; role: string }> }>();
    const member = members.data?.find(item => item.user_id === scope.actorId);
    if (!member || (mutation && !["owner", "admin", "editor", "operator", "member"].includes(member.role))) throw new Error("browser_grant_revoked");
    if (scope.projectId && member.role !== "owner" && member.role !== "admin") {
      const project = await this.env.SPACES_WORKER.fetch(new Request("http://spaces-worker/spaces/" + encodeURIComponent(scope.spaceId) + "/projects/" + encodeURIComponent(scope.projectId) + "/members", { headers }));
      const roster = project.ok ? await project.json<{ data?: Array<{ user_id: string; role: string }> }>() : {};
      if (!roster.data?.some(item => item.user_id === scope.actorId && (!mutation || ["owner", "admin", "editor", "operator", "member"].includes(item.role)))) throw new Error("browser_grant_revoked");
    }
  }

  private async operate(existing: BrowserSessionRecord | undefined, body: BrowserRequest, method: string): Promise<BrowserObservation> {
    if (!this.env.BROWSER) throw new Error("browser_provider_unavailable");
    if (!["navigate", "observe", "act"].includes(method)) throw new Error("browser_operation_invalid");
    if (method === "act" && (!existing?.observation || !body.action)) throw new Error("browser_observation_required");
    const visual = body.visual || body.pixelAccurate;
    const selected = browserEngineFor(body.scope, {
      ...(visual !== undefined ? { visual } : {}),
      ...(body.webgl !== undefined ? { webgl: body.webgl } : {}),
      ...(body.interactive !== undefined ? { persistentLogin: body.interactive } : {}),
    });
    const engine = existing?.engine === "chromium" ? "chromium" : selected.engine;
    const target = body.url ?? existing?.url;
    if (!target) throw new Error("browser_url_required");
    assertBrowserUrl(body.scope, target);
    const safety = await checkSsrf(target);
    if (safety.blocked) throw new Error("SSRF_blocked");
    if (method === "act" && existing?.engine !== "chromium") throw new Error("browser_interactive_observation_required");
    if (method === "act" && body.url && body.url !== existing?.url) throw new Error("browser_observation_stale");
    let record: BrowserSessionRecord = existing ?? { scope: body.scope, engine, status: "open", url: target, actions: 0, screenshots: [], lastUsedAt: Date.now() };
    const journal = new BrowserActionJournal(this.ctx.storage);
    let claimed = false;
    if (body.action && method === "act") {
      const claim = await journal.claim(body.action);
      if (!claim.created) {
        if (claim.record.status === "committed" && claim.record.result) return claim.record.result;
        throw new Error("browser_action_reconciliation_required");
      }
      claimed = true;
      assertBrowserAction(body.scope, record.observation!, body.action);
      if (record.actions >= 32) throw new Error("browser_action_limit");
      record = { ...record, actions: record.actions + 1 };
    }
    // Persist ownership before allocating provider resources; alarms repair partial cleanup.
    await this.storeOpen(record);
    await this.ctx.storage.setAlarm(Math.min(body.scope.expiresAt, Date.now() + IDLE_MS));
    let browser: Browser | undefined;
    let completed = false;
    const changingEngine = record.engine !== engine;
    try {
      if (record.providerSessionId && record.engine === "chromium") {
        try { browser = await puppeteer.connect(this.env.BROWSER, record.providerSessionId); }
        catch { throw new Error("browser_provider_session_lost"); }
      } else {
        browser = await puppeteer.launch(this.env.BROWSER, engine === "kitesurf" ? { browser: "kitesurf" } : { keep_alive: 300_000 });
      }
      this.browser = browser;
      if (this.cancelled) throw new Error("browser_session_closed");
      const reconnecting = Boolean(record.providerSessionId && !changingEngine);
      if (engine === "chromium") {
        record = { ...record, engine, providerSessionId: browser.sessionId() };
        await this.storeOpen(record);
      }
      const pages = await browser.pages();
      const page = pages[0] ?? await browser.newPage();
      for (const extra of pages.slice(1)) await extra.close();
      // This protocol owns one page. Downloads and popup windows are not granted actions.
      await page.setBypassServiceWorker(true);
      await page.evaluateOnNewDocument("Object.defineProperty(window,'open',{value:()=>null,writable:false,configurable:false});");
      browser.on("targetcreated", target => { void target.page().then(popup => popup && popup !== page ? popup.close() : undefined).catch(() => undefined); });
      const client = await page.createCDPSession();
      await client.send("Page.setDownloadBehavior", { behavior: "deny" });
      // All resources, frames and redirects are intercepted. Cross-origin assets require an
      // explicit host-approved origin; a page cannot expand the allowlist itself.
      let requests = 0, denied = false;
      await page.setRequestInterception(true);
      page.removeAllListeners("request");
      page.on("request", request => {
        void (async () => {
          let allowed = !this.cancelled && ++requests <= 128;
          try { assertBrowserUrl(body.scope, request.url()); allowed = allowed && !(await checkSsrf(request.url())).blocked; }
          catch { allowed = false; }
          if (allowed) await request.continue();
          else { denied = true; await request.abort("blockedbyclient"); }
        })().catch(() => { denied = true; void request.abort("blockedbyclient").catch(() => undefined); });
      });
      if (changingEngine && record.cookies?.length) await page.setCookie(...record.cookies as Parameters<Page["setCookie"]>);
      if (!reconnecting || method === "navigate" || changingEngine) await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      assertBrowserUrl(body.scope, page.url());
      if (method === "act") {
        await this.authorize(body.scope, true);
        const action = body.action!;
        assertBrowserAction(body.scope, record.observation!, action);
        if (action.type === "scroll") await page.evaluate("window.scrollBy(" + JSON.stringify(action.x ?? 0) + "," + JSON.stringify(action.y ?? 0) + ")");
        else {
          const ref = await this.ctx.storage.get<ElementReference>("element:" + record.observation!.revision + ":" + action.handle);
          if (!ref) throw new Error("browser_observation_stale");
          const current = await client.send("Accessibility.getFullAXTree", { frameId: ref.frameId });
          const node = current.nodes.find(item => item.backendDOMNodeId === ref.backendNodeId);
          if (!node || node.role?.value !== ref.role || node.name?.value !== ref.name) throw new Error("browser_observation_stale");
          const resolved = await client.send("DOM.resolveNode", { backendNodeId: ref.backendNodeId });
          const objectId = resolved.object.objectId;
          if (!objectId) throw new Error("browser_observation_stale");
          try {
            const result = await client.send("Runtime.callFunctionOn", {
              objectId, returnByValue: true, userGesture: true,
              functionDeclaration: "function(kind,text,value){if(!this.isConnected||this.disabled||this.getAttribute('aria-disabled')==='true')throw Error('stale');if(kind==='click'){if(this.tagName==='A')this.target='_self';this.click();return true;}if(kind==='select'){if(this.tagName!=='SELECT')throw Error('type');this.value=value;}else{if(!['INPUT','TEXTAREA'].includes(this.tagName))throw Error('type');const proto=this.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(this,text);}this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true;}",
              arguments: [{ value: action.type }, { value: action.text ?? "" }, { value: action.value ?? "" }],
            });
            if (result.exceptionDetails) throw new Error("browser_action_failed");
          } finally { await client.send("Runtime.releaseObject", { objectId }).catch(() => undefined); }
        }
      }
      if (denied) throw new Error("browser_network_policy_denied");
      await this.authorize(body.scope, false);
      const latest = await this.ctx.storage.get<BrowserSessionRecord>(RECORD);
      if (this.cancelled || latest?.status !== "open") throw new Error("browser_session_closed");
      const revision = crypto.randomUUID();
      const observation: BrowserObservation = { schema: 1, sessionId: body.scope.sessionId, revision, engine,
        url: page.url(), title: await page.title(), text: String(await page.evaluate("document.body?.innerText || ''")).slice(0, 1200),
        elements: [], untrusted: true, capturedAt: Date.now(), expiresAt: Math.min(body.scope.expiresAt, Date.now() + 30_000),
        features: { interactive: engine === "chromium", pixelAccurate: engine === "chromium", persistentLogin: engine === "chromium" } };
      const tree = await client.send("Page.getFrameTree");
      const frames: string[] = [];
      const collectFrames = (frame: typeof tree.frameTree): void => { if (frames.length >= 16) return; frames.push(frame.frame.id); frame.childFrames?.forEach(collectFrames); };
      collectFrames(tree.frameTree);
      const elements = [] as BrowserObservation["elements"][number][];
      for (const frameId of frames) {
        let nodes: AXNode[];
        try { nodes = (await client.send("Accessibility.getFullAXTree", { frameId })).nodes as AXNode[]; }
        catch { continue; } // Unsupported cross-process frames are never represented as actionable.
        for (const node of nodes) {
          if (elements.length >= 80 || !node.backendDOMNodeId) continue;
          const role = String(node.role?.value ?? ""), name = String(node.name?.value ?? "").slice(0, 256);
          const kinds: Array<"click" | "type" | "select"> = role === "textbox" || role === "searchbox" ? ["type"] : role === "combobox" ? ["select"] : ["button", "link", "checkbox", "radio", "menuitem"].includes(role) ? ["click"] : [];
          if (!kinds.length) continue;
          const handle = "e" + elements.length;
          elements.push({ handle, role, name, frameId, enabled: !node.properties?.some(item => item.name === "disabled" && item.value?.value === true), permittedActions: kinds.filter(kind => body.scope.authorizedActions.includes(kind)) });
          await this.ctx.storage.put("element:" + revision + ":" + handle, { backendNodeId: node.backendDOMNodeId, frameId, role, name } satisfies ElementReference);
        }
      }
      observation.elements = elements;
      if (body.visual) {
        if (record.screenshots.length >= 8) throw new Error("browser_screenshot_limit");
        if (!this.env.BROWSER_ARTIFACTS) throw new Error("browser_artifact_storage_unavailable");
        const bytes = await page.screenshot({ type: "png", fullPage: false });
        if (bytes.byteLength > 4 * 1024 * 1024) throw new Error("browser_screenshot_limit");
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
        const path = ".perception/" + [body.scope.tenantId, body.scope.spaceId, body.scope.runId, body.scope.sessionId, revision + ".png"].map(encodeURIComponent).join("/");
        await this.env.BROWSER_ARTIFACTS.put(path, bytes, { httpMetadata: { contentType: "image/png" } });
        observation.screenshot = { path, mimeType: "image/png", bytes: bytes.byteLength, sha256: hash };
        record.screenshots.push(path);
      }
      if (record.observation) {
        await this.ctx.storage.delete(record.observation.elements.map(element => "element:" + record.observation!.revision + ":" + element.handle));
      }
      record = { ...record, engine, observation, url: observation.url, cookies: engine === "kitesurf" ? await page.cookies() : [],
        ...(engine === "chromium" ? { providerSessionId: browser.sessionId() } : {}), lastUsedAt: Date.now() };
      await this.storeOpen(record);
      await this.ctx.storage.setAlarm(Math.min(record.scope.expiresAt, Date.now() + IDLE_MS));
      if (claimed) await journal.finish(body.action!.actionId, observation);
      await client.detach();
      completed = true;
      return observation;
    } catch (error) {
      if (claimed) await journal.finish(body.action!.actionId);
      throw error;
    } finally {
      this.browser = undefined;
      if (browser) {
        if (engine === "chromium" && !this.cancelled && completed) await browser.disconnect().catch(() => undefined);
        else await browser.close().catch(() => undefined);
      }
    }
  }

  private async storeOpen(record: BrowserSessionRecord): Promise<void> {
    await this.ctx.storage.transaction(async storage => {
      const current = await storage.get<BrowserSessionRecord>(RECORD);
      if (this.cancelled || current?.status === "closed") throw new Error("browser_session_closed");
      await storage.put(RECORD, record);
    });
  }

  private async see(record: BrowserSessionRecord | undefined, body: BrowserRequest): Promise<Response> {
    if (!record?.observation?.screenshot || !this.env.BROWSER_ARTIFACTS) throw new Error("browser_screenshot_not_found");
    const screenshot = record.observation.screenshot;
    if (body.path && body.path !== "latest" && body.path !== screenshot.path) throw new Error("browser_screenshot_not_authorized");
    const object = await this.env.BROWSER_ARTIFACTS.get(screenshot.path);
    if (!object || object.size > 4 * 1024 * 1024) throw new Error("browser_screenshot_not_found");
    // Binary vision is intentionally separate from browse text/observations.
    return new Response(object.body, { headers: { "content-type": "image/png", "cache-control": "no-store", "x-browser-engine": record.engine } });
  }

  private async closeSession(record: BrowserSessionRecord): Promise<void> {
    this.cancelled = true;
    await this.ctx.storage.put(RECORD, { ...record, status: "closed", cookies: [] });
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    if (this.browser) await this.browser.close();
    else if (record.providerSessionId && this.env.BROWSER) {
      const active = await puppeteer.sessions(this.env.BROWSER);
      if (active.some(session => session.sessionId === record.providerSessionId)) {
        const browser = await puppeteer.connect(this.env.BROWSER, record.providerSessionId);
        await browser.close();
      }
    }
    if (record.screenshots.length && this.env.BROWSER_ARTIFACTS) await this.env.BROWSER_ARTIFACTS.delete(record.screenshots);
    if (record.observation) await this.ctx.storage.delete(record.observation.elements.map(element => "element:" + record.observation!.revision + ":" + element.handle));
    await this.ctx.storage.deleteAlarm();
  }
  override async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<BrowserSessionRecord>(RECORD);
    if (record) await this.closeSession(record);
  }
}
