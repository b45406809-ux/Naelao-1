"use client";

export const runtime = "edge";

// The Assistant DASHBOARD — what this assistant is, what it can do, and what it has been doing.
//
// This page used to render the chat itself, which conflated two different things: talking to the
// assistant (a conversation, now at /assistant/chat) and understanding it (this page). Every
// panel is a read-only consumer of an already-built endpoint; nothing here fabricates a number
// it cannot actually read.
//
// Authoring — writing a skill, editing the system prompt — is deliberately NOT here. Those are
// builder operations against the operator's own accumulated work, and the end-user shell is a
// structurally different population; the builder dashboard is where that belongs. The "add"
// affordances below say so plainly rather than presenting a dead button.

import * as React from "react";
import Link from "next/link";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  getAssistantPolicy,
  getAssistantMemory,
  getAssistantCapabilities,
  listScheduledJobs,
  listAssistantChannels,
  listAssistantFiles,
  listSessions,
  listAgentDefinitions,
  type AssistantPolicy,
  type MemoryFact,
  type AssistantCapabilities,
  type ScheduledJob,
  type ChannelLink,
  type WorkspaceFile,
  type SessionSummary,
  type AgentDefinitionSummary,
} from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";

function Card({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number | undefined;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg2)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0, flex: 1 }}>
          {title}
          {count !== undefined && (
            <span style={{ color: "var(--text3)", fontWeight: 400, marginLeft: 6 }}>{count}</span>
          )}
        </h2>
        {action}
      </header>
      <div style={{ padding: "10px 14px", fontSize: 12.5, color: "var(--text2)" }}>{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ color: "var(--text3)", fontSize: 12 }}>{children}</div>;
}

function Row({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
      <div style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{left}</div>
      {right !== undefined && <div style={{ color: "var(--text3)", fontSize: 11, flexShrink: 0 }}>{right}</div>}
    </div>
  );
}

