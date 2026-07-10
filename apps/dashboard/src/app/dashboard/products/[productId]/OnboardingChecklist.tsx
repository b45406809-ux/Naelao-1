"use client";

import Link from "next/link";
import type { BuilderProductDetail } from "@/lib/api";

// F-10: first-run onboarding for a new product. A builder who just created a product lands on a
// blank dashboard with no sense of what to do next; this reads the product's own config to derive
// which setup steps are done and surfaces the next actions with deep links. It self-dismisses once
// every step is complete (nothing to nag about), so it's a first-run aid, not permanent chrome.

interface Step {
  id: string;
  label: string;
  hint: string;
  done: boolean;
  href: string;
}

function deriveSteps(product: BuilderProductDetail, base: string): Step[] {
  const cfg = product.product_config;
  const pricing = cfg.pricingConfig;
  const hasPricing = !!(pricing && ((pricing.plans && pricing.plans.length > 0) || (pricing.creditPacks && pricing.creditPacks.length > 0)));
  return [
    {
      id: "name",
      label: "Name your product",
      hint: "Give it a clear, customer-facing name.",
      done: !!product.name && product.name.trim().length > 0 && product.name !== "Untitled",
      href: `${base}/configuration`,
    },
    {
      id: "domain",
      label: "Connect a custom domain",
      hint: "Optional — your product also works on its Naelao subdomain.",
      done: !!product.product_slug,
      href: `${base}/domain`,
    },
    {
      id: "pricing",
      label: "Set up pricing",
      hint: "Add at least one plan or credit pack so end users can pay.",
      done: hasPricing,
      href: `${base}/pricing`,
    },
    {
      id: "legal",
      label: "Add legal links",
      hint: "ToS + Privacy Policy — required before going public under GDPR/CCPA.",
      done: !!(cfg.legal?.tosUrl && cfg.legal?.privacyPolicyUrl),
      href: `${base}/legal`,
    },
    {
      id: "launch",
      label: "Launch",
      hint: "Move the product from draft to active so end users can sign up.",
      done: product.status === "active",
      href: `${base}/configuration`,
    },
  ];
}

export function OnboardingChecklist({ product }: { product: BuilderProductDetail }) {
  const base = `/dashboard/products/${product.id}`;
  const steps = deriveSteps(product, base);
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null; // fully set up — nothing to nag

  return (
    <div className="rounded-xl border border-brand-200 bg-brand-50 p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-brand-800">Get your product live</h2>
        <span className="text-xs font-medium text-brand-700">{doneCount} / {steps.length} done</span>
      </div>
      <div className="h-1.5 w-full bg-brand-100 rounded-full mb-4 overflow-hidden">
        <div className="h-full bg-brand-600 rounded-full transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>
      <ul className="space-y-2">
        {steps.map((step) => (
          <li key={step.id}>
            <Link
              href={step.href}
              className={`flex items-start gap-3 rounded-lg px-3 py-2 transition-colors ${step.done ? "opacity-60" : "hover:bg-white"}`}
            >
              <span
                className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-xs ${step.done ? "bg-brand-600 text-white" : "border border-brand-300 text-transparent"}`}
                aria-hidden
              >
                ✓
              </span>
              <span className="min-w-0">
                <span className={`text-sm font-medium ${step.done ? "text-gray-500 line-through" : "text-gray-900"}`}>{step.label}</span>
                {!step.done && <span className="block text-xs text-gray-500">{step.hint}</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
