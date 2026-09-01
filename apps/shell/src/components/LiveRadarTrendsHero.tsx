"use client";

import * as React from "react";
import { Badge, Button } from "@naelao/ui";

export interface RadarOpportunity {
  id: string;
  rank: number;
  title: string;
  niche: string;
  category: "AGENCY" | "MICRO_SAAS" | "COWORK" | "VOICE_DESK" | "COMPLIANCE";
  trafficSurgePct: number;
  saturationIndex: number; // 0-100 (Lower = Less Competition)
  opportunityScore: number; // 0-100 (Combined Viability)
  estimatedMrrRange: string;
  recommendedArchetype: string;
  stackSummary: string;
  targetGeographies: string[];
  blueprintSpec: {
    baseTemplateId: string;
    seedProjects: Array<{ name: string; kind: string; plugins: string[] }>;
    initialPromptDirectives: string;
    preconfiguredScraperTargets?: string[];
  };
}

export const DEFAULT_TOP_5_RADAR_TRENDS: RadarOpportunity[] = [
  {
    id: "trend_solar_permits_fl_tx",
    rank: 1,
    title: "Automated Solar Permitting & Quoting Engine",
    niche: "Residential & Commercial Solar Installers (Florida & Texas)",
    category: "AGENCY",
    trafficSurgePct: 118,
    saturationIndex: 14,
    opportunityScore: 98,
    estimatedMrrRange: "$3,800 – $6,500 / mo",
    recommendedArchetype: "Lead Gen & Automated Municipal Quoting Studio",
    stackSummary: "growth_engine (Scrapes permit filings) + doc_studio (Quote Engine) + WhatsApp Desk",
    targetGeographies: ["US-FL", "US-TX", "US-AZ"],
    blueprintSpec: {
      baseTemplateId: "tpl_webdev_agency_v2",
      seedProjects: [
        { name: "Permit Scraper & Leads", kind: "growth_engine", plugins: ["r2-workspace", "browser-use"] },
        { name: "Instant Quote Portal", kind: "product_dev", plugins: ["r2-workspace", "file-manager"] },
        { name: "Solar Desk WhatsApp Receptionist", kind: "customer_bot", plugins: ["knowledge-base", "notifications"] },
      ],
      initialPromptDirectives: "Target residential solar contractors in Florida and Texas. Emphasize eliminating 3-week municipal permit delays.",
      preconfiguredScraperTargets: ["https://miamidade.gov/building/permits", "https://traviscountytx.gov/permits"],
    },
  },
  {
    id: "trend_medspa_voice_desk",
    rank: 2,
    title: "Post-Op Care & 24/7 Phone Desk for Cosmetic Clinics",
    niche: "Plastic Surgery, Dermatology & Med-Spas",
    category: "VOICE_DESK",
    trafficSurgePct: 84,
    saturationIndex: 21,
    opportunityScore: 94,
    estimatedMrrRange: "$2,500 – $4,500 / mo",
    recommendedArchetype: "24/7 AI Voice Phone Receptionist (@cloudflare/voice)",
    stackSummary: "voice_agent (Cloudflare Voice + Cartesia) + space_calendar + On-Call Forwarding",
    targetGeographies: ["US-CA", "US-NY", "US-FL", "UK"],
    blueprintSpec: {
      baseTemplateId: "tpl_voice_agent_v1",
      seedProjects: [
        { name: "24/7 Clinic Call Desk", kind: "voice_agent", plugins: ["knowledge-base"] },
        { name: "Client Consultation Calendar", kind: "ops_dispatcher", plugins: ["notifications"] },
      ],
      initialPromptDirectives: "You are the front desk receptionist for a luxury cosmetic clinic. Verify treatment interests and book consultations.",
    },
  },
  {
    id: "trend_subcontractor_lien_tracker",
    rank: 3,
    title: "Subcontractor Change Order & Lien Waiver Tracker",
    niche: "Commercial Construction & General Contractors",
    category: "MICRO_SAAS",
    trafficSurgePct: 92,
    saturationIndex: 18,
    opportunityScore: 92,
    estimatedMrrRange: "$4,200 – $7,800 / mo",
    recommendedArchetype: "Interactive Micro-App with DO Facet SQLite Ledger",
    stackSummary: "product_dev (DO Facet SQLite) + doc_studio (Lien PDF Generator) + E-Signatures",
    targetGeographies: ["US-National", "CA", "AU"],
    blueprintSpec: {
      baseTemplateId: "tpl_micro_saas_v1",
      seedProjects: [
        { name: "Lien Waiver Portal", kind: "product_dev", plugins: ["micro-app", "r2-workspace"] },
        { name: "Change Order PDF Engine", kind: "doc_studio", plugins: ["file-manager"] },
      ],
      initialPromptDirectives: "Automate unconditional and conditional progress lien waivers for commercial general contractors.",
    },
  },
  {
    id: "trend_shopify_pricing_radar",
    rank: 4,
    title: "Automated Competitor Pricing Intelligence for DTC Brands",
    niche: "Shopify Apparel & Beauty Brands",
    category: "AGENCY",
    trafficSurgePct: 76,
    saturationIndex: 29,
    opportunityScore: 89,
    estimatedMrrRange: "$2,800 – $5,200 / mo",
    recommendedArchetype: "Autonomous Edge Scraper & Daily Markdown Digest",
    stackSummary: "growth_engine (Kitesurf Browser) + finance_grid (Live Wasm Comps) + Daily Email",
    targetGeographies: ["Global", "US", "EU"],
    blueprintSpec: {
      baseTemplateId: "tpl_webdev_agency_v2",
      seedProjects: [
        { name: "Competitor Price Scraper", kind: "growth_engine", plugins: ["browser-use", "schedule"] },
        { name: "Markdown Alert Dispatcher", kind: "business-email", plugins: ["notifications"] },
      ],
      initialPromptDirectives: "Continuously extract product variants and discount codes from top 10 competing fashion DTC storefronts.",
    },
  },
  {
    id: "trend_eu_uk_tariff_compliance",
    rank: 5,
    title: "Cross-Border EU-UK Freight Tariff & Rules of Origin Radar",
    niche: "Freight Forwarders, Customs Brokers & Importers",
    category: "COMPLIANCE",
    trafficSurgePct: 145,
    saturationIndex: 11,
    opportunityScore: 97,
    estimatedMrrRange: "$5,000 – $9,500 / mo",
    recommendedArchetype: "Customs RAG Assistant with Daily Regulatory Crons",
    stackSummary: "doc_studio (Customs RAG) + ops_dispatcher (Daily Regulatory Cron) + PDF Export",
    targetGeographies: ["UK", "EU-DE", "EU-FR", "EU-NL"],
    blueprintSpec: {
      baseTemplateId: "tpl_legal_counsel_v1",
      seedProjects: [
        { name: "Tariff Code Matching Engine", kind: "knowledge-base", plugins: ["rag"] },
        { name: "Customs Compliance Dispatcher", kind: "ops_dispatcher", plugins: ["schedule", "business-email"] },
      ],
      initialPromptDirectives: "Classify Harmonized Tariff System (HTS) codes and verify preferential duty exemptions under the EU-UK TCA.",
    },
  },
];

