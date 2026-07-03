"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBuilderProduct, configureBuilderProductDomain } from "@/lib/api";
import type { CreateBuilderProductInput } from "@/lib/api";
import { INITIAL_WIZARD_STATE, SLUG_PATTERN } from "./wizardTypes";
import type { WizardState } from "./wizardTypes";
import IdentityStep from "./steps/IdentityStep";
import SpaceTypeStep from "./steps/SpaceTypeStep";
import AuthConfigStep from "./steps/AuthConfigStep";
import PricingStep from "./steps/PricingStep";
import BrandingStep from "./steps/BrandingStep";
import DomainStep from "./steps/DomainStep";
import ReviewStep from "./steps/ReviewStep";

const STEPS = ["Identity", "Starting Point", "Sign-in", "Pricing", "Branding", "Domain", "Review & Launch"] as const;

function validateStep(step: number, state: WizardState): string | null {
  if (step === 0) {
    if (!state.name.trim()) return "Product name is required.";
    if (state.productSlug && !SLUG_PATTERN.test(state.productSlug)) {
      return "Platform subdomain must be 2-40 lowercase letters, numbers, or hyphens.";
    }
  }
  if (step === 1 && !state.spacetypeId) return "Choose a starting point to continue.";
  return null;
}

function toNumberOrUndefined(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

export default function NewProductWizardPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(INITIAL_WIZARD_STATE);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  function update(patch: Partial<WizardState>) {
    setState((prev) => ({ ...prev, ...patch }));
  }

  function goNext() {
    const validationError = validateStep(step, state);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function goBack() {
    setError(null);
    setStep((s) => Math.max(s - 1, 0));
  }

  async function launch() {
    setLaunching(true);
    setError(null);
    try {
      const creditsIncludedPerMonth = toNumberOrUndefined(state.creditsIncludedPerMonth);
      const overageCreditsPriceCents = toNumberOrUndefined(state.overageCreditsPriceCents);
      const pricePerSeatCents = toNumberOrUndefined(state.pricePerSeatCents);
      const includedSeats = toNumberOrUndefined(state.includedSeats);
      const trialDays = toNumberOrUndefined(state.trialDays);

      const input: CreateBuilderProductInput = {
        name: state.name.trim(),
        spacetype_id: state.spacetypeId,
        ...(state.templateId ? { template_id: state.templateId } : {}),
        ...(state.productSlug ? { product_slug: state.productSlug } : {}),
        product_config: {
          branding: {
            brandColor: state.brandColor,
            ...(state.logoUrl ? { logoUrl: state.logoUrl } : {}),
            ...(state.faviconUrl ? { faviconUrl: state.faviconUrl } : {}),
            ...(state.productDescription ? { productDescription: state.productDescription } : {}),
          },
          authProvider: {
            provider: state.authProvider,
            requireAdminApproval: state.requireAdminApproval,
            ...(state.allowedEmailDomains
              ? { allowedEmailDomains: state.allowedEmailDomains.split(",").map((d) => d.trim()).filter(Boolean) }
              : {}),
          },
          pricingConfig: {
            model: state.pricingModel,
            ...(creditsIncludedPerMonth !== undefined ? { creditsIncludedPerMonth } : {}),
            ...(overageCreditsPriceCents !== undefined ? { overageCreditsPriceCents } : {}),
            ...(pricePerSeatCents !== undefined ? { pricePerSeatCents } : {}),
            ...(includedSeats !== undefined ? { includedSeats } : {}),
            ...(trialDays !== undefined ? { trialDays } : {}),
          },
        },
      };

      const created = await createBuilderProduct(input);

      if (state.customDomain.trim()) {
        try {
          await configureBuilderProductDomain(created.id, state.customDomain.trim());
        } catch {
          // Domain attachment failing shouldn't block the launch — it's reconfigurable from
          // Product Settings; the product itself was already created successfully above.
        }
      }

      router.push("/dashboard/products");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch product");
    } finally {
      setLaunching(false);
    }
  }

  const stepProps = { state, update };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">New Product</h1>
        <p className="text-gray-500 mt-1">Launch a new customer-facing product.</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2 flex-1">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
                i < step ? "bg-brand-600 text-white" : i === step ? "bg-brand-100 text-brand-700 border-2 border-brand-500" : "bg-gray-100 text-gray-400"
              }`}
            >
              {i < step ? "✓" : i + 1}
            </div>
            {i < STEPS.length - 1 && <div className={`flex-1 h-0.5 ${i < step ? "bg-brand-600" : "bg-gray-200"}`} />}
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        {step === 0 && <IdentityStep {...stepProps} />}
        {step === 1 && <SpaceTypeStep {...stepProps} />}
        {step === 2 && <AuthConfigStep {...stepProps} />}
        {step === 3 && <PricingStep {...stepProps} />}
        {step === 4 && <BrandingStep {...stepProps} />}
        {step === 5 && <DomainStep {...stepProps} />}
        {step === 6 && <ReviewStep state={state} />}

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-5">
            {error}
          </p>
        )}

        <div className="flex justify-between mt-8 pt-5 border-t border-gray-100">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 0 || launching}
            className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
          >
            Back
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={goNext}
              className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void launch()}
              disabled={launching}
              className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {launching ? "Launching..." : "Launch product"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
