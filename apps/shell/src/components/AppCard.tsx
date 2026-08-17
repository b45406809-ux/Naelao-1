"use client";

// One card in the connectable-app grid.
//
// The two sources — our curated catalogue and the Composio/Pipedream directory — are deliberately
// rendered by the SAME component. They used to be two visually different lists, which made the
// dozen curated ones look like the whole product and the several thousand brokered ones look like
// an afterthought behind a "browse" button. An app is an app; where its definition comes from is
// our implementation detail, not something a business owner should have to reason about.

import * as React from "react";

export interface AppCardModel {
  /** What the connect routes take: a curated connector id, or `{provider}:{slug}`. */
  id: string;
  name: string;
  description: string;
  logo?: string | undefined;
  /** "composio" | "pipedream" | "direct" — shown small, as provenance rather than a choice. */
  provider: string;
  connected: boolean;
  /** From the curated catalogue: we ship real declared operations for it. */
  recommended: boolean;
  /** Each member connects their own account rather than one shared business connection. */
  personal?: boolean | undefined;
}

export function AppCard({
  app,
  busy,
  onConnect,
}: {
  app: AppCardModel;
  busy: boolean;
  onConnect: () => void;
}) {
  // A provider's logo URL can 404 or be blocked; falling back to the initial keeps the grid even
  // rather than leaving a broken-image box.
  const [logoFailed, setLogoFailed] = React.useState(false);
  const showLogo = Boolean(app.logo) && !logoFailed;

  return (
    <div className={`app-card${app.connected ? " connected" : ""}`} style={{ cursor: "default" }}>
      <div className="app-card-header">
        {showLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="app-card-logo"
            src={app.logo}
            alt=""
            loading="lazy"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <div className="app-card-initial">{app.name.slice(0, 1)}</div>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="app-card-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {app.name}
          </div>
          <div className="app-card-publisher">
            {app.provider}
            {app.personal ? " · personal" : ""}
          </div>
        </div>
      </div>

      <div className="app-card-desc">{app.description}</div>

      <div className="app-card-footer">
        {app.recommended ? <span className="app-card-tag">Recommended</span> : <span />}
        {app.connected ? (
          <span className="installed-badge">
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={2} stroke="currentColor">
              <polyline points="3.5,8.5 6.5,11.5 12.5,4.5" />
            </svg>
            Connected
          </span>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={onConnect} disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
    </div>
  );
}
