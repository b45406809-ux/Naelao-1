import * as React from "react";
import { NavItem, HistoryItem } from "./NavItem";
import { SpaceSwitcher, type SpaceSwitcherEntry } from "./SpaceSwitcher";
import { PlusIcon, ChevronRightIcon, MoreIcon } from "./icons";
import type { IconName } from "./icons";

export interface SidebarNavEntry {
  key: string;
  icon: IconName;
  label: string;
  badge?: React.ReactNode;
}

export interface SidebarListEntry {
  id: string;
  label: string;
  meta?: React.ReactNode;
  icon?: IconName;
}

export interface SidebarProps {
  brandName?: string;
  activeKey: string;
  onNavigate: (key: string) => void;
  primaryNav: SidebarNavEntry[];
  moreNav?: SidebarNavEntry[];
  onNewThread?: () => void;
  projects?: SidebarListEntry[];
  onOpenProject?: (id: string) => void;
  onNewProject?: () => void;
  /** Shown as a trailing "… more projects" row whenever `projects` is longer than the sidebar's
   *  own display cap — same shape as `onMoreThreads` below, which this was missing entirely
   *  (every project rendered unbounded, with no way to see the rest once a business had more
   *  than fit comfortably in the panel). */
  onMoreProjects?: () => void;
  threads?: SidebarListEntry[];
  onOpenThread?: (id: string) => void;
  onNewThread2?: () => void;
  onMoreThreads?: () => void;
  spaceSwitcher?: {
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
  };
  iconOnly?: boolean;
  onToggleCollapse?: () => void;
  /** Below the mockup's 900px breakpoint the sidebar becomes an off-canvas drawer
   *  (`#sidebar.mobile-open` in packages/ui/src/styles.css) — this is what the mobile top bar's
   *  hamburger button toggles. No effect above that breakpoint (the CSS rule only exists inside
   *  the media query), so a caller doesn't need to know the current viewport width itself. */
  mobileOpen?: boolean;
}

/** How many projects render before the sidebar collapses the rest behind "… more projects" —
 *  same idea as the Sessions section only ever fetching 5, kept as a display cap here (rather
 *  than a fetch cap) since the caller already has the full list for other purposes (the active-
 *  project highlight, the create-dialog's duplicate-name check). */
const PROJECTS_SHOWN = 5;

export function Sidebar({
  brandName = "Naelao",
  activeKey,
  onNavigate,
  primaryNav,
  moreNav,
  onNewThread,
  projects,
  onOpenProject,
  onNewProject,
  onMoreProjects,
  threads,
  onOpenThread,
  onMoreThreads,
  spaceSwitcher,
  iconOnly,
  onToggleCollapse,
  mobileOpen,
}: SidebarProps) {
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [projectsOpen, setProjectsOpen] = React.useState(false);
  const [threadsOpen, setThreadsOpen] = React.useState(true);

  return (
    <nav id="sidebar" className={[iconOnly ? "icon-only" : "", mobileOpen ? "mobile-open" : ""].filter(Boolean).join(" ") || undefined}>
      <div className="sidebar-logo">
        <div className="logo-mark">
          <svg viewBox="0 0 14 14">
            <path d="M7 1L12.5 4.25V10.75L7 14L1.5 10.75V4.25L7 1Z" />
          </svg>
        </div>
        <span
          className="sidebar-text"
          style={{ fontFamily: "'Instrument Serif',serif", fontSize: 16, fontWeight: 400, letterSpacing: "-0.01em" }}
        >
          {brandName}
        </span>
        {onToggleCollapse && (
          <button className="sidebar-collapse" onClick={onToggleCollapse} title="Toggle sidebar" type="button">
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor">
              <line x1="5" y1="4" x2="5" y2="12" />
              <line x1="9" y1="6" x2="11" y2="8" />
              <line x1="9" y1="10" x2="11" y2="8" />
            </svg>
          </button>
        )}
      </div>

      {onNewThread && (
        <button className="new-chat-btn" onClick={onNewThread} type="button">
          <PlusIcon />
          <span className="sidebar-text">New Session</span>
        </button>
      )}

      <div className="sidebar-nav">
        {primaryNav.map((item) => (
          <NavItem
            key={item.key}
            icon={item.icon}
            label={item.label}
            active={activeKey === item.key}
            badge={item.badge}
            onClick={() => onNavigate(item.key)}
          />
        ))}
        {moreNav && moreNav.length > 0 && (
          <>
            <div
              className={["nav-item", moreOpen ? "" : ""].filter(Boolean).join(" ")}
              onClick={() => setMoreOpen((v) => !v)}
              role="button"
              tabIndex={0}
            >
              <MoreIcon />
              <span className="sidebar-text">More</span>
              <ChevronRightIcon
                style={{
                  width: 10,
                  height: 10,
                  marginLeft: "auto",
                  transition: "transform 0.2s",
                  transform: moreOpen ? "rotate(90deg)" : "none",
                }}
              />
            </div>
            {moreOpen && (
              <div>
                {moreNav.map((item) => (
                  <NavItem
                    key={item.key}
                    icon={item.icon}
                    label={item.label}
                    active={activeKey === item.key}
                    badge={item.badge}
                    indent
                    onClick={() => onNavigate(item.key)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {projects && (
        <>
          <div
            className="sidebar-section sidebar-text"
            style={{ cursor: "pointer" }}
            onClick={() => setProjectsOpen((v) => !v)}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <ChevronRightIcon
                width={10}
                height={10}
                style={{ transition: "transform 0.2s", transform: projectsOpen ? "rotate(90deg)" : "none" }}
              />
              Projects
            </span>
            {onNewProject && (
              <button
                className="section-add"
                title="New project"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewProject();
                }}
              >
                <PlusIcon />
              </button>
            )}
          </div>
          {projectsOpen && (
            <div>
              {projects.slice(0, PROJECTS_SHOWN).map((p) => (
                <HistoryItem key={p.id} icon="projects" label={p.label} meta={p.meta} onClick={() => onOpenProject?.(p.id)} />
              ))}
              {projects.length > PROJECTS_SHOWN && onMoreProjects && (
                <HistoryItem icon="projects" label="… more projects" muted onClick={onMoreProjects} />
              )}
            </div>
          )}
        </>
      )}

      {threads && (
        <>
          <div
            className="sidebar-section sidebar-text"
            style={{ cursor: "pointer" }}
            onClick={() => setThreadsOpen((v) => !v)}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <ChevronRightIcon
                width={10}
                height={10}
                style={{ transition: "transform 0.2s", transform: threadsOpen ? "rotate(90deg)" : "none" }}
              />
              Sessions
            </span>
            {onNewThread && (
              <button
                className="section-add"
                title="New session"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewThread();
                }}
              >
                <PlusIcon />
              </button>
            )}
          </div>
          {threadsOpen && (
            <div>
              {threads.map((t) => (
                <HistoryItem key={t.id} icon="threads" label={t.label} onClick={() => onOpenThread?.(t.id)} />
              ))}
              {onMoreThreads && (
                <HistoryItem icon="threads" label="… more sessions" muted onClick={onMoreThreads} />
              )}
            </div>
          )}
        </>
      )}

      <div className="sidebar-footer">
        {spaceSwitcher && <SpaceSwitcher {...spaceSwitcher} />}
      </div>
    </nav>
  );
}
