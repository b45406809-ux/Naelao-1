"use client";

import * as React from "react";
import Link from "next/link";
import { Button, Badge, Card, CardTitle, CardDesc, FormInput } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { listMyBusinesses, getSpaceAnalytics, type Business } from "@/lib/api";
import { listModelBenchmarks, DEFAULT_WORKING_MODEL, type CostTier } from "@naelao/billing-core";
import { modelLabel } from "@/components/ModelSelector";

const COST_TIER_LABEL: Record<CostTier, string> = { economy: "Economy", standard: "Standard", premium: "Premium" };
const COST_TIER_BADGE: Record<CostTier, "green" | "blue" | "amber"> = { economy: "green", standard: "blue", premium: "amber" };
const AXIS_LABEL: Record<string, string> = {
  agency: "Multi-step", safety: "Safety", fabrication: "Won't invent results",
  recovery: "Recovers", proactivity: "Escalates", synthesis: "Briefings",
};

interface SpaceActivity {
  space: Business;
  runs: number;
  credits: number;
  successRate: number | null;
  failed: boolean;
}

export default function SpacesPage() {
  const product = useProduct();
  const { session } = useProductAuth();
  const [spaces, setSpaces] = React.useState<Business[]>([]);
  const [activities, setActivities] = React.useState<SpaceActivity[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [listFailed, setListFailed] = React.useState(false);
  const [activityLoading, setActivityLoading] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [showAllModels, setShowAllModels] = React.useState(false);
  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      setSpaces(await listMyBusinesses(product.space_id, creds));
      setListFailed(false);
    } catch {
      setListFailed(true);
    } finally {
      setLoading(false);
    }
  }, [creds, product.space_id]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  React.useEffect(() => {
    if (!creds) return;
    const active = spaces.filter((space) => space.space_status === "active");
    if (active.length === 0) { setActivities(null); return; }
    let cancelled = false;
    setActivityLoading(true);
    void Promise.all(active.map(async (space): Promise<SpaceActivity> => {
      try {
        const result = await getSpaceAnalytics(space.id, creds, "30d");
        return { space, runs: result.runs.total, credits: result.credits.used, successRate: result.runs.success_rate, failed: false };
      } catch {
        return { space, runs: 0, credits: 0, successRate: null, failed: true };
      }
    })).then((rows) => {
      if (!cancelled) setActivities(rows.sort((a, b) => b.runs - a.runs));
    }).finally(() => { if (!cancelled) setActivityLoading(false); });
    return () => { cancelled = true; };
  }, [spaces, session]);

  const visibleSpaces = query.trim()
    ? spaces.filter((space) => space.name.toLowerCase().includes(query.trim().toLowerCase()))
    : spaces;
  const needsSetup = spaces.filter((space) => space.onboarding_status != null && space.onboarding_status !== "complete").length;
  const totalRuns = activities?.reduce((total, row) => total + row.runs, 0) ?? 0;

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Spaces</div>
        <div className="page-subtitle">Your connected Naelao workspaces.</div>
      </div>

      {!loading && !listFailed && spaces.length > 0 && (
        <div className="grid-3" style={{ marginBottom: 18 }}>
          <div className="card"><div className="card-label">Spaces</div><div className="card-value">{spaces.length}</div></div>
          <div className="card"><div className="card-label">Needs setup</div><div className="card-value" style={{ color: needsSetup ? "#d97706" : undefined }}>{needsSetup}</div></div>
          <div className="card"><div className="card-label">Agent runs (30d)</div><div className="card-value">{activityLoading && activities === null ? "…" : totalRuns.toLocaleString()}</div></div>
        </div>
      )}

      {!loading && !listFailed && spaces.length > 0 && (
        <div className="search-bar" style={{ marginBottom: 16 }}>
          <FormInput placeholder="Search spaces…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
      )}

      <div className="section-label">Your spaces{!loading && !listFailed && spaces.length > 0 ? ` (${visibleSpaces.length}${query.trim() ? ` of ${spaces.length}` : ""})` : ""}</div>
      {loading ? <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
        : listFailed ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
            <span style={{ color: "#dc2626" }} role="alert">Couldn&rsquo;t load your spaces. Your work is still there; this is a loading problem.</span>
            <Button variant="secondary" onClick={() => void refresh()}>Retry</Button>
          </div>
        ) : spaces.length === 0 ? (
          <p style={{ color: "var(--text3)", fontSize: 13 }}>No additional spaces are connected to this account.</p>
        ) : visibleSpaces.length === 0 ? (
          <p style={{ color: "var(--text3)", fontSize: 13 }}>No space matches &ldquo;{query}&rdquo;.</p>
        ) : (
          <div className="grid-3">
            {visibleSpaces.map((space) => {
              const setupPending = space.onboarding_status != null && space.onboarding_status !== "complete";
              const active = space.space_status === "active";
              return (
                <Link key={space.id} href={setupPending ? `/p/${product.slug}/spaces/${space.id}/onboarding` : `/p/${product.slug}/spaces/${space.id}`} style={{ textDecoration: "none" }}>
                  <Card interactive>
                    <CardTitle>{space.name}</CardTitle>
                    <CardDesc>{setupPending ? "Setup needs to be completed." : `Your role: ${space.role}`}</CardDesc>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {setupPending && <Badge color="amber">Finish setup</Badge>}
                      <Badge color={active ? "green" : "amber"}>{active ? "active" : space.space_status}</Badge>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}

      {activities && activities.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 26 }}>Space activity · last 30 days</div>
          <div className="settings-block">
            {activities.map((row, index) => (
              <Link key={row.space.id} href={`/p/${product.slug}/spaces/${row.space.id}`} className="settings-row" style={{ textDecoration: "none", color: "inherit", cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                  <span style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, background: index === 0 ? "var(--accent)" : "var(--surface2)", color: index === 0 ? "#fff" : "var(--text3)" }}>{index + 1}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="settings-row-label" style={{ marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.space.name}</div>
                    <div className="settings-row-sub">{row.runs} runs · {row.credits.toLocaleString()} credits{row.successRate !== null ? ` · ${Math.round(row.successRate * 100)}% success` : ""}{row.failed ? " · partial data" : ""}</div>
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text3)" }}>{row.runs} runs</div><div style={{ fontSize: 10.5, color: "var(--text3)" }}>last 30 days</div></div>
              </Link>
            ))}
          </div>
        </>
      )}

      <div className="section-label" style={{ marginTop: 26 }}>Model benchmarks</div>
      <p style={{ fontSize: 12, color: "var(--text3)", margin: "-6px 0 12px" }}>
        Model strengths and costs based on measured Naelao runs where available, otherwise published estimates.
      </p>
      <div className="grid-3">
        {(showAllModels ? listModelBenchmarks() : listModelBenchmarks().slice(0, 6)).map((benchmark) => (
          <Card key={benchmark.id} interactive={false}>
            <CardTitle>{modelLabel(benchmark.id)}{benchmark.id === DEFAULT_WORKING_MODEL && <span style={{ marginLeft: 6, fontSize: 10.5, color: "var(--accent)", fontWeight: 600 }}>DEFAULT</span>}</CardTitle>
            <CardDesc>{benchmark.strengths[0]}</CardDesc>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
              <Badge color={COST_TIER_BADGE[benchmark.costTier]}>{COST_TIER_LABEL[benchmark.costTier]}</Badge>
              {benchmark.costBasis === "estimated" && <Badge color="blue">Estimated cost</Badge>}
              {benchmark.eval && <Badge color={benchmark.eval.usable.startsWith("0") ? "amber" : "green"}>{benchmark.eval.usable} usable · {benchmark.eval.avgScore.toFixed(2)}/10</Badge>}
              {benchmark.neuronsPerRun !== undefined && <Badge color="blue">~{benchmark.neuronsPerRun} neurons/run</Badge>}
            </div>
            {benchmark.axes && Object.keys(benchmark.axes).length > 0 && (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", margin: "2px 0 6px" }}>
                {Object.entries(benchmark.axes).map(([axis, result]) => <span key={axis} title={result.note ?? `${result.passed} of ${result.total} checks passed`} style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, border: "1px solid var(--border)", color: result.passed === result.total ? "var(--text2)" : "var(--text3)", background: result.passed === result.total ? "var(--bg3)" : "transparent" }}>{AXIS_LABEL[axis] ?? axis} {result.passed}/{result.total}</span>)}
              </div>
            )}
            <p style={{ fontSize: 11.5, color: "var(--text3)", margin: "4px 0 0" }}>{benchmark.eval ? benchmark.eval.note : `Best for: ${benchmark.bestFor[0]}`}</p>
          </Card>
        ))}
      </div>
      {!showAllModels && listModelBenchmarks().length > 6 && <Button variant="secondary" onClick={() => setShowAllModels(true)} style={{ marginTop: 10 }}>Show all {listModelBenchmarks().length} models</Button>}
    </div>
  );
}