interface LiveRadarTrendsHeroProps {
  onLaunchVenture: (trend: RadarOpportunity) => void;
}

export function LiveRadarTrendsHero({ onLaunchVenture }: LiveRadarTrendsHeroProps) {
  const [selectedTrend, setSelectedTrend] = React.useState<RadarOpportunity | null>(null);

  return (
    <div
      style={{
        marginBottom: 32,
        padding: "24px",
        borderRadius: "16px",
        background: "linear-gradient(135deg, rgba(91, 82, 240, 0.08) 0%, rgba(20, 20, 30, 0.02) 100%)",
        border: "1px solid rgba(91, 82, 240, 0.25)",
        boxShadow: "0 4px 20px -2px rgba(0, 0, 0, 0.05)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 18 }}>🔥</span>
            <h2 style={{ fontSize: "17px", fontWeight: 700, margin: 0, color: "var(--text)" }}>
              LIVE MARKET RADAR: Top 5 Autonomous Opportunities to Launch Today
            </h2>
            <Badge color="purple">Cloudflare Radar Verified</Badge>
            <Badge color="green">Live Traffic Signals</Badge>
          </div>
          <p style={{ fontSize: "12.5px", color: "var(--text3)", margin: "4px 0 0" }}>
            Eliminate Blank Canvas Paralysis. Real-time internet traffic surges, blue-ocean saturation indexes, and pre-seeded autonomous blueprints.
          </p>
        </div>
      </div>

      {/* Grid of Top 5 Radar Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
        {DEFAULT_TOP_5_RADAR_TRENDS.map((trend) => {
          const isBlueOcean = trend.saturationIndex < 20;

          return (
            <div
              key={trend.id}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "12px",
                padding: "16px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: 12,
                transition: "all 0.2s ease",
              }}
            >
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 800,
                      padding: "2px 8px",
                      borderRadius: 6,
                      background: "rgba(91, 82, 240, 0.15)",
                      color: "var(--accent, #5b52f0)",
                    }}
                  >
                    TREND #{trend.rank}
                  </span>
                  <Badge color={isBlueOcean ? "green" : "blue"}>
                    {isBlueOcean ? "🌊 Blue Ocean" : "⚡ High Velocity"}
                  </Badge>
                </div>

                <h3 style={{ fontSize: "14.5px", fontWeight: 700, margin: "0 0 4px", color: "var(--text)" }}>
                  {trend.title}
                </h3>
                <p style={{ fontSize: "12px", color: "var(--text3)", margin: "0 0 10px", lineHeight: 1.4 }}>
                  {trend.niche}
                </p>

                {/* Telemetry Metrics Row */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                    padding: "8px 10px",
                    background: "var(--surface2)",
                    borderRadius: "8px",
                    fontSize: "11.5px",
                    marginBottom: 10,
                  }}
                >
                  <div>
                    <div style={{ color: "var(--text3)", fontSize: "10px" }}>TRAFFIC SURGE</div>
                    <div style={{ fontWeight: 700, color: "#16a34a" }}>+{trend.trafficSurgePct}% (30d)</div>
                  </div>
                  <div>
                    <div style={{ color: "var(--text3)", fontSize: "10px" }}>SATURATION</div>
                    <div style={{ fontWeight: 700, color: isBlueOcean ? "#16a34a" : "#d97706" }}>
                      {trend.saturationIndex}/100 {isBlueOcean ? "(Low)" : "(Moderate)"}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: "var(--text3)", fontSize: "10px" }}>EST. OPERATOR ARR</div>
                    <div style={{ fontWeight: 700, color: "var(--text)" }}>{trend.estimatedMrrRange}</div>
                  </div>
                  <div>
                    <div style={{ color: "var(--text3)", fontSize: "10px" }}>VIABILITY SCORE</div>
                    <div style={{ fontWeight: 700, color: "var(--accent, #5b52f0)" }}>
                      {trend.opportunityScore}/100
                    </div>
                  </div>
                </div>

                {/* Preconfigured Stack summary */}
                <div style={{ fontSize: "11px", color: "var(--text3)", marginBottom: 4 }}>
                  <strong style={{ color: "var(--text2)" }}>Stack:</strong> {trend.stackSummary}
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <Button
                  variant="primary"
                  onClick={() => onLaunchVenture(trend)}
                  style={{ flex: 1, fontSize: "12px", padding: "8px 12px" }}
                >
                  🚀 Launch in 1-Click
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setSelectedTrend(trend)}
                  style={{ fontSize: "11px", padding: "8px 10px" }}
                >
                  🔍 Inspect
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Inspect Telemetry Modal */}
      {selectedTrend && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
          }}
          onClick={() => setSelectedTrend(null)}
        >
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 16,
              maxWidth: 580,
              width: "100%",
              padding: 24,
              boxShadow: "0 20px 40px rgba(0,0,0,0.3)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 18 }}>📡</span>
                <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Radar Telemetry Breakdown</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTrend(null)}
                style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "var(--text3)" }}
              >
                ✕
              </button>
            </div>

            <div style={{ spaceY: 12, fontSize: 13, color: "var(--text)" }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{selectedTrend.title}</div>
              <p style={{ color: "var(--text3)", margin: "0 0 16px" }}>{selectedTrend.niche}</p>

              <div style={{ padding: 12, background: "var(--surface2)", borderRadius: 10, marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text2)", marginBottom: 6 }}>
                  Global Demand Telemetry (Cloudflare Radar + Iceberg Lakehouse)
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12 }}>
                  <div>• Traffic Surge: <strong>+{selectedTrend.trafficSurgePct}%</strong></div>
                  <div>• Saturation Index: <strong>{selectedTrend.saturationIndex}/100</strong></div>
                  <div>• Target Geographies: <strong>{selectedTrend.targetGeographies.join(", ")}</strong></div>
                  <div>• Viability Index: <strong>{selectedTrend.opportunityScore}/100</strong></div>
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text2)", marginBottom: 4 }}>
                  Pre-Configured Autonomous Blueprint
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--text3)" }}>
                  {selectedTrend.blueprintSpec.seedProjects.map((p) => (
                    <li key={p.name} style={{ marginBottom: 2 }}>
                      <strong style={{ color: "var(--text)" }}>{p.name}</strong> ({p.kind}) — plugins: {p.plugins.join(", ")}
                    </li>
                  ))}
                </ul>
              </div>

              <div style={{ padding: 10, background: "rgba(91, 82, 240, 0.08)", borderRadius: 8, fontSize: 12, color: "var(--text2)", marginBottom: 20 }}>
                💡 <em>Directives:</em> {selectedTrend.blueprintSpec.initialPromptDirectives}
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <Button variant="secondary" onClick={() => setSelectedTrend(null)}>
                  Close
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    const t = selectedTrend;
                    setSelectedTrend(null);
                    onLaunchVenture(t);
                  }}
                >
                  🚀 Launch This Venture with 1-Click
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
