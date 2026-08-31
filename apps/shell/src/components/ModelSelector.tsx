"use client";

// A Claude-Code-style model + capability config picker for the chat input bar: pick a model, and
// — only for the models that actually support it (billing-core's MODEL_CAPABILITIES, researched
// per-model against Cloudflare's own Workers AI docs; see that file's header for what's confirmed
// vs. inferred) — a reasoning-effort/thinking control. A model with no configurable reasoning mode
// (most of them, including the account's actual working default, Llama 3.3) simply shows no such
// control, rather than a dead/disabled one.

import * as React from "react";
import { ALLOWED_MODELS, capabilityForModel, type VerticalModelPolicy } from "@naelao/billing-core";

const MODEL_LABELS: Record<string, string> = {
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-8": "Claude Opus 4.8",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "Llama 3.3 70B",
  "@cf/meta/llama-4-scout-17b-16e-instruct": "Llama 4 Scout",
  "@cf/openai/gpt-oss-120b": "GPT-OSS 120B",
  "@cf/openai/gpt-oss-20b": "GPT-OSS 20B",
  "@cf/qwen/qwen3-30b-a3b-fp8": "Qwen3 30B",
  "@cf/mistralai/mistral-small-3.1-24b-instruct": "Mistral Small 3.1",
  "@cf/ibm-granite/granite-4.0-h-micro": "Granite 4.0 Micro",
  "@cf/google/gemma-4-26b-a4b-it": "Gemma 4 26B",
  "@cf/zai-org/glm-4.7-flash": "GLM 4.7 Flash",
  "@cf/zai-org/glm-5.2": "GLM 5.2",
  "@cf/nvidia/nemotron-3-120b-a12b": "Nemotron 3 120B",
  "@cf/moonshotai/kimi-k2.6": "Kimi K2.6",
  "@cf/moonshotai/kimi-k2.7-code": "Kimi K2.7 Code",
  "google-ai-studio/gemini-flash-lite-latest": "Gemini Flash-Lite",
  "google-ai-studio/gemini-flash-latest": "Gemini Flash",
  "google-ai-studio/gemini-pro-latest": "Gemini Pro",
  "google-ai-studio/gemini-3.7-flash": "Gemini 3.7 Flash",
  "google-ai-studio/gemini-3.6-flash": "Gemini 3.6 Flash",
  "google-ai-studio/gemini-3.5-flash": "Gemini 3.5 Flash",
  "google-ai-studio/gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
  "custom/acme-support-v1-2": "Acme Support Llama-8B (v1.2)",
  "custom/acme-legal-redline": "Acme Legal Redline Specialist",
  "custom/hospital-clinical-llama8b-v1": "Clinica Hospital Llama-8B (Clinical LoRA)",
  "custom/lexpulse-delaware-legal-v2": "LexPulse Delaware Legal Specialist (v2)",
};

export interface CustomCompanyModel {
  id: string;
  name: string;
  description: string;
  trainedOn: string;
  accuracy: string;
}

export const DEFAULT_COMPANY_MODELS: CustomCompanyModel[] = [
  {
    id: "custom/acme-support-v1-2",
    name: "Acme Support Llama-8B (v1.2)",
    description: "Fine-tuned customer support model with SLA & policy grounding",
    trainedOn: "142 docs (PDFs, Markdown, Zendesk CSVs)",
    accuracy: "96.4%",
  },
  {
    id: "custom/acme-legal-redline",
    name: "Acme Legal Redline Specialist",
    description: "Specialized in M&A terms, indemnity exceptions & liability clauses",
    trainedOn: "85 negotiated agreements & standard playbooks",
    accuracy: "98.1%",
  },
  {
    id: "custom/hospital-clinical-llama8b-v1",
    name: "Clinica Hospital Llama-8B (Clinical LoRA)",
    description: "HIPAA-vetted clinical SOAP notes and ICD-10/CPT coding specialist",
    trainedOn: "450 anonymized clinical encounter charts & CMS billing guides",
    accuracy: "99.2%",
  },
  {
    id: "custom/lexpulse-delaware-legal-v2",
    name: "LexPulse Delaware Legal Specialist (v2)",
    description: "Delaware Chancery Court case law and DGCL corporate governance",
    trainedOn: "Delaware Code Title 8 & 1,200 Chancery opinions",
    accuracy: "97.8%",
  },
];

