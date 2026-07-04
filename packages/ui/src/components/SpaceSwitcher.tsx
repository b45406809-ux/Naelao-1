import * as React from "react";
import { Avatar } from "./Avatar";
import { CheckIcon, ChevronDownIcon, PlusIcon, SettingsIcon, HierarchyIcon, AccountIcon, SpacesIcon } from "./icons";

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
  return (
    <div style={{ position: "relative" }}>
      <div className={["space-switcher-dropdown", open ? "open" : ""].filter(Boolean).join(" ")}>
        <div className="switcher-header">
          Spaces
          {onManage && <button onClick={onManage}>Manage</button>}
        </div>
        {entries.map((entry) => (
          <React.Fragment key={entry.id}>
            <div
              className={["space-item", entry.id === current.id ? "active-space" : ""].filter(Boolean).join(" ")}
              onClick={() => onSwitch(entry.id)}
              role="button"
              tabIndex={0}
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
              <div key={sub.id} className="subspace-indent" onClick={() => onSwitch(sub.id)} role="button" tabIndex={0}>
                <SpacesIcon />
                {sub.name}
                {sub.kind ? ` · ${sub.kind}` : ""}
              </div>
            ))}
          </React.Fragment>
        ))}
        <div className="switcher-divider" />
        {canCreate && onCreate && (
          <div className="switcher-action" onClick={onCreate} role="button" tabIndex={0}>
            <PlusIcon />
            Create New Space
          </div>
        )}
        {onSettings && (
          <div className="switcher-action" onClick={onSettings} role="button" tabIndex={0}>
            <SettingsIcon />
            Space Settings
          </div>
        )}
        {onHierarchy && (
          <div className="switcher-action" onClick={onHierarchy} role="button" tabIndex={0}>
            <HierarchyIcon />
            View Hierarchy
          </div>
        )}
        <div className="switcher-divider" />
        {onAccount && (
          <div className="switcher-action" onClick={onAccount} role="button" tabIndex={0}>
            <AccountIcon />
            Account
          </div>
        )}
      </div>

      <div className="space-row" onClick={onToggle} role="button" tabIndex={0}>
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
