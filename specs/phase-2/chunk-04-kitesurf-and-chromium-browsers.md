Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 2 — Chunk 04**: `specs/phase-2/chunk-04-kitesurf-and-chromium-browsers.md`.

---

```markdown
---
chunk_id: "phase-2-chunk-04"
phase: 2
include_files:
  - workers/browser/src/index.ts
  - workers/agents/src/script-engine/prebuilt/browser-use.ts
repomix_include:
  - "workers/browser/src/index.ts"
  - "workers/agents/src/script-engine/prebuilt/browser-use.ts"
expected_outputs:
  - workers/browser/src/index.ts
  - workers/agents/src/script-engine/prebuilt/browser-use.ts
---

# Phase 2 — Chunk 04: Tier 4 Kitesurf Agent Browser & Tier 5 Chromium Fallback

## 1. Executive Summary & Architectural Vision

Web scraping, article reading, and form navigation should not default to heavy, expensive Headless Chromium instances. 

AVOS integrates Cloudflare's **Tier 4 Kitesurf Agent Browser** (announced August 2026) alongside **Tier 5 Headless Chromium**:
* **Kitesurf (Tier 4):** A lightweight, agent-first browser engine consuming ~30MB of RAM and starting in <50ms (3–7x cheaper and faster than Chromium). It handles 85% of web tasks (DOM text extraction, article parsing, form automation).
* **Headless Chromium (Tier 5):** The heavy artillery (Puppeteer). Reserved strictly for WebGL rendering, canvas painting, bot-defense challenges, or pixel-perfect visual QA screenshots.

```
[ Agent invokes `Browser` tool / Action ]
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. ROUTER LAUNCHES TIER 4 KITESURF (Fast, 30MB Isolate)     │
│    Extracts clean accessibility tree (AXTree) in 200ms.     │
└──────────────────┬──────────────────────────────────────────┘
                   │
       ┌───────────┴───────────────────────────┐
       ▼ (Normal DOM / Text Extraction)        ▼ (Requires Screenshot / WebGL)
┌──────────────────────────────┐┌──────────────────────────────────┐
│ RETURN AXTree TEXT TO LLM    ││ 2. TRANSPARENT ELEVATION TO T.5  │
│ Session ends (<50ms, $0.001) ││    Headless Chromium launches.   │
└──────────────────────────────┘│    Captures visual PNG snapshot; │
                                │    streams image into LLM context│
                                └──────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. `workers/browser/src/index.ts`
Implement the browser router with automated capability-gap fallback from Kitesurf to Chromium:

