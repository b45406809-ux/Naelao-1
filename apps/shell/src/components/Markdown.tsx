"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Chat text rendered as markdown.
 *
 * Until now every bubble rendered its content as a raw React text child, so an assistant reply
 * arrived with its `**bold**`, `- bullets` and ``` fences intact as literal characters — while
 * `packages/ui/src/styles.css` had been carrying finished styles for `.bubble p/ul/strong/em/
 * pre/code` the whole time with nothing ever emitting those elements.
 *
 * `react-markdown` rather than `marked`/`showdown` for one reason that matters here: it builds
 * React elements and never touches `dangerouslySetInnerHTML`. An agent in this product renders
 * web-fetched pages, customer emails and connector output into these bubbles — content this
 * platform explicitly treats as untrusted everywhere else — so a renderer that cannot inject HTML
 * at all is worth more than the bundle it costs. For the same reason `rehype-raw` is deliberately
 * NOT installed: inline HTML in markdown stays inert text.
 *
 * Links open in a new tab with `noopener noreferrer` — a chat reply is the one place in this app
 * where the href is routinely chosen by a model rather than by us.
 */

const COMPONENTS = {
  a: ({
    href,
    children,
  }: { href?: string | undefined; children?: React.ReactNode }) => {
    // Citation URLs are immutable stream markers, not navigable bucket URLs. Chat mounts the
    // authenticated CitationBadges resolver; Markdown only renders an inert escaped marker.
    if (href?.startsWith("citation:"))
      return <span className="citation-marker">{children}</span>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
} as const;

function MarkdownImpl({ text }: { text: string }): React.ReactElement {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS as never}>
      {text}
    </ReactMarkdown>
  );
}

/**
 * Memoised on the exact text. This renders on every tick of a reveal animation and on every poll
 * of a growing answer, and re-parsing an unchanged string each time is pure waste.
 */
export const Markdown = React.memo(MarkdownImpl, (a, b) => a.text === b.text);
