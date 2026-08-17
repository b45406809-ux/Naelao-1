"use client";

// The business assistant speaking INTO a project thread on the owner's behalf, plus whichever
// agent replied — rendered as ONE collapsible card rather than two adjacent left-aligned bubbles.
//
// Why: `thread.send_message` writes the assistant's turn and the target agent writes its own reply
// into the same transcript, so without grouping the thread reads as one speaker asking a question
// and then answering it. Worse, nothing distinguished the BUSINESS ASSISTANT (acting autonomously
// for the owner) from the project agent that actually does the work — which is exactly the
// distinction a person scanning the thread needs.
//
// Collapsed shows only who asked whom. Expanded shows the assistant's message and the reply.
// Deliberately the same visual language as the consult-subthread card (SubthreadEntry) — both are
// "a real exchange that happened alongside this conversation", just one visible and one private.

import * as React from "react";
import { Markdown } from "./Markdown";
import type { Message } from "@/lib/api";

function agentDisplayName(id?: string | null): string {
  if (!id) return "a project agent";
  return id
    .replace(/^launchpad-/, "")
    .replace(/-v\d+$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function AssistantDelegationCard({
  request,
  reply,
}: {
  /** The assistant's own message (the one carrying metadata.assistant_delegation). */
  request: Message;
  /** The agent's reply, when it has arrived. Absent while still running, or for respond:false. */
  reply?: Message | undefined;
}) {
  const [open, setOpen] = React.useState(false);
  const delegation = request.metadata?.assistant_delegation;
  const who = agentDisplayName(delegation?.agent_id);
  const awaiting = delegation?.awaiting_reply !== false && !reply;

  // Inline styles rather than classes, matching SubthreadEntry (the consult card) exactly — the
  // two are siblings and should read as the same kind of object.
  return (
    <div style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, margin: "6px 0 10px", overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "8px 10px", background: "transparent", border: "none",
          cursor: "pointer", textAlign: "left", fontSize: 12, color: "var(--text2, #555)",
        }}
      >
        <span style={{ color: "var(--text3)" }} aria-hidden>{open ? "−" : "+"}</span>
        <span style={{ fontWeight: 600 }}>Business assistant → {who}</span>
        <span style={{ marginLeft: "auto", color: "var(--text3)" }}>
          {awaiting ? "waiting for a reply" : open ? "hide" : "show exchange"}
        </span>
      </button>
      {open && (
        <div style={{ padding: "0 10px 10px", fontSize: 12 }}>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 600, color: "var(--text3)", marginBottom: 2 }}>
              Business assistant · on your behalf
            </div>
            <Markdown text={request.content} />
          </div>
          {reply ? (
            <div>
              <div style={{ fontWeight: 600, color: "var(--text3)", marginBottom: 2 }}>{who}</div>
              <Markdown text={reply.content} />
            </div>
          ) : (
            <div style={{ color: "var(--text3)", fontStyle: "italic" }}>
              {delegation?.awaiting_reply === false
                ? "Posted without asking for a reply."
                : "No reply yet."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Groups a transcript so an assistant-delegation message swallows the agent reply that follows it.
 *
 * Returns render instructions rather than mutating the list: each entry is either an ordinary
 * message or a delegation pair, so the caller keeps full control of bubble rendering for
 * everything else.
 */
export type RenderItem =
  | { kind: "message"; message: Message }
  | { kind: "delegation"; request: Message; reply?: Message };

export function groupDelegations(messages: Message[]): RenderItem[] {
  const out: RenderItem[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const delegation = m.metadata?.assistant_delegation;
    if (!delegation) {
      out.push({ kind: "message", message: m });
      continue;
    }
    // The reply is the next message, but only when it's genuinely the delegated agent answering
    // — not a person who typed in the meantime, and not another delegation. Anything else stays
    // its own bubble, so a card can never swallow an unrelated turn.
    const next = messages[i + 1];
    const isReply =
      !!next &&
      next.role === "assistant" &&
      !next.metadata?.assistant_delegation &&
      (!delegation.agent_id || !next.author_id || next.author_id === delegation.agent_id);
    if (isReply) {
      out.push({ kind: "delegation", request: m, reply: next });
      i++; // consumed
    } else {
      out.push({ kind: "delegation", request: m });
    }
  }
  return out;
}
