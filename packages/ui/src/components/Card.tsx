import * as React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export function Card({ interactive = true, className, children, ...rest }: CardProps) {
  return (
    <div
      className={["card", className ?? ""].filter(Boolean).join(" ")}
      style={interactive ? undefined : { cursor: "default" }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardLabel({ children }: { children: React.ReactNode }) {
  return <div className="card-label">{children}</div>;
}

export function CardValue({ children }: { children: React.ReactNode }) {
  return <div className="card-value">{children}</div>;
}

export function CardSub({ children }: { children: React.ReactNode }) {
  return <div className="card-sub">{children}</div>;
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return <div className="card-title">{children}</div>;
}

export function CardDesc({ children }: { children: React.ReactNode }) {
  return <div className="card-desc">{children}</div>;
}
