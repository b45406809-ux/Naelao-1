import * as React from "react";

export type BadgeColor = "green" | "amber" | "blue" | "purple" | "red";

export interface BadgeProps {
  color: BadgeColor;
  children: React.ReactNode;
  dot?: boolean;
  className?: string;
}

export function Badge({ color, children, dot = true, className }: BadgeProps) {
  return (
    <span className={["badge", `badge-${color}`, className ?? ""].filter(Boolean).join(" ")}>
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}
