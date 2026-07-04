import * as React from "react";

export type IconProps = React.SVGAttributes<SVGSVGElement>;

function svg(children: React.ReactNode) {
  return function IconComponent(props: IconProps) {
    return (
      <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor" {...props}>
        {children}
      </svg>
    );
  };
}

export const HomeIcon = svg(<path d="M2 6.5L8 2L14 6.5V14H10V10H6V14H2V6.5Z" />);
export const SpacesIcon = svg(
  <>
    <rect x="2" y="2" width="5.5" height="5.5" rx="1.5" />
    <rect x="8.5" y="2" width="5.5" height="5.5" rx="1.5" />
    <rect x="2" y="8.5" width="5.5" height="5.5" rx="1.5" />
    <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1.5" />
  </>
);
export const AssistantIcon = svg(<path d="M8 1L14 4.5V11.5L8 15L2 11.5V4.5L8 1Z" />);
export const ProjectsIcon = svg(<path d="M2 4H6L7 5H14V13H2V4Z" />);
export const MoreIcon = svg(
  <>
    <circle cx="4" cy="8" r="1.2" fill="currentColor" />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" />
    <circle cx="12" cy="8" r="1.2" fill="currentColor" />
  </>
);
export const AgentsIcon = svg(
  <>
    <rect x="3" y="3" width="10" height="10" rx="2" />
    <circle cx="6" cy="7" r="1" />
    <circle cx="10" cy="7" r="1" />
    <path d="M6 10C6 10 7 11 10 10" />
  </>
);
export const KnowledgeIcon = svg(
  <>
    <path d="M3 3H9L13 7V13H3V3Z" />
    <polyline points="9,3 9,7 13,7" />
  </>
);
export const MarketplaceIcon = svg(
  <>
    <path d="M2 2H4L5.5 10H12.5L14 4H5" />
    <circle cx="7" cy="13" r="1" />
    <circle cx="11.5" cy="13" r="1" />
  </>
);
export const WorkflowsIcon = svg(
  <>
    <circle cx="3" cy="4" r="1.5" />
    <circle cx="13" cy="4" r="1.5" />
    <circle cx="3" cy="12" r="1.5" />
    <circle cx="13" cy="12" r="1.5" />
    <line x1="4.5" y1="4" x2="11.5" y2="4" />
    <line x1="3" y1="5.5" x2="3" y2="10.5" />
    <line x1="4.5" y1="12" x2="11.5" y2="12" />
  </>
);
export const AnalyticsIcon = svg(
  <>
    <rect x="2" y="10" width="3" height="4" />
    <rect x="6.5" y="6" width="3" height="8" />
    <rect x="11" y="2" width="3" height="12" />
  </>
);
export const ExploreIcon = svg(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M10.5 5.5L9 9L5.5 10.5L7 7L10.5 5.5Z" />
  </>
);
export const SettingsIcon = svg(
  <>
    <circle cx="8" cy="8" r="2.5" />
    <path d="M8 1V2.5M8 13.5V15M1 8H2.5M13.5 8H15" />
  </>
);
export const PlusIcon = svg(
  <>
    <line x1="8" y1="3" x2="8" y2="13" />
    <line x1="3" y1="8" x2="13" y2="8" />
  </>
);
export const ChevronRightIcon = svg(<polyline points="6,4 10,8 6,12" />);
export const ChevronDownIcon = svg(<polyline points="4,6 8,10 12,6" />);
export const CheckIcon = svg(<polyline points="3,8 6,11 13,4" />);
export const CloseIcon = svg(
  <>
    <line x1="4" y1="4" x2="12" y2="12" />
    <line x1="12" y1="4" x2="4" y2="12" />
  </>
);
export const ThreadIcon = svg(
  <>
    <path d="M4 2H10L13 5V14H4V2Z" />
    <polyline points="10,2 10,5 13,5" />
  </>
);
export const AccountIcon = svg(
  <>
    <circle cx="8" cy="5" r="3" />
    <path d="M2 14C2 11.2 4.7 9 8 9S14 11.2 14 14" />
  </>
);
export const HierarchyIcon = svg(
  <>
    <path d="M8 2V5M4 9V12M12 9V12M4 5H12M4 8V5M12 8V5" />
    <circle cx="8" cy="2" r="1.5" />
    <circle cx="4" cy="12" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
  </>
);
export const MenuIcon = svg(
  <>
    <line x1="2" y1="4" x2="14" y2="4" />
    <line x1="2" y1="8" x2="14" y2="8" />
    <line x1="2" y1="12" x2="14" y2="12" />
  </>
);

export const ICON_REGISTRY = {
  home: HomeIcon,
  spaces: SpacesIcon,
  assistant: AssistantIcon,
  projects: ProjectsIcon,
  agents: AgentsIcon,
  knowledge: KnowledgeIcon,
  marketplace: MarketplaceIcon,
  workflows: WorkflowsIcon,
  analytics: AnalyticsIcon,
  explore: ExploreIcon,
  settings: SettingsIcon,
  threads: ThreadIcon,
} as const;

export type IconName = keyof typeof ICON_REGISTRY;
