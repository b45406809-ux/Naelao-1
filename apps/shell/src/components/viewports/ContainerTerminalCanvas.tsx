"use client";
import * as React from "react";

export function ContainerTerminalCanvas({ lines, connected }: { lines: string[]; connected: boolean }) {
  const end = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => end.current?.scrollIntoView({ block: "end" }), [lines]);
  return <section className="terminal-canvas" data-testid="container-terminal-canvas" aria-label="Container terminal">
    <header><span className={connected ? "terminal-online" : ""}>●</span> container shell <span>{connected ? "streaming" : "waiting"}</span></header>
    <pre>{lines.length ? lines.join("\n") : "$ Waiting for container output…"}</pre><div ref={end} />
  </section>;
}
