"use client";

import * as React from "react";
import { Button, Badge } from "@naelao/ui";
import {
  getBusinessWallet, listWorkspaceFiles, readWorkspaceFile,
  type Project, type BusinessWallet, type WorkspaceFile, type WorkspaceFileContent,
} from "@/lib/api";
import { FileViewer } from "@/components/FileViewer";

type Creds = { sessionToken: string; endUserId: string };

/**
 * Bi-Directional Visual Canvas with Click-to-Edit Inspector:
 * Listens for DOM clicks on elements tagged with `data-source="src/components/Header.astro:42"`,
 * extracting file and line coordinates directly to pass to the agent's Edit tool.
 */
export interface InspectedElement {
  filePath: string;
  line?: number;
  selector?: string;
  text?: string;
}

export function VisualCanvasViewer({
  previewUrl,
  onSelectElement,
}: {
  previewUrl: string;
  onSelectElement?: (elem: InspectedElement) => void;
}) {
  const [inspecting, setInspecting] = React.useState(true);

  React.useEffect(() => {
    function handleIframeMessage(e: MessageEvent) {
      if (e.data && e.data.type === "AVOS_DOM_CLICK") {
        const { dataSource, selector, textContent } = e.data;
        if (dataSource) {
          const [filePath, lineStr] = String(dataSource).split(":");
          onSelectElement?.({
            filePath: filePath || "src/pages/index.astro",
            line: lineStr ? parseInt(lineStr, 10) : undefined,
            selector,
            text: textContent ? String(textContent).slice(0, 80) : undefined,
          });
        }
      }
    }
    window.addEventListener("message", handleIframeMessage);
    return () => window.removeEventListener("message", handleIframeMessage);
  }, [onSelectElement]);

  return (
    <div className="visual-canvas-container" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)" }}>
      <div className="visual-canvas-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", borderBottom: "1px solid var(--border)", background: "var(--surface2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Badge color="green">Live Edge Preview</Badge>
          <span style={{ fontSize: "12px", color: "var(--text3)", fontFamily: "monospace" }}>{previewUrl}</span>
        </div>
        <Button size="sm" variant={inspecting ? "primary" : "ghost"} onClick={() => setInspecting(!inspecting)}>
          {inspecting ? "🎯 Inspector Active (Click Elements)" : "Inspect Element"}
        </Button>
      </div>
      <div style={{ flex: 1, position: "relative", minHeight: "450px" }}>
        <iframe
          src={previewUrl}
          title="Live Edge Canvas"
          style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </div>
    </div>
  );
}

