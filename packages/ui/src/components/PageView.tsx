import * as React from "react";

export interface PageViewProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function PageView({ title, subtitle, actions, children }: PageViewProps) {
  return (
    <div className="page-view">
      <div className="page-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div className="page-title">{title}</div>
          {subtitle && <div className="page-subtitle">{subtitle}</div>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}
