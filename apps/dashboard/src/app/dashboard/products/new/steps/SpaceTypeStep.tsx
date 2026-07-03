"use client";

import { useEffect, useState } from "react";
import { listBuilderSpaceTypes } from "@/lib/api";
import { getTemplesForWizard } from "@/lib/temples";
import type { Temple } from "@/lib/temples";
import type { BuilderSpaceTypeListing } from "@/lib/api";
import type { StepProps } from "../wizardTypes";

export default function SpaceTypeStep({ state, update }: StepProps) {
  const [temples, setTemples] = useState<Temple[]>([]);
  const [spaceTypes, setSpaceTypes] = useState<BuilderSpaceTypeListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [t, st] = await Promise.all([getTemplesForWizard(), listBuilderSpaceTypes()]);
        setTemples(t);
        setSpaceTypes(st);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load starting points");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  function pickTemple(t: Temple) {
    update({ spacetypeId: t.spacetypeId, templateId: t.id, templateName: t.name });
  }

  function pickBlank(st: BuilderSpaceTypeListing) {
    update({ spacetypeId: st.id, templateId: null, templateName: null });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Choose a starting point</h2>
        <p className="text-sm text-gray-500 mt-1">
          A Temple is a pre-configured product — agents, projects, and starter content already
          wired up. Or start from a blank SpaceType and configure everything yourself.
        </p>
      </div>

      {loading && <div className="text-sm text-gray-400 py-8 text-center">Loading...</div>}
      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      {!loading && !error && (
        <>
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Temples</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {temples.map((t) => {
                const selected = state.templateId === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => pickTemple(t)}
                    className={`text-left p-4 rounded-xl border-2 transition-colors ${
                      selected ? "border-brand-500 bg-brand-50" : "border-gray-200 hover:border-brand-200 hover:bg-gray-50"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-gray-900">{t.name}</p>
                      {!t.freeTierEligible && (
                        <span className="text-[10px] uppercase tracking-wide text-yellow-700 bg-yellow-100 px-1.5 py-0.5 rounded">Paid plan</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">{t.description}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {spaceTypes.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Or start blank</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {spaceTypes.map((st) => {
                  const selected = state.spacetypeId === st.id && !state.templateId;
                  return (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => pickBlank(st)}
                      className={`text-left p-4 rounded-xl border-2 transition-colors ${
                        selected ? "border-brand-500 bg-brand-50" : "border-gray-200 hover:border-brand-200 hover:bg-gray-50"
                      }`}
                    >
                      <p className="font-semibold text-gray-900">{st.name}</p>
                      <p className="text-xs text-gray-500 mt-1">{st.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