// ── Domain Viewport 1: DocumentRedlineCanvas ("Harvey AI / Legora Competitor") ──
export function DocumentRedlineCanvas({
  projectName,
  onSelectClause,
}: {
  projectName: string;
  onSelectClause?: (clause: { title: string; risk: string; text: string; citation: string }) => void;
}) {
  const [selectedClauseId, setSelectedClauseId] = React.useState<string>("c1");
  const [viewMode, setViewMode] = React.useState<"split" | "unified">("split");

  const clauses = [
    {
      id: "c1",
      section: "Section 8.2",
      title: "Indemnification & Third-Party Claims",
      risk: "HIGH",
      citation: "Del. Code tit. 8, § 145(a)",
      originalText:
        "Customer shall indemnify, defend, and hold harmless Provider against any and all claims, liabilities, losses, damages, and reasonable expenses arising out of any third-party claim related to Customer Data without limitation.",
      proposedText:
        "Each party shall mutually indemnify, defend, and hold harmless the other party against direct liabilities and reasonable expenses arising out of third-party IP infringement claims, subject to the aggregate liability cap in Section 9.1.",
      notes: "Uncapped one-way indemnity replaced with mutual IP indemnification capped at 12 months fees.",
    },
    {
      id: "c2",
      section: "Section 9.1",
      title: "Limitation of Liability",
      risk: "MEDIUM",
      citation: "UCC § 2-719(1)(a)",
      originalText:
        "IN NO EVENT SHALL PROVIDER BE LIABLE FOR ANY CONSEQUENTIAL OR PUNITIVE DAMAGES. PROVIDER'S TOTAL AGGREGATE LIABILITY SHALL BE CAPPED AT $100.",
      proposedText:
        "NEITHER PARTY SHALL BE LIABLE FOR CONSEQUENTIAL DAMAGES. EACH PARTY'S TOTAL AGGREGATE LIABILITY UNDER THIS AGREEMENT SHALL BE LIMITED TO THE TOTAL AMOUNTS PAID BY CUSTOMER IN THE PRECEDING 12 MONTHS.",
      notes: "Replaced nominal $100 cap with industry-standard 12-month trailing fee cap.",
    },
    {
      id: "c3",
      section: "Section 14.4",
      title: "Governing Law & Dispute Resolution",
      risk: "LOW",
      citation: "Delaware Chancery Court Rules",
      originalText:
        "This Agreement shall be governed by the laws of England and Wales with mandatory arbitration in London.",
      proposedText:
        "This Agreement shall be governed by the laws of the State of Delaware, and the parties submit to the exclusive jurisdiction of the Delaware Court of Chancery.",
      notes: "Aligned governing law with Delaware corporate jurisdiction.",
    },
  ];

  const activeClause = clauses.find((c) => c.id === selectedClauseId) || clauses[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "10px", overflow: "hidden" }}>
      {/* Top Studio Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "var(--surface2)", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Badge color="purple">⚖️ Legal Cowork Studio</Badge>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text)" }}>{projectName} — Master Agreement Redline</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Badge color="red">⚠️ 1 High Risk Clause</Badge>
          <Badge color="amber">⚡ 1 Medium Risk</Badge>
          <div style={{ display: "flex", background: "var(--surface)", borderRadius: "6px", border: "1px solid var(--border)", padding: "2px" }}>
            <button
              onClick={() => setViewMode("split")}
              style={{
                background: viewMode === "split" ? "var(--surface2)" : "transparent",
                border: "none",
                fontSize: "12px",
                padding: "3px 8px",
                borderRadius: "4px",
                cursor: "pointer",
                color: "var(--text)",
              }}
            >
              Side-by-Side
            </button>
            <button
              onClick={() => setViewMode("unified")}
              style={{
                background: viewMode === "unified" ? "var(--surface2)" : "transparent",
                border: "none",
                fontSize: "12px",
                padding: "3px 8px",
                borderRadius: "4px",
                cursor: "pointer",
                color: "var(--text)",
              }}
            >
              Unified Diff
            </button>
          </div>
        </div>
      </div>

      {/* Main Diff Area */}
      <div style={{ display: "flex", flex: 1, minHeight: "420px", overflow: "hidden" }}>
        {/* Left Clause List */}
        <div style={{ width: "260px", borderRight: "1px solid var(--border)", background: "var(--surface)", overflowY: "auto", padding: "12px" }}>
          <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", color: "var(--text3)", marginBottom: "8px" }}>
            Contract Sections ({clauses.length})
          </div>
          {clauses.map((c) => (
            <div
              key={c.id}
              onClick={() => {
                setSelectedClauseId(c.id);
                onSelectClause?.({ title: `${c.section}: ${c.title}`, risk: c.risk, text: c.proposedText, citation: c.citation });
              }}
              style={{
                padding: "10px",
                marginBottom: "8px",
                borderRadius: "6px",
                cursor: "pointer",
                border: selectedClauseId === c.id ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: selectedClauseId === c.id ? "var(--surface2)" : "transparent",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text3)" }}>{c.section}</span>
                <Badge color={c.risk === "HIGH" ? "red" : c.risk === "MEDIUM" ? "amber" : "green"}>{c.risk}</Badge>
              </div>
              <div style={{ fontSize: "12px", fontWeight: 500, color: "var(--text)" }}>{c.title}</div>
            </div>
          ))}
        </div>

        {/* Center Comparison Area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--bg)", overflowY: "auto", padding: "16px" }}>
          <div style={{ marginBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h4 style={{ margin: "0 0 4px", fontSize: "15px", color: "var(--text)" }}>{activeClause.section}: {activeClause.title}</h4>
              <span style={{ fontSize: "12px", color: "var(--accent)" }}>Citation: {activeClause.citation}</span>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onSelectClause?.({ title: `${activeClause.section}: ${activeClause.title}`, risk: activeClause.risk, text: activeClause.proposedText, citation: activeClause.citation })}
            >
              Ask AI Coworker to Redraft
            </Button>
          </div>

          {viewMode === "split" ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", flex: 1 }}>
              <div style={{ padding: "12px", borderRadius: "6px", background: "var(--surface)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text3)", marginBottom: "8px", textTransform: "uppercase" }}>Original Clause</div>
                <div style={{ fontSize: "13px", lineHeight: "1.6", color: "var(--text2)", whiteSpace: "pre-wrap" }}>
                  {activeClause.originalText}
                </div>
              </div>
              <div style={{ padding: "12px", borderRadius: "6px", background: "rgba(34, 197, 94, 0.05)", border: "1px solid rgba(34, 197, 94, 0.3)" }}>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "#16a34a", marginBottom: "8px", textTransform: "uppercase" }}>AI Redline Proposal</div>
                <div style={{ fontSize: "13px", lineHeight: "1.6", color: "var(--text)", whiteSpace: "pre-wrap" }}>
                  {activeClause.proposedText}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: "14px", borderRadius: "6px", background: "var(--surface)", border: "1px solid var(--border)", lineHeight: "1.7", fontSize: "13px" }}>
              <div style={{ textDecoration: "line-through", color: "#dc2626", background: "rgba(220, 38, 38, 0.1)", padding: "2px 4px", borderRadius: "4px", marginBottom: "8px" }}>
                {activeClause.originalText}
              </div>
              <div style={{ color: "#16a34a", background: "rgba(34, 197, 94, 0.1)", padding: "2px 4px", borderRadius: "4px" }}>
                {activeClause.proposedText}
              </div>
            </div>
          )}

          <div style={{ marginTop: "16px", padding: "10px 14px", background: "var(--surface2)", borderRadius: "6px", border: "1px solid var(--border)" }}>
            <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text3)" }}>LEGAL RATIONALE: </span>
            <span style={{ fontSize: "12px", color: "var(--text2)" }}>{activeClause.notes}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Domain Viewport 2: SpreadsheetFormulaGrid ("Hebbia / CapForge Financial Studio") ──
export function SpreadsheetFormulaGrid({
  projectName,
}: {
  projectName: string;
}) {
  const [selectedCell, setSelectedCell] = React.useState<string>("D6");
  const formulaMap: Record<string, string> = {
    D2: "=C2*1.28 (28% YoY Growth)",
    D4: "=D2-D3",
    D6: "=D4-D5",
    D7: "=D6/D2 (EBITDA Margin: 36.2%)",
    D8: "=D6*14.5x ($34.8M Enterprise Value)",
  };

  const rows = [
    { code: "REV", label: "Total Revenue", fy23: "$4.20M", fy24: "$5.80M", fy25: "$7.42M", formula: "+27.9% YoY" },
    { code: "COGS", label: "Cost of Goods Sold (COGS)", fy23: "($1.10M)", fy24: "($1.45M)", fy25: "($1.78M)", formula: "24.0% of Rev" },
    { code: "GP", label: "Gross Profit", fy23: "$3.10M", fy24: "$4.35M", fy25: "$5.64M", formula: "76.0% Margin" },
    { code: "OPEX", label: "Operating Expenses (S&M, R&D)", fy23: "($1.90M)", fy24: "($2.40M)", fy25: "($2.95M)", formula: "39.8% of Rev" },
    { code: "ADJ_EBITDA", label: "Adjusted EBITDA (Footnote #4 Add-Backs)", fy23: "$1.45M", fy24: "$2.15M", fy25: "$2.69M", formula: "36.2% Margin" },
    { code: "EV_MULT", label: "Enterprise Valuation (at 14.5x EV/EBITDA)", fy23: "$21.0M", fy24: "$31.2M", fy25: "$39.0M", formula: "Hebbia DCF Model" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "10px", overflow: "hidden" }}>
      {/* Formula Bar Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "var(--surface2)", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Badge color="blue">📊 Financial Formula Grid</Badge>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text)" }}>{projectName} — M&A Valuation Comps</span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <Button size="sm" variant="secondary">Recalculate Grid</Button>
          <Button size="sm" variant="primary">Export SEC 10-K RAG Memo</Button>
        </div>
      </div>

      {/* Excel Formula Input Bar */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 16px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: "12px", fontWeight: 700, fontFamily: "monospace", color: "var(--accent)" }}>{selectedCell}:</span>
        <input
          type="text"
          readOnly
          value={formulaMap[selectedCell] || "=PROFORMA_MODEL(FY25E)"}
          style={{ flex: 1, padding: "4px 8px", fontSize: "12px", fontFamily: "monospace", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: "4px", color: "var(--text)" }}
        />
      </div>

      {/* Grid Table */}
      <div style={{ flex: 1, overflowX: "auto", padding: "16px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", fontFamily: "sans-serif" }}>
          <thead>
            <tr style={{ background: "var(--surface2)", borderBottom: "2px solid var(--border)", color: "var(--text3)", textAlign: "left" }}>
              <th style={{ padding: "8px 12px" }}>Financial Metric</th>
              <th style={{ padding: "8px 12px", textAlign: "right" }}>FY23 (Audited)</th>
              <th style={{ padding: "8px 12px", textAlign: "right" }}>FY24 (Reported)</th>
              <th style={{ padding: "8px 12px", textAlign: "right", color: "var(--accent)" }}>FY25E (Pro-Forma)</th>
              <th style={{ padding: "8px 12px" }}>Benchmark / Formula</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr
                key={r.code}
                onClick={() => setSelectedCell(`D${idx + 2}`)}
                style={{
                  borderBottom: "1px solid var(--border)",
                  background: selectedCell === `D${idx + 2}` ? "rgba(59, 130, 246, 0.08)" : "transparent",
                  cursor: "pointer",
                }}
              >
                <td style={{ padding: "10px 12px", fontWeight: r.code === "ADJ_EBITDA" || r.code === "EV_MULT" ? 700 : 500, color: "var(--text)" }}>
                  {r.label}
                </td>
                <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "monospace", color: "var(--text2)" }}>{r.fy23}</td>
                <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "monospace", color: "var(--text2)" }}>{r.fy24}</td>
                <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "monospace", fontWeight: 600, color: "var(--accent)" }}>{r.fy25}</td>
                <td style={{ padding: "10px 12px", fontSize: "12px", color: "var(--text3)" }}>{r.formula}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Domain Viewport 3: ClinicalSoapEditor ("Clinica AI Practice Cowork") ──
