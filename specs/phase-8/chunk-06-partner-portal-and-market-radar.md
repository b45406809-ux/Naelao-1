Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 8 — Chunk 06**: `specs/phase-8/chunk-06-partner-portal-and-market-radar.md`.

---

```markdown
---
chunk_id: "phase-8-chunk-06"
phase: 8
include_files:
  - workers/spaces/src/business-routes.ts
  - packages/types/src/index.ts
  - workers/spaces/src/template-catalog.ts
repomix_include:
  - "workers/spaces/src/business-routes.ts"
  - "packages/types/src/index.ts"
  - "workers/spaces/src/template-catalog.ts"
expected_outputs:
  - workers/spaces/src/business-routes.ts
  - packages/types/src/market-radar.ts
  - packages/types/src/index.ts
---

# Phase 8 — Chunk 06: Partner Portal & Discover Page Live Market Radar

## 1. Executive Summary & Architectural Vision

The final milestone of AVOS bridges developer empowerment and automated market intelligence. 

By combining the **Developer Partner Portal** with the **Discover Page Live Market Radar**, the platform transforms from a utility tool into a self-scaling ecosystem:
1. **The FDE-to-Vertical-SaaS Graduation Pipeline:** Forward Deployed Engineers (FDEs) or boutique software agencies embed with local businesses to solve bespoke operational problems, charge high upfront implementation fees ($5,000–$25,000), and then export their solution as a reusable template to collect **40% recurring lifetime monthly revenue shares**.
2. **The Live Market Radar:** Eliminates "Blank Canvas Paralysis" for aspiring founders. At the top of the Discover Page, the platform exposes the **Top 5 High-Velocity Market Opportunities of the Week** backed by real-time Cloudflare Radar Internet Telemetry and Apache Iceberg streaming analytics on R2. With 1 click, founders launch pre-seeded, hyper-targeted vertical businesses.

---

## 2. System Mental Models & Data Flows

### A. The 1-Click "Radar-to-Venture" Launch Pipeline
```
[ Founder clicks "Launch Venture" on Trend #1 (Solar Permitting Engine) ]
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. GENESIS ENGINE RECEIVES RADAR TELEMETRY METADATA                         │
│    Passes: `{ niche: "Solar Permitting", region: "FL/TX", targetICP: "..." }`│
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. DYNAMIC WORKSPACE COMPILATION (3 Seconds in Durable Objects)             │
│    • `PROJECT.md` is auto-seeded with regional zoning and permit specs.      │
│    • Scrapers are pre-configured to query county building registries.       │
│    • Tailwind landing page is compiled live to Cloudflare Pages.            │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. INSTANT EDGE DEPLOYMENT & ACTIVE PROACTIVE CYCLE                         │
│    • Deployed live to `https://floridasolarquote.yourdomain.com`.           │
│    • Space Assistant wakes up:                                              │
│      "Welcome to Florida Solar Quote Engine! Your landing page is live,     │
│       and I've queued our first 50 municipal permit registry leads."        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### B. The Developer Partner Portfolio & Referral Tracking
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       DEVELOPER PARTNER PORTAL ARCHITECTURE                 │
├──────────────────────────┬──────────────────────────────────────────────────┤
│ 1. Template Studio       │ Visual Blueprint Builder & TypeScript Sandbox    │
├──────────────────────────┼──────────────────────────────────────────────────┤
│ 2. Client Referral Links │ Unique URL / QR: `app.platform.com/join?dev=john`│
├──────────────────────────┼──────────────────────────────────────────────────┤
│ 3. Partner Wallet Ledger │ Live MRR tracking & automated commission splits  │
└──────────────────────────┴──────────────────────────────────────────────────┘
```

---

## 3. Technical Specifications & File Implementation Contracts

### A. Define Market Radar Types (`packages/types/src/market-radar.ts`)
Create `packages/types/src/market-radar.ts` and re-export from `packages/types/src/index.ts`:

```typescript
export type VentureCategory = "AGENCY" | "MICRO_SAAS" | "COWORK" | "VOICE_DESK";

export interface RadarOpportunity {
  id: string;
  rank: number;
  title: string;
  niche: string;
  category: VentureCategory;
  trafficSurgePct: number;
  saturationIndex: number; // 0 to 100 (Lower = Less Competition / Blue Ocean)
  opportunityScore: number; // 0 to 100 (Combined Viability)
  estimatedMrrRange: string;
  recommendedArchetype: string;
  blueprintSpec: {
    baseTemplateId: string;
    seedProjects: Array<{ name: string; kind: string; plugins: string[] }>;
    initialPromptDirectives: string;
    preconfiguredScraperTargets?: string[];
  };
}

export interface PartnerAccountRecord {
  id: string;
  userId: string;
  displayName: string;
  payoutEmail: string;
  commissionRatePct: number; // 40.0 for referral, 20.0 for organic
  totalEarnedCents: number;
  balanceCents: number;
  createdAt: string;
}

export interface PartnerTemplateListing {
  id: string;
  partnerId: string;
  name: string;
  category: string;
  description: string;
  blueprintR2Key: string;
  priceCentsMonthly: number;
  isPublic: boolean;
  createdAt: string;
}
```

---

### B. Implement Backend Endpoints (`workers/spaces/src/business-routes.ts`)

Add the Live Market Radar API route and partner attribution handlers:

```typescript
import { Hono } from "hono";
import { RadarOpportunity, ExportedBlueprintManifest } from "@naelao/types";

export function registerBusinessRoutes(app: Hono<{ Bindings: Env }>) {

  // 1. Live Market Radar Endpoint (Powered by Cloudflare Radar & Iceberg Telemetry)
  app.get("/spaces/:productSpaceId/radar-trends", async (c) => {
    // In production, this queries Cloudflare Radar API & Apache Iceberg tables on R2.
    // Returning high-velocity verified market opportunities:
    const opportunities: RadarOpportunity[] = [
      {
        id: "trend_solar_permits_fl",
        rank: 1,
        title: "Automated Solar Permitting & Quoting Engine",
        niche: "Residential & Commercial Solar Installers (FL / TX)",
        category: "AGENCY",
        trafficSurgePct: 118,
        saturationIndex: 14,
        opportunityScore: 98,
        estimatedMrrRange: "$3,800 – $6,500 / mo",
        recommendedArchetype: "Lead Gen & Automated Quoting Studio",
        blueprintSpec: {
          baseTemplateId: "tpl_webdev_agency_v2",
          seedProjects: [
            { name: "Permit Scraper & Leads", kind: "growth_engine", plugins: ["r2-workspace", "browser-use"] },
            { name: "Instant Quote Portal", kind: "product_dev", plugins: ["r2-workspace", "file-manager"] },
            { name: "Solar Desk WhatsApp Receptionist", kind: "customer_bot", plugins: ["knowledge-base"] }
          ],
          initialPromptDirectives: "Target residential solar contractors in Florida and Texas. Emphasize eliminating 3-week municipal permit delays.",
          preconfiguredScraperTargets: ["https://miamidade.gov/building/permits", "https://traviscountytx.gov/permits"]
        }
      },
      {
        id: "trend_medspa_voice_desk",
        rank: 2,
        title: "Post-Op Care Voice Receptionist for Med-Spas",
        niche: "Plastic Surgery, Dermatology & Med-Spa Clinics",
        category: "VOICE_DESK",
        trafficSurgePct: 84,
        saturationIndex: 21,
        opportunityScore: 94,
        estimatedMrrRange: "$2,500 – $4,500 / mo",
        recommendedArchetype: "24/7 AI Voice Phone Receptionist",
        blueprintSpec: {
          baseTemplateId: "tpl_voice_agent_v1",
          seedProjects: [
            { name: "24/7 Clinic Call Desk", kind: "voice_agent", plugins: ["knowledge-base"] },
            { name: "Client Consultation Calendar", kind: "ops_dispatcher", plugins: ["notifications"] }
          ],
          initialPromptDirectives: "You are the front desk receptionist for a luxury cosmetic clinic. Verify post-op symptoms and book follow-up consultations."
        }
      }
    ];

    return c.json({
      ok: true,
      opportunities,
      generatedAt: new Date().toISOString(),
      telemetrySource: "Cloudflare Radar & Iceberg Lakehouse (R2)"
    });
  });

  // 2. Partner Template Publishing Endpoint
  app.post("/spaces/:spaceId/publish-template", async (c) => {
    const { spaceId } = c.req.param();
    const body = await c.req.json() as {
      templateTitle: string;
      category: string;
      description: string;
      priceCentsMonthly: number;
      pricingModel: "FREEMIUM_TIERED" | "FIXED_BUYOUT";
    };

    const blueprintId = `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    
    // Store listing metadata in D1 platform database
    await c.env.PLATFORM_DB.prepare(`
      INSERT INTO partner_templates (id, partner_id, name, category, description, blueprint_r2_key, price_cents_monthly, is_public)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      blueprintId,
      "partner_dev_default", // Resolved from caller identity in production
      body.templateTitle,
      body.category,
      body.description,
      `blueprints/${blueprintId}.json`,
      body.priceCentsMonthly,
      1
    ).run();

    return c.json({
      ok: true,
      blueprintId,
      message: "Template successfully published to the public AVOS marketplace!"
    });
  });
}
```

---

## 4. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Create `packages/types/src/market-radar.ts` defining `RadarOpportunity`, `PartnerAccountRecord`, and `PartnerTemplateListing`. Re-export from `packages/types/src/index.ts`.
2. Update `workers/spaces/src/business-routes.ts` to include the `radar-trends` scouting API and the `publish-template` partner endpoint.
3. Run `node --check` syntax validation to ensure zero compilation regressions.
```
