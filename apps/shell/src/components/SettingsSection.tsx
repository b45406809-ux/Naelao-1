"use client";

// The layout the settings pages share: a titled block with an explanation, and labelled rows
// inside it. Extracted because the assistant page and the per-agent page render the same shape,
// and a settings page whose sections drift apart reads like two different products.
//
// Built on the design system's existing .settings-block/.settings-row classes rather than
// one-off inline styling, so it themes with everything else.

import * as React from "react";

export function SettingsSection({
  title,
  desc,
  children,
  action,
}: {
  title: string;
  /** One line on what this section is for, in the reader's terms. Optional, but a section with no
   *  explanation is where "I can't find where to change X" comes from. */
  desc?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 26 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <div>
          <h2 style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text)", marginBottom: desc ? 3 : 0 }}>{title}</h2>
          {desc && <p style={{ fontSize: 12.5, color: "var(--text3)", lineHeight: 1.55, maxWidth: 640 }}>{desc}</p>}
        </div>
        {action && <div style={{ flexShrink: 0 }}>{action}</div>}
      </div>
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 14,
        }}
      >
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  label,
  sub,
  children,
}: {
  label: React.ReactNode;
  sub?: string | undefined;
  children?: React.ReactNode;
}) {
  return (
    <div className="settings-line">
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "var(--text)" }}>{label}</div>
        {sub && <div style={{ fontSize: 11.5, color: "var(--text3)", lineHeight: 1.5, marginTop: 1 }}>{sub}</div>}
      </div>
      {children !== undefined && <div style={{ flexShrink: 0 }}>{children}</div>}
    </div>
  );
}