export function ClinicalSoapEditor({
  projectName,
}: {
  projectName: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "10px", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "var(--surface2)", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Badge color="green">🩺 Clinical SOAP Studio</Badge>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text)" }}>{projectName} — Encounter Note #8402</span>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <Badge color="blue">🔒 HIPAA PII Scrubber Active</Badge>
          <Button size="sm" variant="primary">Export to EHR / PDF</Button>
        </div>
      </div>

      {/* 4 SOAP Quadrants */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        {/* Subjective */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px", padding: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--accent)" }}>S · SUBJECTIVE (Patient Encounter)</span>
            <Badge color="purple">Audio Transcribed</Badge>
          </div>
          <p style={{ fontSize: "13px", color: "var(--text2)", lineHeight: "1.5", margin: 0 }}>
            48yo male presents with acute lower lumbar back pain radiating into right gluteus for 5 days post-lifting incident. Denies numbness, tingling, or bowel/bladder incontinence. Pain rated 6/10 at rest, 8/10 on lumbar flexion.
          </p>
        </div>

        {/* Objective */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px", padding: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--accent)" }}>O · OBJECTIVE (Vitals & Physical Exam)</span>
            <span style={{ fontSize: "11px", color: "var(--text3)" }}>BP: 124/82 · HR: 68</span>
          </div>
          <p style={{ fontSize: "13px", color: "var(--text2)", lineHeight: "1.5", margin: 0 }}>
            Antalgic gait favoring left side. Paraspinal tenderness over L4-L5 vertebrae. Straight leg raise positive on right at 45 degrees. DTRs 2+ symmetric patellar/Achilles. Strength 5/5 bilateral lower extremities.
          </p>
        </div>

        {/* Assessment */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px", padding: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--accent)" }}>A · ASSESSMENT & ICD-10 CODES</span>
            <Badge color="green">98% Coding Confidence</Badge>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--surface2)", padding: "6px 8px", borderRadius: "4px" }}>
              <span style={{ fontSize: "12px", fontWeight: 600 }}>M54.51 — Low back pain, lumbar region</span>
              <Badge color="blue">Primary</Badge>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--surface2)", padding: "6px 8px", borderRadius: "4px" }}>
              <span style={{ fontSize: "12px", fontWeight: 600 }}>M54.31 — Sciatica, right side</span>
              <Badge color="amber">Secondary</Badge>
            </div>
          </div>
        </div>

        {/* Plan */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px", padding: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--accent)" }}>P · PLAN & PRE-AUTHORIZATION</span>
            <Badge color="purple">CPT 99214 Level 4</Badge>
          </div>
          <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "var(--text2)", lineHeight: "1.5" }}>
            <li>Physical therapy 2x/week for 6 weeks (Lumbar stabilization).</li>
            <li>Meloxicam 15mg PO daily with food for 14 days.</li>
            <li>Lumbar MRI pre-auth request drafted if symptoms persist &gt; 3 weeks.</li>
            <li>Follow-up in clinic in 3 weeks or sooner if red flags develop.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// ── Domain Viewport 4: PlanSpecCanvas ("AcuBuild Architecture & Engineering Studio") ──
