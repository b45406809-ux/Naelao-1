"use client";

// A Claude-Code-style model + capability config picker for the chat input bar: pick a model, and
// — only for the models that actually support it (billing-core's MODEL_CAPABILITIES, researched
// per-model against Cloudflare's own Workers AI docs; see that file's header for what's confirmed
// vs. inferred) — a reasoning-effort/thinking control. A model with no configurable reasoning mode
// (most of them, including the account's actual working default, Llama 3.3) simply shows no such
// control, rather than a dead/disabled one.

import * as React from "react";
import { ALLOWED_MODELS, capabilityForModel } from "@naelao/billing-core";

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
};

export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}

const LEVEL_LABELS: Record<string, string> = {
  off: "Off", on: "On", low: "Low", medium: "Medium", high: "High", max: "Max",
};

export function ModelSelector({
  model,
  reasoningLevel,
  onChange,
}: {
  model: string;
  reasoningLevel: string | null;
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
            position: "absolute", bottom: "calc(100% + 6px)", left: 0, minWidth: 250,
            maxHeight: 340, overflowY: "auto", background: "var(--surface)",
            border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow-md)", zIndex: 40, padding: 6,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4, padding: "4px 8px" }}>
            Model
          </div>
          {ALLOWED_MODELS.map((m) => (
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
