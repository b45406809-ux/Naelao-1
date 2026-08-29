"use client";

import { useState } from "react";
import {
  exportSpaceTemplate,
  type SessionCredentials,
  type ExportTemplateResult,
} from "../lib/api";

interface ExportTemplateModalProps {
  spaceId: string;
  spaceName: string;
  session: SessionCredentials;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (result: ExportTemplateResult) => void;
}

export function ExportTemplateModal({
  spaceId,
  spaceName,
  session,
  isOpen,
  onClose,
  onSuccess,
}: ExportTemplateModalProps) {
  const [templateTitle, setTemplateTitle] = useState(`${spaceName} Turnkey Template`);
  const [description, setDescription] = useState(
    "Pre-configured vertical AI workspace with specialized agents, triggers, and automated task workflows."
  );
  const [category, setCategory] = useState("LEGAL");
  const [pricingModel, setPricingModel] = useState<"free" | "one_time" | "recurring_monthly" | "gmv_royalty">("one_time");
  const [priceDollars, setPriceDollars] = useState(99);
  const [royaltyPercent, setRoyaltyPercent] = useState(2.5);
  const [tagsInput, setTagsInput] = useState("turnkey, automated, ai-cowork");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportTemplateResult | null>(null);

  if (!isOpen) return null;

  async function handleExport() {
    setError(null);
    setLoading(true);
    try {
      const priceCents = pricingModel === "free" ? 0 : Math.round(priceDollars * 100);
      const royaltyBps = pricingModel === "gmv_royalty" ? Math.round(royaltyPercent * 100) : 0;
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);

      const res = await exportSpaceTemplate(
        spaceId,
        {
          templateTitle,
          description,
          category,
          pricingModel,
          priceCents,
          royaltyShareBps: royaltyBps,
          tags,
        },
        session
      );

      setResult(res);
      onSuccess?.(res);
    } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      setError(err?.message || "Failed to compile and publish template.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div id="export-template-modal-overlay" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div id="export-template-modal" className="relative w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-100 pb-4 dark:border-zinc-800">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              Venture Exporter
            </span>
            <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
              Export Space as Marketplace Template
            </h2>
          </div>
          <button
            id="export-template-close-btn"
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            ✕
          </button>
        </div>

        {/* Success View */}
        {result ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-emerald-800 dark:text-emerald-200">
              <div className="flex items-center gap-2">
                <span className="text-xl">✓</span>
                <span className="font-bold">Published to Marketplace Successfully!</span>
              </div>
              <p className="mt-1 text-sm">{result.message}</p>
            </div>

            <div className="grid grid-cols-2 gap-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-800/50">
              <div>
                <div className="text-xs text-zinc-500">Security Review Status</div>
                <div className="mt-1 flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                  {result.securityStatus.toUpperCase()}
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-500">Automated Safety Score</div>
                <div className="mt-1 text-lg font-bold text-zinc-900 dark:text-zinc-100">
                  {result.safetyScore} / 100
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 p-4 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              <div className="font-semibold text-zinc-800 dark:text-zinc-200">PII & Credential Scrubbing Summary</div>
              <ul className="mt-2 list-disc pl-4 space-y-1">
                <li>All live customer emails replaced with template author placeholders.</li>
                <li>Stripe, Whop, and Lemon Squeezy API keys scrubbed and replaced with vault credentials.</li>
                <li>Bearer tokens, JWTs, and phone numbers successfully sanitized.</li>
                <li>Revenue share rails configured (80% creator earnings, 20% platform take-rate).</li>
              </ul>
            </div>

            <div className="flex justify-end pt-4">
              <button
                id="export-template-done-btn"
                onClick={onClose}
                className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          /* Form View */
          <div className="mt-6 space-y-4 text-sm">
            {error && (
              <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-rose-700 dark:text-rose-300">
                {error}
              </div>
            )}

            {/* Template Title */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Template Title
              </label>
              <input
                id="export-template-title-input"
                type="text"
                value={templateTitle}
                onChange={(e) => setTemplateTitle(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-white px-3.5 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                placeholder="e.g. Turnkey M&A Contract Redline Studio"
              />
            </div>

            {/* Category & Tags */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Marketplace Category
                </label>
                <select
                  id="export-template-category-select"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-white px-3.5 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                >
                  <option value="LEGAL">Legal & Compliance</option>
                  <option value="FINANCE">Finance & Accounting</option>
                  <option value="HEALTHCARE">Healthcare & MedTech</option>
                  <option value="ENGINEERING">Architecture & Engineering</option>
                  <option value="AGENCY">Digital Agency & Growth</option>
                  <option value="COMMERCE">E-Commerce & Retail</option>
                  <option value="OTHER">General Productivity</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Search Tags
                </label>
                <input
                  id="export-template-tags-input"
                  type="text"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-white px-3.5 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                  placeholder="e.g. legal, redline, sec-rag"
                />
              </div>
            </div>

            {/* Pricing Model */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Monetization Model
              </label>
              <div className="mt-2 grid grid-cols-4 gap-2">
                {[
                  { id: "free", label: "Free / Open", desc: "No fee" },
                  { id: "one_time", label: "One-Time", desc: "Perpetual license" },
                  { id: "recurring_monthly", label: "Monthly Sub", desc: "Recurring MRR" },
                  { id: "gmv_royalty", label: "GMV Royalty", desc: "% of licensee revenue" },
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setPricingModel(m.id as any)}
                    className={`rounded-xl border p-2.5 text-left transition ${
                      pricingModel === m.id
                        ? "border-emerald-500 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200"
                        : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
                    }`}
                  >
                    <div className="text-xs font-bold">{m.label}</div>
                    <div className="mt-0.5 text-[10px] text-zinc-500">{m.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Pricing Amount */}
            {pricingModel !== "free" && pricingModel !== "gmv_royalty" && (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Price (USD)
                </label>
                <div className="relative mt-1.5 flex items-center">
                  <span className="absolute left-3.5 text-zinc-400">$</span>
                  <input
                    id="export-template-price-input"
                    type="number"
                    min="1"
                    max="9999"
                    value={priceDollars}
                    onChange={(e) => setPriceDollars(Number(e.target.value))}
                    className="w-full rounded-xl border border-zinc-200 bg-white py-2 pl-8 pr-4 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                  <span className="ml-3 text-xs text-zinc-500 whitespace-nowrap">
                    You earn: ${(priceDollars * 0.8).toFixed(2)} (80% split)
                  </span>
                </div>
              </div>
            )}

            {pricingModel === "gmv_royalty" && (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  GMV Royalty Share (%)
                </label>
                <div className="relative mt-1.5 flex items-center">
                  <input
                    id="export-template-royalty-input"
                    type="number"
                    min="0.5"
                    max="20"
                    step="0.5"
                    value={royaltyPercent}
                    onChange={(e) => setRoyaltyPercent(Number(e.target.value))}
                    className="w-full rounded-xl border border-zinc-200 bg-white px-3.5 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                  <span className="ml-3 text-xs text-zinc-500 whitespace-nowrap">
                    e.g. 2.5% of operator sales
                  </span>
                </div>
              </div>
            )}

            {/* Description */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Marketplace Description
              </label>
              <textarea
                id="export-template-desc-input"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-white px-3.5 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </div>

            {/* PII & Security Notice */}
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-3 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800/30">
              <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                Automated Safeguards:
              </span>{" "}
              Emails, phone numbers, and active API tokens will be scrubbed before compilation.
              Your space will pass through an automated capability & prompt-injection audit.
            </div>

            {/* Footer Buttons */}
            <div className="flex justify-end gap-3 pt-4 border-t border-zinc-100 dark:border-zinc-800">
              <button
                id="export-template-cancel-btn"
                type="button"
                onClick={onClose}
                disabled={loading}
                className="rounded-xl border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                id="export-template-submit-btn"
                type="button"
                onClick={handleExport}
                disabled={loading || !templateTitle.trim()}
                className="flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-500 disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Compiling & Publishing...
                  </>
                ) : (
                  "Compile & Publish to Marketplace"
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
