import * as React from "react";
import { qrSvg } from "../qr";

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
  const svg = React.useMemo(() => {
    try {
      return qrSvg(value, label ? { title: label } : {});
    } catch {
      return null;
    }
  }, [value, label]);

  if (!svg) return null;
  return (
    <div
      className={className}
      style={{ width: size, height: size, borderRadius: 8, overflow: "hidden", background: "#fff" }}
      // The SVG is built from our own encoder over a string we control — no user markup reaches it.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
