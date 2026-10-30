"use client";

import * as React from "react";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { getShellManifest, getSpaceUserPreferences, updateSpaceUserPreferences, type SessionCredentials } from "@/lib/api";

export type PresentationProfile = "guided" | "balanced" | "advanced";
export type TechnicalDetailFilter = "identifiers" | "model_routing" | "execution_trace";

export const PRESENTATION_PROFILE_LABELS: Record<PresentationProfile, { title: string; detail: string }> = {
  guided: { title: "Guided", detail: "Simple screens, recommended choices, and only the details needed to get work done." },
  balanced: { title: "Balanced", detail: "Common controls stay visible; diagnostic details are available when useful." },
  advanced: { title: "Advanced", detail: "Show configuration, model routing, identifiers, and execution details." },
};

const PROFILE_FILTERS: Record<PresentationProfile, TechnicalDetailFilter[]> = {
  guided: ["identifiers", "model_routing", "execution_trace"],
  balanced: ["identifiers", "execution_trace"],
  advanced: [],
};
const FILTER_LABELS: Record<TechnicalDetailFilter, string> = {
  identifiers: "Internal IDs",
  model_routing: "Model and provider routing",
  execution_trace: "Execution traces",
};

interface PresentationContextValue {
  profile: PresentationProfile;
  templateDefault: PresentationProfile;
  filters: TechnicalDetailFilter[];
  loading: boolean;
  error: string | null;
  labels: typeof FILTER_LABELS;
  saveProfile(profile: PresentationProfile): Promise<void>;
  saveFilters(filters: TechnicalDetailFilter[]): Promise<void>;
  resetToTemplateDefault(): Promise<void>;
  isDetailVisible(kind: TechnicalDetailFilter): boolean;
}

const PresentationContext = React.createContext<PresentationContextValue | null>(null);

function validProfile(value: unknown): value is PresentationProfile {
  return value === "guided" || value === "balanced" || value === "advanced";
}

export function PresentationProfileProvider({ children }: { children: React.ReactNode }) {
  const { session } = useProductAuth();
  const { activeSpaceId, isChildSpace, isHydrated } = useActiveSpace();
  const creds = React.useMemo<SessionCredentials | null>(() => session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null, [session?.session_token, session?.end_user_id]);
  const [defaultProfile, setDefaultProfile] = React.useState<PresentationProfile>("guided");
  const [override, setOverride] = React.useState<PresentationProfile | null>(null);
  const [filters, setFilters] = React.useState<TechnicalDetailFilter[]>(PROFILE_FILTERS.guided);
  const [filtersLoaded, setFiltersLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!creds || !activeSpaceId || !isHydrated || !isChildSpace) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    setOverride(null);
    setFiltersLoaded(false);
    Promise.allSettled([getShellManifest(activeSpaceId, creds), getSpaceUserPreferences(activeSpaceId, creds)]).then(([manifestResult, preferencesResult]) => {
      if (!live) return;
      if (manifestResult.status === "fulfilled" && validProfile(manifestResult.value.presentation_profile)) setDefaultProfile(manifestResult.value.presentation_profile);
      else setDefaultProfile("guided");
      if (preferencesResult.status === "fulfilled") {
        const value = preferencesResult.value;
        setOverride(validProfile(value.presentation_profile) ? value.presentation_profile : null);
        const accepted = (value.technical_detail_filters ?? []).filter((v): v is TechnicalDetailFilter => v === "identifiers" || v === "model_routing" || v === "execution_trace");
        setFilters(accepted.length || validProfile(value.presentation_profile) ? accepted : PROFILE_FILTERS[manifestResult.status === "fulfilled" && validProfile(manifestResult.value.presentation_profile) ? manifestResult.value.presentation_profile : "guided"]);
        setFiltersLoaded(true);
      } else {
        setFilters(PROFILE_FILTERS[manifestResult.status === "fulfilled" && validProfile(manifestResult.value.presentation_profile) ? manifestResult.value.presentation_profile : "guided"]);
        setFiltersLoaded(true);
        setError("Presentation settings couldn't be loaded. Try again from Settings.");
      }
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [activeSpaceId, creds, isChildSpace, isHydrated]);

  const profile = override ?? defaultProfile;
  const saveProfile = React.useCallback(async (next: PresentationProfile) => {
    if (!creds) return;
    setError(null);
    const result = await updateSpaceUserPreferences(activeSpaceId, { presentation_profile: next, technical_detail_filters: PROFILE_FILTERS[next] }, creds);
    setOverride(result.presentation_profile ?? next);
    setFilters(result.technical_detail_filters ?? PROFILE_FILTERS[next]);
    setFiltersLoaded(true);
  }, [activeSpaceId, creds]);
  const saveFilters = React.useCallback(async (next: TechnicalDetailFilter[]) => {
    if (!creds) return;
    setError(null);
    const result = await updateSpaceUserPreferences(activeSpaceId, { presentation_profile: profile, technical_detail_filters: [...new Set(next)] }, creds);
    setOverride(result.presentation_profile ?? profile);
    setFilters(result.technical_detail_filters ?? next);
    setFiltersLoaded(true);
  }, [activeSpaceId, creds, profile]);
  const resetToTemplateDefault = React.useCallback(async () => {
    if (!creds) return;
    setError(null);
    const result = await updateSpaceUserPreferences(activeSpaceId, { presentation_profile: null, technical_detail_filters: PROFILE_FILTERS[defaultProfile] }, creds);
    setOverride(null);
    setFilters(result.technical_detail_filters ?? PROFILE_FILTERS[defaultProfile]);
    setFiltersLoaded(true);
  }, [activeSpaceId, creds, defaultProfile]);

  const value = React.useMemo<PresentationContextValue>(() => ({
    profile,
    templateDefault: defaultProfile,
    filters: filtersLoaded ? filters : PROFILE_FILTERS[profile],
    loading,
    error,
    labels: FILTER_LABELS,
    saveProfile,
    saveFilters,
    resetToTemplateDefault,
    isDetailVisible: (kind) => !(filtersLoaded ? filters : PROFILE_FILTERS[profile]).includes(kind),
  }), [profile, defaultProfile, filters, filtersLoaded, loading, error, saveProfile, saveFilters, resetToTemplateDefault]);

  const effectiveFilters = filtersLoaded ? filters : PROFILE_FILTERS[profile];
  return <PresentationContext.Provider value={value}><div
    data-presentation-profile={profile}
    data-hide-identifiers={effectiveFilters.includes("identifiers")}
    data-hide-model-routing={effectiveFilters.includes("model_routing")}
    data-hide-execution-trace={effectiveFilters.includes("execution_trace")}
  >{children}</div></PresentationContext.Provider>;
}

export function usePresentationProfile(): PresentationContextValue {
  const value = React.useContext(PresentationContext);
  if (!value) throw new Error("usePresentationProfile must be used inside PresentationProfileProvider");
  return value;
}
