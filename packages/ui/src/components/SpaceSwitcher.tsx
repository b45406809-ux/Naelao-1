import * as React from "react";
import { Avatar } from "./Avatar";
import { CheckIcon, ChevronDownIcon, PlusIcon, SettingsIcon, HierarchyIcon, AccountIcon, SpacesIcon } from "./icons";
import { useTheme } from "../useTheme";
import { activateOnKeyboard } from "../keyboard";

export interface SpaceSwitcherEntry {
  id: string;
  name: string;
  meta: string;
  color?: string;
  subspaces?: { id: string; name: string; kind?: string }[];
}

export interface SpaceSwitcherProps {
  current: SpaceSwitcherEntry;
  entries: SpaceSwitcherEntry[];
  open: boolean;
  onToggle: () => void;
  onSwitch: (id: string) => void;
  onManage?: () => void;
  onCreate?: () => void;
  onSettings?: () => void;
  onHierarchy?: () => void;
  onAccount?: () => void;
  canCreate?: boolean;
}

export function SpaceSwitcher({
  current,
  entries,
  open,
  onToggle,
  onSwitch,
  onManage,
  onCreate,
  onSettings,
  onHierarchy,
  onAccount,
  canCreate = true,
}: SpaceSwitcherProps) {
  const { mode, setMode } = useTheme();
  const dark = mode === "dark";

  return (
    <div style={{ position: "relative" }}>
      <div className={["space-switcher-dropdown", open ? "open" : ""].filter(Boolean).join(" ")}>
        <div className="switcher-header">
          Spaces
          <div className="switcher-header-actions">
          {onManage && <button onClick={onManage}>Manage</button>}
            <button
              type="button"
              className="theme-switcher-button"
              aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
              title={dark ? "Switch to light mode" : "Switch to dark mode"}
              onClick={(event) => {
                event.stopPropagation();
                setMode(dark ? "light" : "dark");
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                {dark ? (
                  <circle cx="8" cy="8" r="3.25" />
                ) : (
                  <path d="M10.8 2.6A5.7 5.7 0 1 0 13.4 11A4.8 4.8 0 0 1 10.8 2.6Z" />
                )}
                {!dark && <path d="M11.5 3.5h.01M13 6h.01M12 12h.01" />}
              </svg>
            </button>
          </div>
        </div>
        {entries.map((entry) => (
          <React.Fragment key={entry.id}>
            <div
              className={["space-item", entry.id === current.id ? "active-space" : ""].filter(Boolean).join(" ")}
              onClick={() => onSwitch(entry.id)}
              role="button"
              tabIndex={0}
              aria-pressed={entry.id === current.id}
              onKeyDown={(event) => activateOnKeyboard(event, () => onSwitch(entry.id))}
            >
              <div className="space-dot" style={{ background: entry.color ?? "var(--accent)" }}>
                {entry.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="space-item-info">
                <div className="space-item-name">{entry.name}</div>
                <div className="space-item-sub">{entry.meta}</div>
              </div>
              {entry.id === current.id && (
                <div className="space-item-check">
                  <CheckIcon strokeWidth={2} />
                </div>
              )}
            </div>
            {entry.subspaces?.map((sub) => (
              <div key={sub.id} className="subspace-indent" onClick={() => onSwitch(sub.id)} role="button" tabIndex={0} onKeyDown={(event) => activateOnKeyboard(event, () => onSwitch(sub.id))}>
                <SpacesIcon />
                {sub.name}
                {sub.kind ? ` · ${sub.kind}` : ""}
              </div>
            ))}
          </React.Fragment>
        ))}
        <div className="switcher-divider" />
        {canCreate && onCreate && (
          <div className="switcher-action" onClick={onCreate} role="button" tabIndex={0} onKeyDown={(event) => activateOnKeyboard(event, onCreate)}>
            <PlusIcon />
            Create New Space
          </div>
        )}
        {onSettings && (
          <div className="switcher-action" onClick={onSettings} role="button" tabIndex={0} onKeyDown={(event) => activateOnKeyboard(event, onSettings)}>
            <SettingsIcon />
            Space Settings
          </div>
        )}
        {onHierarchy && (
          <div className="switcher-action" onClick={onHierarchy} role="button" tabIndex={0} onKeyDown={(event) => activateOnKeyboard(event, onHierarchy)}>
            <HierarchyIcon />
            View Hierarchy
          </div>
        )}
        <div className="switcher-divider" />
        {onAccount && (
          <div className="switcher-action" onClick={onAccount} role="button" tabIndex={0} onKeyDown={(event) => activateOnKeyboard(event, onAccount)}>
            <AccountIcon />
            Account
          </div>
        )}
      </div>

      <div className="space-row" onClick={onToggle} role="button" tabIndex={0} aria-expanded={open} onKeyDown={(event) => activateOnKeyboard(event, onToggle)}>
        <Avatar name={current.name} />
        <div className="space-info">
          <div className="space-name">{current.name}</div>
          <div className="space-meta">{current.meta}</div>
        </div>
        <div className="space-chevron">
          <ChevronDownIcon />
        </div>
      </div>
    </div>
  );
}
