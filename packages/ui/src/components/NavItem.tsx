import * as React from "react";
import type { IconName } from "./icons";
import { ICON_REGISTRY } from "./icons";
import { activateOnKeyboard } from "../keyboard";

export interface NavItemProps {
  icon?: IconName;
  label: string;
  active?: boolean;
  badge?: React.ReactNode;
  indent?: boolean;
  onClick?: () => void;
  trailing?: React.ReactNode;
}

export function NavItem({ icon, label, active, badge, indent, onClick, trailing }: NavItemProps) {
  const Icon = icon ? ICON_REGISTRY[icon] : null;
  return (
    <div
      className={["nav-item", active ? "active" : ""].filter(Boolean).join(" ")}
      style={indent ? { paddingLeft: 24 } : undefined}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-current={active ? "page" : undefined}
      onKeyDown={(event) => activateOnKeyboard(event, () => onClick?.())}
    >
      {Icon && <Icon />}
      <span className="sidebar-text">{label}</span>
      {badge != null && <div className="nav-badge">{badge}</div>}
      {trailing}
    </div>
  );
}

export interface HistoryItemProps {
  icon?: IconName;
  label: string;
  meta?: React.ReactNode;
  muted?: boolean;
  onClick?: () => void;
}

export function HistoryItem({ icon, label, meta, muted, onClick }: HistoryItemProps) {
  const Icon = icon ? ICON_REGISTRY[icon] : null;
  return (
    <div
      className="history-item"
      style={muted ? { color: "var(--text3)", fontSize: 12 } : undefined}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => activateOnKeyboard(event, () => onClick?.())}
    >
      {Icon && <Icon />}
      <span className="sidebar-text">{label}</span>
      {meta != null && <span style={{ fontSize: 10, color: "var(--text3)", marginLeft: "auto" }}>{meta}</span>}
    </div>
  );
}