export function modelLabel(model: string): string {
  if (model.startsWith("custom/")) {
    const matched = DEFAULT_COMPANY_MODELS.find((c) => c.id === model);
    if (matched) return matched.name;
    const clean = model.replace(/^custom\//, "").replace(/-/g, " ");
    return `🧠 ${clean.charAt(0).toUpperCase() + clean.slice(1)}`;
  }
  return MODEL_LABELS[model] ?? model;
}

const LEVEL_LABELS: Record<string, string> = {
  off: "Off", on: "On", low: "Low", medium: "Medium", high: "High", max: "Max",
};

export function ModelSelector({
  model,
  reasoningLevel,
  modelPolicy,
  onChange,
}: {
  model: string;
  reasoningLevel: string | null;
  /** Vertical model policy restricting or curating allowed models */
  modelPolicy?: VerticalModelPolicy | null;
  /** Called whenever either the model or the reasoning level changes. Switching model always
   *  re-picks a level (the first one the new model offers, or null when it offers none) — a level
   *  chosen for the PREVIOUS model may not even be valid for the new one. */
  onChange: (model: string, reasoningLevel: string | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const capability = capabilityForModel(model);

  React.useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const isWhitelist = modelPolicy?.mode === "whitelist_only";
  const allowedSet = React.useMemo(() => {
    return isWhitelist && modelPolicy?.allowedModelIds ? new Set(modelPolicy.allowedModelIds) : null;
  }, [isWhitelist, modelPolicy]);

  const filteredCompanyModels = React.useMemo(() => {
    if (!allowedSet) return DEFAULT_COMPANY_MODELS;
    return DEFAULT_COMPANY_MODELS.filter((cm) => allowedSet.has(cm.id));
  }, [allowedSet]);

  const filteredFoundationModels = React.useMemo(() => {
    if (!allowedSet) return ALLOWED_MODELS.filter((m) => !m.startsWith("custom/"));
    return ALLOWED_MODELS.filter((m) => allowedSet.has(m) && !m.startsWith("custom/"));
  }, [allowedSet]);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Model and reasoning effort"
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px",
          borderRadius: 999, border: "1px solid var(--border)", background: "transparent",
          color: "var(--text2)", fontSize: 12.5, fontWeight: 500, cursor: "pointer",
        }}
      >
        <span>{modelLabel(model)}</span>
        {isWhitelist && (
          <span
            style={{
              fontSize: 10, color: "#16a34a", background: "#22c55e18",
              borderRadius: 4, padding: "1px 5px", fontWeight: 600,
            }}
          >
            🔒 Vetted
          </span>
        )}
        {capability.reasoningLevels.length > 0 && reasoningLevel && (
          <span
            style={{
              fontSize: 10.5, color: "var(--accent)", background: "var(--accent-dim)",
              borderRadius: 6, padding: "1px 6px", fontWeight: 600,
            }}
          >
            {LEVEL_LABELS[reasoningLevel] ?? reasoningLevel}
          </span>
        )}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M3 4.5L6 7.5L9 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute", bottom: "calc(100% + 6px)", left: 0, minWidth: 280,
            maxHeight: 380, overflowY: "auto", background: "var(--surface)",
            border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow-md)", zIndex: 40, padding: 6,
          }}
        >
          {isWhitelist && (
            <div
              style={{
                fontSize: 11, fontWeight: 700, color: "var(--accent)",
                padding: "6px 8px 6px", borderBottom: "1px solid var(--border)",
                marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "space-between",
              }}
            >
              <span>{modelPolicy?.pickerHeaderLabel ?? "🏥 Clinically Vetted Models"}</span>
              {modelPolicy?.lockedByCompliancePolicy && (
                <span style={{ fontSize: 9.5, color: "var(--text3)", background: "var(--border)", padding: "1px 4px", borderRadius: 3 }}>
                  🔒 Compliance Locked
                </span>
              )}
            </div>
          )}

          {filteredCompanyModels.length > 0 && (
            <>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 0.5, padding: "4px 8px 4px", display: "flex", alignItems: "center", gap: 5 }}>
                <span>🌟</span> {isWhitelist ? "VERTICAL FINE-TUNED SPECIALISTS" : "COMPANY FINE-TUNED MODELS (Private LoRA)"}
              </div>
              {filteredCompanyModels.map((cm) => (
                <button
                  key={cm.id}
                  type="button"
                  onClick={() => {
                    onChange(cm.id, null);
                  }}
                  style={{
                    display: "flex", width: "100%", flexDirection: "column", alignItems: "flex-start",
                    gap: 2, padding: "6px 8px", borderRadius: 8, border: "none",
                    background: cm.id === model ? "var(--accent-dim)" : "transparent",
                    color: "var(--text)", fontSize: 12.5, cursor: "pointer", textAlign: "left",
                  }}
                >
                  <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 600 }}>{cm.name}</span>
                    <span style={{ fontSize: 10, background: "#22c55e22", color: "#16a34a", padding: "1px 5px", borderRadius: 4, fontWeight: 600 }}>{cm.accuracy} eval</span>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--text3)" }}>{cm.trainedOn}</span>
                </button>
              ))}
            </>
          )}

          <div style={{ height: 1, background: "var(--border)", margin: "6px 4px" }} />
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5, padding: "4px 8px", display: "flex", alignItems: "center", gap: 5 }}>
            <span>🌐</span> {isWhitelist ? "AUTHORIZED FOUNDATION MODELS" : "FOUNDATION EDGE MODELS"}
          </div>
          {filteredFoundationModels.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                const cap = capabilityForModel(m);
                onChange(m, cap.reasoningLevels.length > 0 ? (cap.reasoningLevels[0] ?? null) : null);
              }}
              style={{
                display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between",
                gap: 8, padding: "7px 8px", borderRadius: 8, border: "none",
                background: m === model ? "var(--accent-dim)" : "transparent",
                color: "var(--text)", fontSize: 13, cursor: "pointer", textAlign: "left",
              }}
            >
              <span>{modelLabel(m)}</span>
              {m === model && <span style={{ color: "var(--accent)" }}>✓</span>}
            </button>
          ))}

          {capability.reasoningLevels.length > 0 ? (
            <>
              <div style={{ height: 1, background: "var(--border)", margin: "6px 4px" }} />
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4, padding: "4px 8px" }}>
                Reasoning effort
              </div>
              <div style={{ display: "flex", gap: 4, padding: "2px 8px 6px" }}>
                {capability.reasoningLevels.map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => onChange(model, level)}
                    style={{
                      flex: 1, padding: "6px 0", borderRadius: 7,
                      border: `1px solid ${level === reasoningLevel ? "var(--accent)" : "var(--border)"}`,
                      background: level === reasoningLevel ? "var(--accent-dim)" : "transparent",
                      color: level === reasoningLevel ? "var(--accent)" : "var(--text2)",
                      fontSize: 12, fontWeight: 500, cursor: "pointer",
                    }}
                  >
                    {LEVEL_LABELS[level] ?? level}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11.5, color: "var(--text3)", padding: "6px 8px 4px" }}>
              This model has no configurable reasoning mode.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

