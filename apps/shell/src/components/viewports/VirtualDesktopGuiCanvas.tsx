"use client";
import * as React from "react";

export function VirtualDesktopGuiCanvas({ streamUrl, frameUrl }: { streamUrl?: string; frameUrl?: string }) {
  if (streamUrl) return <iframe data-testid="virtual-desktop-gui-canvas" className="desktop-frame" title="Container virtual desktop" src={streamUrl} allow="clipboard-read; clipboard-write" />;
  return <div data-testid="virtual-desktop-gui-canvas" className="desktop-frame desktop-placeholder">{frameUrl ? <img src={frameUrl} alt="Live container desktop frame" /> : <><span>🖥️</span><strong>Virtual display is starting</strong><small>Xvfb · Fluxbox · secured stream</small></>}</div>;
}
