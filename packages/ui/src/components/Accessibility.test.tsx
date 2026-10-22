import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Toggle } from "./Form";
import { HistoryItem, NavItem } from "./NavItem";
import { Toast } from "./Toast";

describe("shared UI accessibility contracts", () => {
  it("names the switch and announces toast updates", () => {
    const toggle = renderToStaticMarkup(<Toggle label="Enable alerts" on onChange={() => {}} />);
    expect(toggle).toContain('role="switch"');
    expect(toggle).toContain('aria-label="Enable alerts"');
    expect(toggle).toContain('aria-checked="true"');

    const toast = renderToStaticMarkup(<Toast toast={{ message: "Saved", key: 1 }} />);
    expect(toast).toContain('role="status"');
    expect(toast).toContain('aria-live="polite"');
    expect(toast).toContain("Saved");
  });

  it("marks active navigation and keyboard-actionable rows as controls", () => {
    const nav = renderToStaticMarkup(<NavItem label="Settings" active />);
    const history = renderToStaticMarkup(<HistoryItem label="Recent session" />);
    expect(nav).toContain('role="button"');
    expect(nav).toContain('aria-current="page"');
    expect(history).toContain('role="button"');
    expect(history).toContain('tabindex="0"');
  });
});
