import * as React from "react";

export interface TopBarProps {
  left?: React.ReactNode;
  children?: React.ReactNode;
  variant?: "default" | "home";
}

export function TopBar({ left, children, variant = "default" }: TopBarProps) {
  return (
    <div className={variant === "home" ? "home-topbar" : "topbar"}>
      {left && <div className="topbar-left">{left}</div>}
      {children && <div className="topbar-actions">{children}</div>}
    </div>
  );
}

export function IconButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className, ...rest } = props;
  return <button type="button" className={["icon-btn", className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}
