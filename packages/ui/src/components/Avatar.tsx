import * as React from "react";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export interface AvatarProps {
  name: string;
  size?: number;
  variant?: "square" | "circle";
}

export function Avatar({ name, size = 29, variant = "square" }: AvatarProps) {
  return (
    <div
      className="space-avatar"
      style={{
        width: size,
        height: size,
        borderRadius: variant === "circle" ? "50%" : 7,
        fontSize: Math.round(size * 0.34),
      }}
    >
      {initialsOf(name)}
    </div>
  );
}
