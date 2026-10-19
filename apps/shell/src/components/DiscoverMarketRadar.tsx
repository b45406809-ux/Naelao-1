"use client";

import {
  type MarketRadarOpportunity,
  type SessionCredentials,
  getMarketRadar,
  launchMarketRadarOpportunity,
} from "@/lib/api";
import { Button } from "@naelao/ui";
import * as React from "react";

interface Props {
  session: SessionCredentials;
  productSpaceId: string;
  spacetypeId: string;
  onLaunched: (spaceId: string) => void;
}

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);

export function DiscoverMarketRadar({
  session,
  productSpaceId,
  spacetypeId,
  onLaunched,
}: Props) {
  const [items, setItems] = React.useState<MarketRadarOpportunity[]>([]);
  const [launching, setLaunching] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    getMarketRadar(productSpaceId, session)
      .then(setItems)
      .catch(() => setError("Live opportunities are temporarily unavailable."));
  }, [productSpaceId, session]);
  if (error)
    return (
      <output style={{ color: "var(--text3)", fontSize: 13 }}>{error}</output>
    );
  if (!items.length) return null;
  async function launch(item: MarketRadarOpportunity) {
    setLaunching(item.id);
    setError(null);
    try {
      const result = await launchMarketRadarOpportunity(
        item.id,
        productSpaceId,
        { name: item.name, spacetype_id: spacetypeId },
        session
      );
      onLaunched(result.space_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Launch failed");
      setLaunching(null);
    }
  }
  return (
    <section
      aria-labelledby="market-radar-heading"
      style={{ marginBottom: 24 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div>
          <h2 id="market-radar-heading" style={{ margin: 0, fontSize: 18 }}>
            🔥 Live Market Radar
          </h2>
          <p style={{ margin: "3px 0 0", color: "var(--text3)", fontSize: 12 }}>
            Top autonomous opportunities scored by the OpenRouter Decisions API.
          </p>
        </div>
        <span style={{ fontSize: 11, color: "var(--text3)" }}>
          Verified signals · refreshed continuously
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(245px, 1fr))",
          gap: 12,
        }}
      >
        {items.map((item) => (
          <article
            className="card"
            key={item.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              cursor: "default",
            }}
          >
            <div>
              <strong>{item.name}</strong>
              <div style={{ color: "#16a34a", fontSize: 13, marginTop: 4 }}>
                +{item.search_surge_pct}% search surge
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                fontSize: 12,
              }}
            >
              <div>
                <span style={{ color: "var(--text3)" }}>Saturation</span>
                <br />
                <b>
                  {item.saturation_index}/100 · {item.saturation_label}
                </b>
              </div>
              <div>
                <span style={{ color: "var(--text3)" }}>Operator ARR</span>
                <br />
                <b>
                  {money(item.arr_low_cents)}–{money(item.arr_high_cents)}/mo
                </b>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "var(--text3)" }}>
              Pre-configured:{" "}
              {item.preconfigured_stack
                .map((x) => x.replace(/^ext_|_core$/g, "").replaceAll("_", " "))
                .join(" · ")}
            </div>
            <Button
              onClick={() => void launch(item)}
              disabled={launching !== null}
            >
              {launching === item.id
                ? "Launching…"
                : "🚀 Launch This Venture with 1-Click"}
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}