export default function AssistantDashboardPage() {
  const product = useProduct();
  const { session } = useProductAuth();
  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;
  const { activeSpaceId, activeSpaceName } = useActiveSpace();

  const [policy, setPolicy] = React.useState<AssistantPolicy | null>(null);
  const [capabilities, setCapabilities] = React.useState<AssistantCapabilities | null>(null);
  const [memory, setMemory] = React.useState<MemoryFact[]>([]);
  const [crons, setCrons] = React.useState<ScheduledJob[]>([]);
  const [channels, setChannels] = React.useState<ChannelLink[]>([]);
  const [files, setFiles] = React.useState<WorkspaceFile[]>([]);
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [agents, setAgents] = React.useState<AgentDefinitionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!creds || !activeSpaceId) return;
    let cancelled = false;
    setLoading(true);
    // Each panel settles independently: one unavailable endpoint must not blank the whole page.
    const settle = <T,>(p: Promise<T>, set: (v: T) => void) =>
      p.then((v) => { if (!cancelled) set(v); }).catch(() => {});

    Promise.allSettled([
      settle(getAssistantPolicy(activeSpaceId, creds), setPolicy),
      settle(getAssistantCapabilities(activeSpaceId, creds), setCapabilities),
      settle(getAssistantMemory(activeSpaceId, creds), setMemory),
      settle(listScheduledJobs(activeSpaceId, creds), setCrons),
      settle(listAssistantChannels(activeSpaceId, creds), setChannels),
      settle(listAssistantFiles(activeSpaceId, creds), setFiles),
      settle(listSessions(activeSpaceId, creds), setSessions),
      settle(listAgentDefinitions(activeSpaceId, creds), setAgents),
    ]).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [creds, activeSpaceId]);

  if (!creds) return null;

  const modeLabel =
    policy?.approval_mode === "yolo"
      ? "Autonomous"
      : policy?.approval_mode === "gate_unless_listed"
        ? "Guided"
        : policy?.approval_mode === "gate_listed"
          ? "Mostly autonomous"
          : policy?.approval_mode === "always_ask"
            ? "Asks before acting"
            : "—";

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 40px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 20, fontWeight: 650, color: "var(--text)", margin: 0 }}>
            {activeSpaceName ? `${activeSpaceName} Assistant` : "Space Assistant"}
          </h1>
          <p style={{ fontSize: 12.5, color: "var(--text3)", margin: "4px 0 0" }}>
            Always on. Works across every project in this space, and can be reached over your connected channels.
          </p>
        </div>
        <Link
          href={`/p/${product.slug}/assistant/chat`}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            background: "var(--accent)",
            color: "#fff",
            fontSize: 13,
            fontWeight: 550,
            textDecoration: "none",
            flexShrink: 0,
          }}
        >
          Talk to the assistant
        </Link>
      </div>

      {loading && <div style={{ fontSize: 12.5, color: "var(--text3)", marginBottom: 14 }}>Loading…</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
        <Card title="Configuration">
          <Row left="Autonomy" right={modeLabel} />
          <Row left="Pre-approved actions" right={String(policy?.auto_approved_actions?.length ?? 0)} />
          {policy?.auto_approved_actions?.length ? (
            <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text3)", lineHeight: 1.6 }}>
              {policy.auto_approved_actions.join(", ")}
            </div>
          ) : (
            <Empty>Every action is confirmed with you before it happens.</Empty>
          )}
          <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text3)" }}>
            Autonomy is changed by the space owner in the builder dashboard.
          </div>
        </Card>

        <Card title="Built-in scripts" count={capabilities?.prebuilt_count}>
          {capabilities?.prebuilts?.length ? (
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {capabilities.prebuilts.map((p) => (
                <Row key={p.name} left={<span title={p.description}>{p.name}</span>} right={`${p.operations.length} ops`} />
              ))}
            </div>
          ) : (
            <Empty>Couldn&apos;t read the capability list.</Empty>
          )}
        </Card>

        <Card title="Learned skills" count={capabilities?.skill_count}>
          {capabilities?.skills?.length ? (
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {capabilities.skills.map((s) => <Row key={s.name} left={s.name} />)}
            </div>
          ) : (
            <Empty>
              None yet. The assistant writes these itself as it solves things — they build up with use rather than
              being added by hand.
            </Empty>
          )}
        </Card>

        <Card title="Recent conversations" count={sessions.length}>
          {sessions.length === 0 ? (
            <Empty>No conversations yet.</Empty>
          ) : (
            sessions.slice(0, 8).map((s) => (
              <Row
                key={s.id}
                left={
                  <Link
                    href={`/p/${product.slug}/sessions/${s.id}`}
                    style={{ color: "var(--text2)", textDecoration: "none" }}
                  >
                    {s.title || "Untitled conversation"}
                  </Link>
                }
                right={relativeTime(s.updated_at || s.created_at)}
              />
            ))
          )}
        </Card>

        <Card title="What it remembers" count={memory.length}>
          {memory.length === 0 ? (
            <Empty>Nothing learned yet.</Empty>
          ) : (
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {memory.slice(0, 20).map((m, i) => (
                <Row
                  key={`${m.key}-${i}`}
                  left={`${m.key}: ${typeof m.value === "string" ? m.value : JSON.stringify(m.value)}`}
                  right={m.category}
                />
              ))}
            </div>
          )}
        </Card>

        <Card title="Scheduled work" count={crons.length}>
          {crons.length === 0 ? (
            <Empty>Nothing scheduled. Ask the assistant to do something on a recurring basis and it will appear here.</Empty>
          ) : (
            crons.map((j) => (
              <Row
                key={j.id}
                left={j.name || j.id}
                right={j.enabled ? j.cron_expression : "paused"}
              />
            ))
          )}
        </Card>

        <Card title="Channels" count={channels.length}>
          {channels.length === 0 ? (
            <Empty>No channels connected. Connect Slack, Discord, email or WhatsApp to reach the assistant there.</Empty>
          ) : (
            channels.map((c) => (
              <Row
                key={c.channel}
                left={<span style={{ textTransform: "capitalize" }}>{c.channel}</span>}
                right={c.enabled ? "Connected" : "Off"}
              />
            ))
          )}
        </Card>

        <Card title="Agents in this space" count={agents.length}>
          {agents.length === 0 ? (
            <Empty>No specialist agents configured.</Empty>
          ) : (
            agents.slice(0, 10).map((a) => (
              <Row key={a.id} left={a.name || a.id} right={a.description ? undefined : "—"} />
            ))
          )}
        </Card>

        <Card title="Workspace files" count={files.length}>
          {files.length === 0 ? (
            <Empty>No files yet.</Empty>
          ) : (
            <div style={{ maxHeight: 200, overflowY: "auto" }}>
              {files.slice(0, 25).map((f) => (
                <Row key={f.path} left={f.path} right={`${Math.max(1, Math.round(f.size / 1024))} KB`} />
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
