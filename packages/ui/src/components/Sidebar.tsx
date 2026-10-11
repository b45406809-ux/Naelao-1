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
  projectId?: string;
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
  /** Whether `threads` was actually truncated. The "… more sessions" row used to render purely
   *  because a handler was supplied, so an account with three sessions was told there were more —
   *  it is a claim about the data, not a navigation affordance. Defaults to true so existing
   *  callers keep their current behaviour. */
  hasMoreThreads?: boolean;
  projectThreads?: SidebarListEntry[];
  onOpenProjectThread?: (threadId: string, projectId: string) => void;
  onMoreProjectThreads?: () => void;
  hasMoreProjectThreads?: boolean;
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
  hasMoreThreads = true,
  projectThreads,
  onOpenProjectThread,
  onMoreProjectThreads,
  hasMoreProjectThreads = false,
  spaceSwitcher,
  iconOnly,
  onToggleCollapse,
  mobileOpen,
}: SidebarProps) {
  const [moreOpen, setMoreOpen] = React.useState(false);
  // Step 13a: default OPEN so the first few projects list right there with a "… more projects"
  // row (the ask was "list x projects with —more projects—"), while the chevron still collapses.
  const [projectsOpen, setProjectsOpen] = React.useState(true);
  const [threadsOpen, setThreadsOpen] = React.useState(true);
  const [projectThreadsOpen, setProjectThreadsOpen] = React.useState(true);

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
      </div>

      {onToggleCollapse && (
        <button
          className="sidebar-edge-toggle"
          onClick={onToggleCollapse}
          title={iconOnly ? "Open sidebar" : "Collapse sidebar"}
          aria-label={iconOnly ? "Open sidebar" : "Collapse sidebar"}
          type="button"
        >
          {iconOnly ? "›" : "‹"}
        </button>
      )}

      {onNewThread && (
        <button className="new-chat-btn" onClick={onNewThread} type="button">
          <PlusIcon />
          <span className="sidebar-text">New Session</span>
        </button>
      )}

      <div className="sidebar-nav">
        {primaryNav.map((item) => {
          if (item.key !== "projects" || !projects) {
            return <NavItem key={item.key} icon={item.icon} label={item.label} active={activeKey === item.key} badge={item.badge} onClick={() => onNavigate(item.key)} />;
          }
          return (
            <React.Fragment key={item.key}>
              <NavItem
                icon={item.icon}
                label={item.label}
                active={activeKey === item.key}
                badge={item.badge}
                onClick={() => {
                  if (iconOnly && onToggleCollapse) onToggleCollapse();
                  setProjectsOpen((v) => iconOnly ? true : !v);
                }}
                trailing={<ChevronRightIcon className="sidebar-project-chevron" style={{ width: 10, height: 10, marginLeft: "auto", transition: "transform .2s", transform: projectsOpen ? "rotate(90deg)" : "none" }} />}
              />
              {projectsOpen && (
                <div className="sidebar-project-list">
                  {projects.slice(0, PROJECTS_SHOWN).map((p) => (
                    <HistoryItem key={p.id} icon="projects" label={p.label} meta={p.meta} onClick={() => onOpenProject?.(p.id)} />
                  ))}
                  {projects.length > PROJECTS_SHOWN && onMoreProjects && (
                    <HistoryItem icon="projects" label="… more projects" muted onClick={onMoreProjects} />
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
        {moreNav && moreNav.length > 0 && (
          <>
            <div
              className={["nav-item", moreOpen ? "" : ""].filter(Boolean).join(" ")}
              onClick={() => {
                if (iconOnly && onToggleCollapse) onToggleCollapse();
                setMoreOpen((v) => iconOnly ? true : !v);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                if (iconOnly && onToggleCollapse) onToggleCollapse();
                setMoreOpen((v) => iconOnly ? true : !v);
              }}
              role="button"
              tabIndex={0}
            >
              <MoreIcon />
              <span className="sidebar-text">More</span>
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
            <div className="sidebar-history-list">
              {threads.map((t) => (
                <HistoryItem key={t.id} icon="threads" label={t.label} onClick={() => onOpenThread?.(t.id)} />
              ))}
              {onMoreThreads && hasMoreThreads && (
                <HistoryItem icon="threads" label="… more sessions" muted onClick={onMoreThreads} />
              )}
            </div>
          )}
        </>
      )}

      {projectThreads && (
        <>
          <div
            className="sidebar-section sidebar-text"
            style={{ cursor: "pointer" }}
            onClick={() => setProjectThreadsOpen((v) => !v)}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <ChevronRightIcon
                width={10}
                height={10}
                style={{ transition: "transform 0.2s", transform: projectThreadsOpen ? "rotate(90deg)" : "none" }}
              />
              Project threads
            </span>
          </div>
          {projectThreadsOpen && (
            <div className="sidebar-history-list">
              {projectThreads.map((thread) => (
                <HistoryItem
                  key={thread.id}
                  icon="threads"
                  label={thread.label}
                  meta={thread.meta}
                  onClick={() => thread.projectId && onOpenProjectThread?.(thread.id, thread.projectId)}
                />
              ))}
              {onMoreProjectThreads && hasMoreProjectThreads && (
                <HistoryItem icon="threads" label="… more project threads" muted onClick={onMoreProjectThreads} />
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
