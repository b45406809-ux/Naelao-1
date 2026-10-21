import * as React from "react";
import { encodeQr } from "../qr";

export interface QrCodeProps {
  /** What the code encodes — normally a URL. */
  value: string;
  /** Rendered edge length in pixels. */
  size?: number;
  /** Describes the code to a screen reader. A QR is meaningless to one otherwise. */
  label?: string;
  className?: string;
}

/**
 * A scannable code, rendered inline as SVG.
 *
 * Deliberately NOT theme-aware: a QR needs real black-on-white contrast to scan, and following the
 * page into dark mode is the obvious change that quietly breaks it for half the users. The white
 * plate is part of the code, not decoration.
 *
 * If the value is too long to encode, this renders nothing rather than a broken frame — every
 * caller shows the raw link alongside, so there is always a way through.
 */
export function QrCode({ value, size = 200, label, className }: QrCodeProps): React.ReactElement | null {
  const encoded = React.useMemo(() => {
    try {
      const grid = encodeQr(value);
      const quietZone = 4;
      let path = "";
      for (let row = 0; row < grid.length; row++) {
        for (let column = 0; column < grid.length; column++) {
          if (grid[row]?.[column]) path += `M${column + quietZone} ${row + quietZone}h1v1h-1z`;
        }
      }
      return { path, viewSize: grid.length + quietZone * 2 };
    } catch {
      return null;
    }
  }, [value]);

  if (!encoded) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${encoded.viewSize} ${encoded.viewSize}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label ?? "QR code"}
      style={{ borderRadius: 8, overflow: "hidden", background: "#fff" }}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{label ?? "QR code"}</title>
      <rect width={encoded.viewSize} height={encoded.viewSize} fill="#fff" />
      <path d={encoded.path} fill="#000" />
    </svg>
  );
}
