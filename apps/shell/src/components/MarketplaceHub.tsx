"use client";

import { useState, useEffect } from "react";
import {
  listMarketplaceTemplates,
  purchaseMarketplaceTemplate,
  type MarketplaceTemplateListing,
  type SessionCredentials,
} from "../lib/api";
import { CreatorStudio } from "./CreatorStudio";
import { DeveloperPartnerHub } from "./DeveloperPartnerHub";

interface MarketplaceHubProps {
  productSpaceId: string;
  session: SessionCredentials;
  onLaunchSuccess?: (newSpaceId: string) => void;
}

export function MarketplaceHub({
  productSpaceId,
  session,
  onLaunchSuccess,
}: MarketplaceHubProps) {
  const [activeTab, setActiveTab] = useState<"marketplace" | "creator_studio" | "partner_portal">("marketplace");
  const [category, setCategory] = useState("ALL");
  const [pricingFilter, setPricingFilter] = useState("all");
  const [templates, setTemplates] = useState<MarketplaceTemplateListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Purchase Modal state
  const [selectedTemplate, setSelectedTemplate] = useState<MarketplaceTemplateListing | null>(null);
  const [businessName, setBusinessName] = useState("");
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseSuccess, setPurchaseSuccess] = useState<{ spaceId: string; message: string } | null>(null);

  useEffect(() => {
    if (activeTab !== "marketplace") return;
    loadTemplates();
  }, [category, pricingFilter, activeTab]);

  async function loadTemplates() {
    setLoading(true);
    setError(null);
    try {
      const res = await listMarketplaceTemplates(
        { category, pricing: pricingFilter },
        session
      );
      setTemplates(res.templates ?? []);
    } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      setError(err?.message || "Failed to load marketplace templates.");
    } finally {
      setLoading(false);
    }
  }

  async function handlePurchase() {
    if (!selectedTemplate) return;
    setPurchasing(true);
    try {
      const res = await purchaseMarketplaceTemplate(
        selectedTemplate.id,
        {
          productSpaceId,
          businessName: businessName.trim() || `${selectedTemplate.name} Studio`,
        },
        session
      );
      setPurchaseSuccess({
        spaceId: res.space_id,
        message: res.message,
      });
      onLaunchSuccess?.(res.space_id);
    } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      alert(err?.message || "Failed to license and launch template.");
    } finally {
      setPurchasing(false);
    }
  }

  return (
    <div id="marketplace-hub" className="space-y-6">
      {/* Top Header & Tab Navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            AI Cowork Studio Marketplace
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Browse turnkey vertical workspaces, or monetize your own specialized agent studios.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex rounded-xl border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-800 dark:bg-zinc-800">
          <button
            id="tab-explore-marketplace"
            onClick={() => setActiveTab("marketplace")}
            className={`rounded-lg px-4 py-1.5 text-xs font-semibold transition ${
              activeTab === "marketplace"
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            }`}
          >
            Explore Blueprints
          </button>
          <button
            id="tab-creator-studio"
            onClick={() => setActiveTab("creator_studio")}
            className={`rounded-lg px-4 py-1.5 text-xs font-semibold transition ${
              activeTab === "creator_studio"
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            }`}
          >
            Creator Studio & MRR
          </button>
          <button
            id="tab-partner-portal"
            onClick={() => setActiveTab("partner_portal")}
            className={`rounded-lg px-4 py-1.5 text-xs font-semibold transition ${
              activeTab === "partner_portal"
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            }`}
          >
            💵 Partner Portal (40% Split)
          </button>
        </div>
      </div>

      {activeTab === "partner_portal" ? (
        <DeveloperPartnerHub productSpaceId={productSpaceId} session={session} />
      ) : activeTab === "creator_studio" ? (
        <CreatorStudio productSpaceId={productSpaceId} session={session} />
      ) : (
        <>
          {/* Category Pills & Filters */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { id: "ALL", label: "All Niches" },
                { id: "LEGAL", label: "Legal & M&A" },
                { id: "FINANCE", label: "Finance & Tax" },
                { id: "HEALTHCARE", label: "Healthcare & Med" },
                { id: "ENGINEERING", label: "Architecture & Eng" },
                { id: "AGENCY", label: "Growth & Agency" },
                { id: "COMMERCE", label: "E-Commerce" },
              ].map((c) => (
                <button
                  key={c.id}
                  id={`category-filter-${c.id}`}
                  onClick={() => setCategory(c.id)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    category === c.id
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            {/* Pricing Model Dropdown */}
            <div className="flex items-center gap-2">
              <label htmlFor="filter-pricing-select" className="text-xs text-zinc-500">Pricing:</label>
              <select
                id="filter-pricing-select"
                value={pricingFilter}
                onChange={(e) => setPricingFilter(e.target.value)}
                className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-800 focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
              >
                <option value="all">All Models</option>
                <option value="free">Free / Open</option>
                <option value="paid">Paid & Royalties</option>
              </select>
            </div>
          </div>

          {/* Loading & Error States */}
          {loading && (
            <div className="flex h-48 items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}

          {/* Template Cards Grid */}
          {!loading && !error && (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
              {templates.map((tpl) => (
                <div
                  key={tpl.id}
                  id={`marketplace-card-${tpl.id}`}
                  className="flex flex-col justify-between rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <div>
                    {/* Header: Category & Safety Badge */}
                    <div className="flex items-center justify-between">
                      <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {tpl.category}
                      </span>
                      <div className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Safety {tpl.safety_score}%
                      </div>
                    </div>

                    {/* Title & Author */}
                    <h3 className="mt-3 text-base font-bold text-zinc-900 dark:text-zinc-100">
                      {tpl.name}
                    </h3>
                    <div className="mt-0.5 text-xs text-zinc-400">
                      By {tpl.author_name} • v{tpl.version}
                    </div>

                    {/* Description */}
                    <p className="mt-2.5 line-clamp-3 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                      {tpl.description}
                    </p>

                    {/* Opportunity Radar Metrics */}
                    <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-zinc-100 bg-zinc-50 p-2.5 dark:border-zinc-800/60 dark:bg-zinc-800/40">
                      <div>
                        <div className="text-[10px] text-zinc-400">Market Opportunity</div>
                        <div className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                          {tpl.opportunity_score}/100 High
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-zinc-400">Saturation Index</div>
                        <div className="text-xs font-bold text-emerald-600 dark:text-emerald-400">
                          {tpl.saturation_index}% Low
                        </div>
                      </div>
                    </div>

                    {/* Tags */}
                    {tpl.tags?.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1">
                        {tpl.tags.slice(0, 3).map((tag, idx) => (
                          <span
                            key={idx}
                            className="rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] text-zinc-500 dark:border-zinc-800"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Pricing Footer & Action */}
                  <div className="mt-5 flex items-center justify-between border-t border-zinc-100 pt-4 dark:border-zinc-800">
                    <div>
                      {tpl.pricing_model === "free" ? (
                        <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400">
                          Free / Open Source
                        </div>
                      ) : tpl.pricing_model === "recurring_monthly" ? (
                        <div>
                          <span className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                            ${(tpl.price_cents / 100).toFixed(0)}
                          </span>
                          <span className="text-[10px] text-zinc-400"> / month</span>
                        </div>
                      ) : tpl.pricing_model === "gmv_royalty" ? (
                        <div className="text-sm font-bold text-indigo-600 dark:text-indigo-400">
                          {(tpl.royalty_share_bps / 100).toFixed(1)}% GMV Royalty
                        </div>
                      ) : (
                        <div>
                          <span className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                            ${(tpl.price_cents / 100).toFixed(0)}
                          </span>
                          <span className="text-[10px] text-zinc-400"> one-time</span>
                        </div>
                      )}
                      <div className="text-[10px] text-zinc-400">
                        {tpl.install_count} active installs • ★ {tpl.avg_rating}
                      </div>
                    </div>

                    <button
                      id={`launch-template-btn-${tpl.id}`}
                      onClick={() => {
                        setSelectedTemplate(tpl);
                        setBusinessName(`${tpl.name} Studio`);
                        setPurchaseSuccess(null);
                      }}
                      className="rounded-xl bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                    >
                      {tpl.pricing_model === "free" ? "Clone & Launch" : "1-Click Launch"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empty State */}
          {!loading && !error && templates.length === 0 && (
            <div className="rounded-2xl border border-dashed border-zinc-300 p-12 text-center dark:border-zinc-800">
              <div className="text-3xl">✨</div>
              <h3 className="mt-2 text-base font-bold text-zinc-900 dark:text-zinc-100">
                No templates found in this category
              </h3>
              <p className="mt-1 text-xs text-zinc-500">
                Be the first expert to export and monetize a template in this niche!
              </p>
            </div>
          )}
        </>
      )}

      {/* 1-Click Purchase & Launch Modal */}
      {selectedTemplate && (
        <div id="purchase-modal-overlay" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div id="purchase-modal" className="relative w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
            {purchaseSuccess ? (
              <div className="space-y-4 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/20 text-xl text-emerald-500">
                  ✓
                </div>
                <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                  Studio Space Launched!
                </h3>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  {purchaseSuccess.message}
                </p>
                <button
                  onClick={() => setSelectedTemplate(null)}
                  className="w-full rounded-xl bg-zinc-900 py-2.5 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900"
                >
                  Open Studio
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                    Launch Turnkey Studio
                  </h3>
                  <button
                    onClick={() => setSelectedTemplate(null)}
                    className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                  >
                    ✕
                  </button>
                </div>

                <div className="rounded-xl border border-zinc-100 bg-zinc-50 p-3.5 dark:border-zinc-800 dark:bg-zinc-800/50">
                  <div className="font-bold text-zinc-900 dark:text-zinc-100">
                    {selectedTemplate.name}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    By {selectedTemplate.author_name} • Category: {selectedTemplate.category}
                  </div>
                  <div className="mt-2 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                    {selectedTemplate.pricing_model === "free"
                      ? "Free License"
                      : selectedTemplate.pricing_model === "recurring_monthly"
                      ? `$${(selectedTemplate.price_cents / 100).toFixed(2)}/mo`
                      : selectedTemplate.pricing_model === "gmv_royalty"
                      ? `${(selectedTemplate.royalty_share_bps / 100).toFixed(1)}% Royalty`
                      : `$${(selectedTemplate.price_cents / 100).toFixed(2)} One-time`}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    New Business / Workspace Name
                  </label>
                  <input
                    type="text"
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                    placeholder="e.g. Apex Contract Redline Studio"
                  />
                </div>

                <div className="text-[11px] text-zinc-400">
                  Includes pre-configured autonomous agents, rules, knowledge seeds, and task DAGs.
                  80% of license fee is settled directly to the template creator.
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={() => setSelectedTemplate(null)}
                    disabled={purchasing}
                    className="rounded-xl border border-zinc-200 px-4 py-2 text-xs font-semibold text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handlePurchase}
                    disabled={purchasing}
                    className="flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {purchasing ? "Provisioning..." : "Confirm & Launch"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