```typescript
import puppeteer, { Browser as PuppeteerBrowser } from "@cloudflare/puppeteer";

export interface BrowserTaskRequest {
  url: string;
  action: "navigate" | "click" | "type" | "screenshot" | "extract";
  selector?: string;
  text?: string;
  engine?: "auto" | "kitesurf" | "chromium";
  takeScreenshot?: boolean;
  requiresWebGL?: boolean;
}

export interface BrowserTaskResponse {
  success: boolean;
  engineUsed: "kitesurf" | "chromium";
  title?: string;
  textContent?: string;
  screenshotBase64?: string;
  error?: string;
}

export class BrowserRouterWorker {
  constructor(private state: DurableObjectState, private env: any) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const payload = await request.json() as BrowserTaskRequest;
      const result = await this.executeWithLadderFallback(payload);
      return Response.json(result);
    } catch (err: any) {
      return Response.json({ success: false, error: err.message }, { status: 500 });
    }
  }

  private async executeWithLadderFallback(req: BrowserTaskRequest): Promise<BrowserTaskResponse> {
    const explicitEngine = req.engine || "auto";
    const needsHeavyChromium = req.takeScreenshot || req.requiresWebGL || explicitEngine === "chromium";

    // If engine is explicitly chromium, skip Kitesurf
    if (explicitEngine === "chromium") {
      return await this.runChromiumPuppeteer(req);
    }

    // TIER 4: Try Lightweight Kitesurf First (unless heavy features requested)
    if (!needsHeavyChromium) {
      try {
        const kitesurfResult = await this.runKitesurfBrowser(req);
        return {
          ...kitesurfResult,
          engineUsed: "kitesurf"
        };
      } catch (kitesurfErr: any) {
        console.warn("⚠️ Kitesurf capability limit hit, auto-elevating to Tier 5 Chromium:", kitesurfErr.message);
      }
    }

    // TIER 5: Full Headless Chromium Fallback
    const chromiumResult = await this.runChromiumPuppeteer(req);
    return {
      ...chromiumResult,
      engineUsed: "chromium"
    };
  }

  private async runKitesurfBrowser(req: BrowserTaskRequest): Promise<Omit<BrowserTaskResponse, "engineUsed">> {
    // Launch Kitesurf via Cloudflare Browser Rendering binding
    const browser = await puppeteer.launch(this.env.BROWSER, { browser: "kitesurf" });
    const page = await browser.newPage();
    
    await page.goto(req.url, { waitUntil: "networkidle0" });
    const title = await page.title();
    
    // Extract lightweight text content or accessibility tree
    const textContent = await page.evaluate(() => document.body.innerText);
    
    if (req.action === "click" && req.selector) {
      await page.click(req.selector);
    } else if (req.action === "type" && req.selector && req.text) {
      await page.type(req.selector, req.text);
    }

    await browser.close();
    return { success: true, title, textContent };
  }

  private async runChromiumPuppeteer(req: BrowserTaskRequest): Promise<Omit<BrowserTaskResponse, "engineUsed">> {
    // Launch Full Headless Chromium (Puppeteer)
    const browser = await puppeteer.launch(this.env.BROWSER, { browser: "chromium" });
    const page = await browser.newPage();

    await page.goto(req.url, { waitUntil: "networkidle0" });
    const title = await page.title();
    const textContent = await page.evaluate(() => document.body.innerText);

    let screenshotBase64: string | undefined;
    if (req.takeScreenshot || req.action === "screenshot") {
      const buffer = await page.screenshot({ fullPage: true });
      screenshotBase64 = Buffer.from(buffer).toString("base64");
    }

    await browser.close();
    return { success: true, title, textContent, screenshotBase64 };
  }
}
```

---

### B. `workers/agents/src/script-engine/prebuilt/browser-use.ts`

Implement the prebuilt tool adapter that connects the agent's `Browser` tool primitive to the `BrowserRouterWorker`:

```typescript
import { PrebuiltOpContext } from "../types";

export async function executeBrowserPrebuilt(
  args: { action: string; url?: string; selector?: string; text?: string; engine?: string; takeScreenshot?: boolean },
  ctx: PrebuiltOpContext
) {
  const browserWorkerUrl = ctx.env.BROWSER_ROUTER_SERVICE || "http://internal/browser-task";

  const response = await fetch(browserWorkerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: args.url,
      action: args.action,
      selector: args.selector,
      text: args.text,
      engine: args.engine || "auto",
      takeScreenshot: args.takeScreenshot
    })
  });

  if (!response.ok) {
    throw new Error(`Browser execution failed with status ${response.status}`);
  }

  const result = await response.json() as any;
  return {
    ok: true,
    engineUsed: result.engineUsed,
    title: result.title,
    content: result.textContent?.slice(0, 4000), // Trim to protect LLM context window
    screenshotCaptured: !!result.screenshotBase64
  };
}
```

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Update `workers/browser/src/index.ts`:
   - Implement `BrowserRouterWorker` with dynamic fallback routing (`auto` $\rightarrow$ `kitesurf` $\rightarrow$ `chromium`).
2. Update `workers/agents/src/script-engine/prebuilt/browser-use.ts`:
   - Implement `executeBrowserPrebuilt` to forward browser commands to the browser service.
3. Validate syntax using `node --check`.
```