export function PlanSpecCanvas({
  projectName,
}: {
  projectName: string;
}) {
  const [selectedSpec, setSelectedSpec] = React.useState<number>(0);
  const specs = [
    { code: "IBC § 1020.2", title: "Corridor Egress Width", status: "PASS", detail: "48 inches provided vs 44 inches required for occupant load > 50." },
    { code: "ADA Title III § 604", title: "Restroom Turning Clearance", status: "PASS", detail: "60-inch circular turning radius verified on Sheet A-102." },
    { code: "IBC Table 601", title: "Fire Resistance Separation", status: "WARNING", detail: "Type II-B construction requires 2-hr rated party wall verification." },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "10px", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "var(--surface2)", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Badge color="amber">📐 PlanSpec Code Compliance</Badge>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text)" }}>{projectName} — Sheet A-101 (Main Level)</span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <Button size="sm" variant="secondary">RFP Bid Leveling Table</Button>
          <Button size="sm" variant="primary">IBC 2024 Audit Check</Button>
        </div>
      </div>

      {/* Plan Inspector Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", flex: 1, minHeight: "400px" }}>
        {/* Schematic Mock View */}
        <div style={{ background: "#1e293b", color: "#f8fafc", padding: "20px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", position: "relative" }}>
          <div style={{ border: "2px dashed #64748b", padding: "30px 40px", borderRadius: "8px", textAlign: "center", maxWidth: "420px" }}>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#38bdf8", marginBottom: "8px" }}>COMMERCIAL SUITE A-101 SCHEMATIC</div>
            <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "16px" }}>Scale: 1/4" = 1'-0" · Occupancy: Group B (Business)</div>
            <div style={{ display: "flex", justifyContent: "center", gap: "8px", flexWrap: "wrap" }}>
              <Badge color="green">📍 Point A: Egress Corridor (48" Clear)</Badge>
              <Badge color="amber">⚠️ Point B: Fire Barrier Joint</Badge>
            </div>
          </div>
        </div>

        {/* Right Compliance Checklist */}
        <div style={{ background: "var(--surface)", borderLeft: "1px solid var(--border)", padding: "14px", overflowY: "auto" }}>
          <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", color: "var(--text3)", marginBottom: "10px" }}>
            Municipal & IBC Checks ({specs.length})
          </div>
          {specs.map((s, idx) => (
            <div
              key={s.code}
              onClick={() => setSelectedSpec(idx)}
              style={{
                padding: "10px",
                marginBottom: "8px",
                borderRadius: "6px",
                cursor: "pointer",
                border: selectedSpec === idx ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: selectedSpec === idx ? "var(--surface2)" : "transparent",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--accent)" }}>{s.code}</span>
                <Badge color={s.status === "PASS" ? "green" : "amber"}>{s.status}</Badge>
              </div>
              <div style={{ fontSize: "12px", fontWeight: 500, color: "var(--text)" }}>{s.title}</div>
              <div style={{ fontSize: "11px", color: "var(--text3)", marginTop: "4px" }}>{s.detail}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function money(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100);
}

// F-40: WalletLedgerPanel — the natively-built panel for kind='wallet'. Looks like a bank-account
// ledger (balance + lifetime cuts + transactions), NOT a generic registry-driven component.
function WalletLedgerPanel({ spaceId, creds }: { spaceId: string; creds: Creds }) {
  const [wallet, setWallet] = React.useState<BusinessWallet | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    getBusinessWallet(spaceId, creds).then(setWallet).catch(() => setWallet(null)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);
  if (loading) return <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading wallet…</p>;
  if (!wallet) return <p style={{ color: "var(--text3)", fontSize: 13 }}>Wallet unavailable.</p>;
  return (
    <div className="settings-block">
      <div className="settings-row">
        <div>
          <div className="settings-row-label">Available to grow the business</div>
          <div className="settings-row-sub">Your AI only spends money this business has earned.</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="settings-row-label">{money(wallet.available_balance_cents, wallet.currency)}</div>
          <div className="settings-row-sub">{wallet.currency}</div>
        </div>
      </div>
      <div className="settings-row">
        <div>
          <div className="settings-row-label">Lifetime earned</div>
          <div className="settings-row-sub">{wallet.lifetime.order_count} settled order(s)</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="settings-row-label">{money(wallet.lifetime.gross_cents)} gross</div>
          <div className="settings-row-sub">
            {money(wallet.lifetime.naelao_cut_cents)} Naelao cut
            {wallet.lifetime.builder_cut_cents > 0 ? ` · ${money(wallet.lifetime.builder_cut_cents)} builder cut` : ""}
          </div>
        </div>
      </div>
      {wallet.transactions.slice(0, 10).map((t) => (
        <div className="settings-row" key={t.id}>
          <div>
            <div className="settings-row-label">{t.reason.replace(/_/g, " ")}</div>
            <div className="settings-row-sub">{new Date(t.created_at).toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="settings-row-label">{t.delta_cents >= 0 ? "+" : ""}{money(t.delta_cents)}</div>
            <div className="settings-row-sub">bal {money(t.balance_after_cents)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// F-39 UI: read-only workspace file viewer — lists a project's R2 artifacts; clicking an .html file
// previews it in a sandboxed iframe, other text shows inline.
function WorkspaceFilesPanel({ spaceId, projectId, creds }: { spaceId: string; projectId: string; creds: Creds }) {
  const [files, setFiles] = React.useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState<WorkspaceFileContent | null>(null);
  React.useEffect(() => {
    listWorkspaceFiles(spaceId, projectId, creds).then(setFiles).catch(() => setFiles([])).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, projectId]);

  async function openFile(path: string) {
    try { setOpen(await readWorkspaceFile(spaceId, projectId, path, creds)); }
    catch { setOpen({ path, content: "(could not read file)" }); }
  }

  if (loading) return <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading files…</p>;
  if (files.length === 0) return <p style={{ color: "var(--text3)", fontSize: 13 }}>No files in this project's workspace yet — your agent's generated artifacts appear here.</p>;
  return (
    <>
      <div className="settings-block">
        {files.map((f) => (
          <div className="settings-row" key={f.path}>
            <div>
              <div className="settings-row-label">{f.path}</div>
              <div className="settings-row-sub">{(f.size / 1024).toFixed(1)} KB · {new Date(f.uploaded).toLocaleDateString()}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => openFile(f.path)}>View</Button>
          </div>
        ))}
      </div>
      {open && (
        <div className="settings-block" style={{ marginTop: 12, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>{open.path}</strong>
            <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Close</Button>
          </div>
          {/* Step 4: multi-format viewer (PDF, images, Word/Excel, text/html/markdown/csv). */}
          <FileViewer file={open} />
        </div>
      )}
    </>
  );
}

// CRM Pipeline & Deals Panel
function CrmPipelinePanel({ projectName }: { projectName?: string }) {
  const deals = [
    { id: "1", name: "Acme Corp Expansion", value: "$45,000", stage: "Proposal Sent", contact: "sarah@acme.com", prob: "70%" },
    { id: "2", name: "TechFlow Pilot Integration", value: "$12,000", stage: "Discovery Call", contact: "david@techflow.io", prob: "40%" },
    { id: "3", name: "Apex Global Retainer", value: "$96,000", stage: "Contract Redline", contact: "legal@apex.org", prob: "90%" },
  ];
  return (
    <div className="settings-block">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <strong style={{ fontSize: 14 }}>{projectName || "B2B Sales Pipeline"}</strong>
        <span className="app-card-tag" style={{ background: "#22c55e22", color: "#16a34a" }}>3 Active Deals</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        {deals.map((d) => (
          <div key={d.id} className="card" style={{ padding: 12, background: "var(--bg-subtle, #f9fafb)" }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{d.name}</div>
            <div style={{ fontSize: 16, fontWeight: 700, margin: "6px 0", color: "#16a34a" }}>{d.value}</div>
            <div style={{ fontSize: 12, color: "var(--text3)" }}>{d.contact}</div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: "var(--text2)" }}>
              <span>{d.stage}</span>
              <span>{d.prob} prob</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Support Ticketing & SLA Queue
function SupportTicketsPanel({ projectName }: { projectName?: string }) {
  const tickets = [
    { id: "T-101", customer: "John Doe", subject: "Webhook verification signature failing", priority: "HIGH", sla: "45m remaining", status: "Open" },
    { id: "T-102", customer: "Elena Rostova", subject: "Invoice PDF download link expired", priority: "MED", sla: "3h remaining", status: "In Progress" },
  ];
  return (
    <div className="settings-block">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <strong style={{ fontSize: 14 }}>{projectName || "Customer Support Queue"}</strong>
        <span className="app-card-tag" style={{ background: "#3b82f622", color: "#2563eb" }}>SLA Tracking Active</span>
      </div>
      {tickets.map((t) => (
        <div key={t.id} className="settings-row">
          <div>
            <div className="settings-row-label">[{t.id}] {t.subject}</div>
            <div className="settings-row-sub">{t.customer} · Priority: {t.priority} · {t.sla}</div>
          </div>
          <span className="app-card-tag">{t.status}</span>
        </div>
      ))}
    </div>
  );
}

// Storefront Products & Delivery Catalog
function StorefrontCatalogPanel({ projectName }: { projectName?: string }) {
  const products = [
    { id: "P-1", title: "Enterprise SaaS Legal Boilerplate Pack", price: "$149", sales: 28, inventory: "Unlimited Digital" },
    { id: "P-2", title: "Astro + Tailwind Startup Template", price: "$49", sales: 84, inventory: "Instant Download" },
  ];
  return (
    <div className="settings-block">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <strong style={{ fontSize: 14 }}>{projectName || "Digital Products Catalog"}</strong>
        <span className="app-card-tag" style={{ background: "#8b5cf622", color: "#7c3aed" }}>Live Fulfillment</span>
      </div>
      {products.map((p) => (
        <div key={p.id} className="settings-row">
          <div>
            <div className="settings-row-label">{p.title}</div>
            <div className="settings-row-sub">{p.sales} sales settled · {p.inventory}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="settings-row-label">{p.price}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// AI-Triaged Email Box
function BusinessEmailPanel({ projectName }: { projectName?: string }) {
  const emails = [
    { id: "E-1", from: "partnerships@cloudcorp.com", subject: "Q3 Partnership Inquiry & API Whitelisting", category: "High Value Lead", time: "12m ago" },
    { id: "E-2", from: "billing@vendor.io", subject: "Monthly Cloud Infrastructure Statement", category: "Receipt / Finance", time: "2h ago" },
  ];
  return (
    <div className="settings-block">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <strong style={{ fontSize: 14 }}>{projectName || "AI Triaged Inbox"}</strong>
        <span className="app-card-tag" style={{ background: "#06b6d422", color: "#0891b2" }}>Autonomous Defense</span>
      </div>
      {emails.map((e) => (
        <div key={e.id} className="settings-row">
          <div>
            <div className="settings-row-label">{e.subject}</div>
            <div className="settings-row-sub">{e.from} · {e.time}</div>
          </div>
          <span className="app-card-tag">{e.category}</span>
        </div>
      ))}
    </div>
  );
}

// Customer Bot Channel & Ladder Firewall
function CustomerBotFirewallPanel({ project }: { project: Project }) {
  return (
    <div className="settings-block">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <strong style={{ fontSize: 14 }}>{project.name || "Customer Inbound Bot"}</strong>
        <span className="app-card-tag" style={{ background: "#f59e0b22", color: "#d97706" }}>Execution Ceiling: Tier {project.execution_ceiling ?? 2}</span>
      </div>
      <div className="settings-row">
        <div>
          <div className="settings-row-label">Capability Firewall Active</div>
          <div className="settings-row-sub">Customer-facing inputs are restricted to in-memory RAG, Knowledge Base, and notifications. Container, Shell, and Admin tools are strictly blocked.</div>
        </div>
      </div>
      <div className="settings-row">
        <div>
          <div className="settings-row-label">Daily Spend Cap</div>
          <div className="settings-row-sub">Maximum daily credits allowed before graceful fallback</div>
        </div>
        <div className="settings-row-label">{project.daily_spend_cap_credits || 2000} credits</div>
      </div>
    </div>
  );
}

// Enterprise Model Studio & Auto-Researcher Canvas
export function ModelStudioCanvas({ projectName }: { projectName?: string }) {
  const [testPrompt, setTestPrompt] = React.useState("What is our enterprise refund and cancellation SLA?");
  const [isPublished, setIsPublished] = React.useState(true);

  return (
    <div className="settings-block" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header & Status Banner */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>🧠</span>
            <strong style={{ fontSize: 15, color: "var(--text)" }}>
              MODEL STUDIO: &ldquo;{projectName || "Acme Support Llama-8B (v1.2)"}&rdquo;
            </strong>
          </div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>
            Cloudflare Workers AI LoRA Adapter &bull; Base Model: <code>@cf/meta/llama-3.1-8b-instruct</code>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="app-card-tag" style={{ background: "#22c55e22", color: "#16a34a", fontWeight: 700, padding: "4px 8px" }}>
            COMPLETED &amp; DEPLOYED
          </span>
          <span className="app-card-tag" style={{ background: "var(--accent-dim)", color: "var(--accent)", fontWeight: 700, padding: "4px 8px" }}>
            🎯 Eval Accuracy: 96.4%
          </span>
        </div>
      </div>

      {/* Dataset & Synthesis Pipeline */}
      <div className="card" style={{ padding: 14, background: "var(--bg-subtle, #f9fafb)", borderRadius: "var(--radius-sm)" }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text3)", marginBottom: 8 }}>
          📁 Dataset &amp; Edge Synthesis Pipeline
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, fontSize: 13 }}>
          <div style={{ borderLeft: "3px solid var(--accent)", paddingLeft: 8 }}>
            <div style={{ fontWeight: 600, color: "var(--text)" }}>Raw Ingested Documents</div>
            <div style={{ color: "var(--text3)", fontSize: 12 }}>142 files (PDFs, Markdown, Zendesk CSVs)</div>
          </div>
          <div style={{ borderLeft: "3px solid #16a34a", paddingLeft: 8 }}>
            <div style={{ fontWeight: 600, color: "var(--text)" }}>Synthesized Training Pairs</div>
            <div style={{ color: "var(--text3)", fontSize: 12 }}>8,420 JSONL prompt-completion pairs</div>
          </div>
          <div style={{ borderLeft: "3px solid #8b5cf6", paddingLeft: 8 }}>
            <div style={{ fontWeight: 600, color: "var(--text)" }}>Validation Split</div>
            <div style={{ color: "var(--text3)", fontSize: 12 }}>1,000 test cases (Zero contamination)</div>
          </div>
        </div>
      </div>

      {/* Training Loss Curve Graph */}
      <div className="card" style={{ padding: 14, background: "var(--bg-subtle, #f9fafb)", borderRadius: "var(--radius-sm)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text3)" }}>
            📈 Training Loss Curve
          </div>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#16a34a" }}>
            Loss: 2.4 &rarr; 1.8 &rarr; 1.1 &rarr; 0.42 (Converged at Epoch 3)
          </span>
        </div>
        <div style={{ height: 60, display: "flex", alignItems: "flex-end", gap: 6, padding: "8px 0" }}>
          {[
            { step: "E1.1", loss: 2.40, height: 95 },
            { step: "E1.2", loss: 2.15, height: 85 },
            { step: "E1.3", loss: 1.82, height: 72 },
            { step: "E2.1", loss: 1.54, height: 61 },
            { step: "E2.2", loss: 1.25, height: 50 },
            { step: "E2.3", loss: 1.08, height: 43 },
            { step: "E3.1", loss: 0.76, height: 30 },
            { step: "E3.2", loss: 0.53, height: 21 },
            { step: "E3.3", loss: 0.42, height: 16 },
          ].map((pt, i) => (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div
                style={{
                  width: "100%",
                  height: `${pt.height}%`,
                  background: i >= 6 ? "var(--accent)" : "var(--border)",
                  borderRadius: 3,
                  transition: "height 0.3s ease",
                }}
                title={`Step ${pt.step}: Loss ${pt.loss}`}
              />
              <span style={{ fontSize: 9.5, color: "var(--text3)" }}>{pt.step}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Side-by-Side Verification Playground */}
      <div className="card" style={{ padding: 14, background: "var(--bg-subtle, #f9fafb)", borderRadius: "var(--radius-sm)" }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text3)", marginBottom: 8 }}>
          🧪 Side-by-Side Verification Playground
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 500, display: "block", marginBottom: 4 }}>
            Evaluation Benchmark Prompt:
          </label>
          <input
            type="text"
            value={testPrompt}
            onChange={(e) => setTestPrompt(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 13,
            }}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {/* Base Model */}
          <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, background: "var(--surface)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", marginBottom: 6 }}>
              Base Llama 3.1 8B (Default)
            </div>
            <p style={{ fontSize: 12.5, color: "var(--text2)", margin: 0, lineHeight: 1.5 }}>
              &ldquo;Our standard refund policy is generally 30 days depending on customer terms. Please refer to support for more details regarding account cancellations.&rdquo;
            </p>
            <div style={{ marginTop: 8, fontSize: 10.5, color: "var(--text3)" }}>
              ⚠️ Generic response &bull; No company SLA grounding
            </div>
          </div>

          {/* Custom Fine-Tuned Model */}
          <div style={{ border: "1px solid var(--accent)", borderRadius: 6, padding: 10, background: "var(--surface)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase" }}>
                Custom Fine-Tuned Model (v1.2)
              </span>
              <span style={{ fontSize: 10, background: "#22c55e22", color: "#16a34a", padding: "1px 5px", borderRadius: 4, fontWeight: 600 }}>
                100% Policy Match
              </span>
            </div>
            <p style={{ fontSize: 12.5, color: "var(--text)", margin: 0, lineHeight: 1.5, fontWeight: 500 }}>
              &ldquo;Per Acme Policy #402, enterprise subscriptions have a 14-day SLA with automated prorated credit calculations and tier-1 ticket escalation.&rdquo;
            </p>
            <div style={{ marginTop: 8, fontSize: 10.5, color: "#16a34a", fontWeight: 600 }}>
              ✓ Exact policy citation &bull; Verified zero hallucination
            </div>
          </div>
        </div>
      </div>

      {/* Model Registry & Distribution Toggle */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 4px" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--text)" }}>
          <input
            type="checkbox"
            checked={isPublished}
            onChange={(e) => setIsPublished(e.target.checked)}
            style={{ accentColor: "var(--accent)", width: 16, height: 16 }}
          />
          <span>
            <strong>Published to Company Model Picker</strong> (Available across all team threads as <code>custom/acme-support-v1-2</code>)
          </span>
        </label>
        <span style={{ fontSize: 11, color: "var(--text3)" }}>LoRA Weight: 28.4 MB on Cloudflare R2</span>
      </div>
    </div>
  );
}

/**
 * F-40: the mount point. A SWITCH on project.kind (never a data-driven interchangeable lookup) —
 * each kind's panel is its own purpose-built component. A kind with no panel yet renders nothing
 * (the shared project shell alone), which is the expected incremental-build path. The Files viewer
 * (F-39) is shown for every kind since every project has a workspace.
 */
export function ProjectKindPanel({
  project,
  spaceId,
  creds,
  onSelectElement,
}: {
  project: Project;
  spaceId: string;
  creds: Creds;
  onSelectElement?: (elem: InspectedElement) => void;
}) {
  if (project.kind === "product_dev") {
    const previewUrl = `https://${(project.name || "preview").toLowerCase().replace(/[^a-z0-9-]/g, "-")}.edgepreview.app`;
    return <VisualCanvasViewer previewUrl={previewUrl} onSelectElement={onSelectElement} />;
  }

  if (project.kind === "contract_redline" || project.kind === "litigation_discovery" || project.kind === "legal_compliance") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <DocumentRedlineCanvas
          projectName={project.name}
          onSelectClause={(c) => {
            onSelectElement?.({
              filePath: `contracts/${project.slug || "agreement"}.md`,
              selector: c.title,
              text: `[${c.risk} RISK] ${c.text} (Citation: ${c.citation})`,
            });
          }}
        />
        <div className="section-label">Workspace Files & Exhibits</div>
        <WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} />
      </div>
    );
  }

  if (project.kind === "sec_rag" || project.kind === "memo_studio") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <SpreadsheetFormulaGrid projectName={project.name} />
        <div className="section-label">SEC Filings & Worksheets</div>
        <WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} />
      </div>
    );
  }

  if (project.kind === "soap_notes" || project.kind === "billing_icd10") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <ClinicalSoapEditor projectName={project.name} />
        <div className="section-label">EHR Charts & Transcripts</div>
        <WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} />
      </div>
    );
  }

  if (project.kind === "building_code_rag" || project.kind === "subcontractor_rfp") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <PlanSpecCanvas projectName={project.name} />
        <div className="section-label">Blueprints & Subcontractor Submittals</div>
        <WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} />
      </div>
    );
  }

  if (project.kind === "crm") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <CrmPipelinePanel projectName={project.name} />
        <div className="section-label">Contacts & Deal Files</div>
        <WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} />
      </div>
    );
  }

  if (project.kind === "support_inbox") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <SupportTicketsPanel projectName={project.name} />
        <div className="section-label">Support Attachments & Knowledge Base</div>
        <WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} />
      </div>
    );
  }

  if (project.kind === "storefront") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <StorefrontCatalogPanel projectName={project.name} />
        <div className="section-label">Digital Assets & Downloads</div>
        <WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} />
      </div>
    );
  }

  if (project.kind === "business_email") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <BusinessEmailPanel projectName={project.name} />
        <div className="section-label">Email Attachments</div>
        <WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} />
      </div>
    );
  }

  if (project.kind === "customer_bot") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <CustomerBotFirewallPanel project={project} />
        <div className="section-label">Customer Bot Assets & FAQs</div>
        <WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} />
      </div>
    );
  }

  if (project.kind === "model_studio") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <ModelStudioCanvas projectName={project.name} />
        <div className="section-label">Dataset Documents & LoRA Artifacts</div>
        <WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} />
      </div>
    );
  }

  return (
    <>
      {project.kind === "wallet" && (
        <>
          <div className="section-label">Wallet</div>
          <WalletLedgerPanel spaceId={spaceId} creds={creds} />
        </>
      )}

      <div className="section-label" style={{ marginTop: 24 }}>Files</div>
      <WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} />
    </>
  );
}
