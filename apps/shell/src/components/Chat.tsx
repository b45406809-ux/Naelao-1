"use client";

// Chat surface — ported from apps/portal/src/app/[spaceId]/page.tsx's proven SSE client
// (Three-Tier Platform Model, Phase 6), restyled onto the launchpad-6 mockup's markup/classes
// instead of Tailwind. The side panel's Stats/Assistant tabs render inline below; everything
// else (Config, Memory, Crons, Channels, Sub-agents, Files, Skills, Notifications) is the shared
// AssistantSidePanels component, used identically here and formerly on the now-removed
// /dashboard/chat page — Artifacts stays a real "coming soon" (no backend for generated
// deliverables exists yet, unlike the rest of this list).

import * as React from "react";
import Link from "next/link";
import {
  ApiError,
  getMessages,
  getStreamUrl,
  getApprovalResumeStatus,
  listApprovals,
  pollRun,
  getActiveRun,
  cancelRun,
  mergeActivitySteps,
  sendMessage,
  startSession,
  truncateMessagesFrom,
  type AgentRun,
  type Message,
  type LiveRunStep,
  type PendingApproval,
  getInterruptedRun,
  resolveInterruptedRun,
  getAgentRunTrace,
  promoteSessionIfHeartbeat,
  type InterruptedRun,
  type ChatUpload,
  getProject,
  listAgentDefinitions,
  listBusinessMembers,
  getConnectorStatus,
  type AgentDefinitionSummary,
  type BusinessMember,
  type ConnectorInfo,
  getShellManifest,
} from "@/lib/api";
import type { SessionCredentials } from "@/lib/api";
import type { Project } from "@/lib/api";
import {
  getChatSessionId,
  storeChatSessionId,
  clearChatSessionId,
  getActiveRunId,
  storeActiveRunId,
  clearActiveRunId,
} from "@/lib/chatSession";
import {
  getPreferredModel,
  storePreferredModel,
  getPreferredEffort,
  storePreferredEffort,
} from "@/lib/modelPreference";
import { ALLOWED_MODELS, DEFAULT_WORKING_MODEL, benchmarkForModel, nativeReasoningForEffort, isValidEffortLevel, effortOptionsForModel, type EffortLevel } from "@naelao/billing-core";
import { ContextUsageMeter } from "./ContextUsageMeter";
import { AssistantSidePanelBody, sidePanelTabs, type SidePanelTab } from "./AssistantSidePanels";
import { SubthreadPanel, SubthreadEntry } from "./SubthreadPanel";
import { AssistantDelegationCard, groupDelegations } from "./AssistantDelegationCard";
import { ActivitySequence, RevealText } from "./ActivityFeed";
import { InterruptedRunCard } from "./InterruptedRunCard";
import { MessageActions } from "./MessageActions";
import { InlineApprovalCard } from "./InlineApprovalCard";
import { InlineQuestionCard } from "./InlineQuestionCard";
import { InlineConnectorCard } from "./InlineConnectorCard";
import { InlineArtifactCard } from "./InlineArtifactCard";
import { ExtensionWidgetCard } from "./ExtensionWidgetCard";
import { InlinePullRequestCard } from "./InlinePullRequestCard";
import { ProjectPullRequestPanel } from "./ProjectPullRequestPanel";
import { UpgradeDialog } from "./UpgradeDialog";
import { SecurityBoundaryCard } from "./SecurityBoundaryCard";
import { ComposerDock } from "./ComposerDock";
import { CitationBadges } from "./CitationBadge";
import { CanvasContainer, type CanvasView } from "./CanvasContainer";
import type { InspectedElement } from "./HtmlPreviewFrame";
import { useActiveSpace } from "@/lib/active-space-context";
import type { ThreadSummary, ConsultedThread } from "@/lib/api";
import { modelLabel } from "./ModelSelector";
import { userFacingErrorMessage } from "@/lib/user-facing-errors";
import { isTrustedDomInspectionMessage } from "@/lib/dom-inspector-message";
import { OwnerVoiceCall } from "./OwnerVoiceCall";

const POLL_INTERVAL_MS = 1500;
// A STALL deadline, not a total cap. It used to be a flat 60s ceiling on the whole run, which
// fired "Timed out waiting for a response" even while the agent was legitimately still working —
// routine now that a multi-step research/delegation run is unbounded and easily runs past a
// minute. The deadline is reset every tick that shows real progress (a new step, or the reply
// growing), so a run that keeps moving never trips it; it only fires after this long with NO
// progress at all — a genuine stall. Even then the run is durable and keeps going server-side, so
// the foreground surfaces a soft "still running in the background" notice (reattached on the next
// reload/interaction) rather than a red error.
const STALL_TIMEOUT_MS = 120_000;
// A run that failed on one of these is not just "an error" — there's something real to DO about
// it (buy credits, resubscribe, wait for a quota reset), so it gets the UpgradeDialog instead of
// a bare red banner. See UpgradeDialog's own doc for what each code offers.
const BILLING_ERROR_CODES = new Set(["insufficient_credits", "subscription_inactive", "quota_exceeded", "infra_quota_exceeded"]);

type WorkspaceTab = "stats" | "assistant" | "threads" | "messages" | "model" | "connectors" | "members" | SidePanelTab | `canvas:${string}`;

function workspaceTabIcon(tab: WorkspaceTab): string {
  if (tab.startsWith("canvas:")) return "◫";
  switch (tab) {
    case "stats": return "∿";
    case "assistant": return "✦";
    case "threads": return "#";
    case "messages": return "≡";
    case "model": return "◈";
    case "connectors": return "⌁";
    case "members": return "♙";
    case "config": return "⚙";
    case "memory": return "◉";
    case "crons": return "◷";
    case "channels": return "⌁";
    case "heartbeats": return "♥";
    case "sub-agents": return "↗";
    case "files": return "□";
    case "artifacts": return "▧";
    case "skills": return "✣";
    case "notifications": return "♢";
    case "local-machine": return "▦";
  }
  return "•";
}

const BUILTIN_WORKSPACE_TABS = new Set<string>([
  "stats", "assistant", "threads", "messages", "model", "connectors", "members",
  "config", "memory", "crons", "channels", "heartbeats", "sub-agents", "files",
  "artifacts", "skills", "notifications", "local-machine",
]);

function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  return typeof value === "string" && (BUILTIN_WORKSPACE_TABS.has(value) || value.startsWith("canvas:"));
}

function providerForModel(model: string): string {
  const prefix = model.split("/")[0] ?? "other";
  return prefix.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A display name for whoever produced a message, or null when it needs no label.
 *
 *  Deliberately silent for the Space Assistant and for the person typing: labelling every bubble
 *  in an ordinary two-party chat is clutter. The case this exists for is a thread where a named
 *  project agent has also spoken — there, "who said this" is real information. */
function authorLabel(m: Message): string | null {
  if (m.author_type !== "agent" || !m.author_id) return null;
  return m.author_id
    .replace(/^launchpad-/, "")
    .replace(/-v\d+$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function messagePreview(message: Message): string {
  const text = message.content.replace(/\s+/g, " ").trim();
  return text.length > 86 ? `${text.slice(0, 83)}…` : text || "Empty message";
}

/** item 79: a message's own metadata carries just enough to render the SAME expandable card
 *  SubthreadPanel already knows how to render — building a minimal ThreadSummary-shaped object
 *  from it rather than a second component, so expand/fetch-messages logic exists in one place. */
function consultThreadSummary(spaceId: string, c: ConsultedThread): ThreadSummary {
  return {
    id: c.thread_id,
    space_id: spaceId,
    project_id: null,
    title: c.title,
    status: "active",
    thread_kind: "sub_agent",
    parent_thread_id: null,
    session_id: c.session_id ?? null,
    created_at: "",
    updated_at: "",
  };
}

/** Reload-safe counterpart to <ActivitySequence>: a message's client-only `activity` is gone the
 *  moment the page reloads, but the run's own id (metadata.run_id) and its persisted trace
 *  (run_traces, §A1 HX1) both survive. Auto-loads on mount and renders in the SAME expanded shape
 *  the sequence had while streaming (narration lines visible, per-tool-call segments collapsed
 *  exactly like the live view) — previously this sat behind a "Show activity" button, so a reload
 *  visibly regressed a message from "the full sequence, right there" to "click to maybe see it
 *  again," which is backwards: nothing about a run is more hideable after the fact than while it
 *  was happening. The cost is real (a long conversation fires one trace request per past
 *  assistant message on mount) and accepted deliberately, not overlooked. */
function PersistedActivitySequence({
  spaceId, sessionId, runId, session,
}: { spaceId: string; sessionId: string; runId: string; session: SessionCredentials }) {
  const [steps, setSteps] = React.useState<LiveRunStep[] | null>(null);
  const [tried, setTried] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setSteps(null);
    setTried(false);
    (async () => {
      try {
        const s = await getAgentRunTrace(spaceId, sessionId, runId, session);
        if (!cancelled) setSteps(s);
      } catch {
        if (!cancelled) setSteps([]); // a failed fetch degrades to "nothing to show", not a stuck spinner
      } finally {
        if (!cancelled) setTried(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // spaceId/sessionId/runId are the whole identity of what to fetch — session is read once per
    // mount, not tracked as a reactive dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, sessionId, runId]);

  // A persisted/reloaded run never animates — it already happened, this is just re-fetching the
  // record of it.
  if (steps) return <ActivitySequence steps={steps} animate={false} />;
  if (tried) return null; // fetched and genuinely empty — same "renders nothing" rule ActivitySequence itself follows
  return (
    <div style={{ fontSize: 12, color: "var(--text3)", padding: "2px 0", margin: "4px 0" }}>
      Loading activity…
    </div>
  );
}

export function Chat({
  spaceId,
  session,
  sessionKey = "home",
  title = "New thread",
  supportContact,
  sessionId,
  initialMessage,
  threadId,
  projectId,
  project,
  projectThreads = [],
  slug,
}: {
  spaceId: string;
  session: SessionCredentials;
  sessionKey?: string;
  title?: string;
  /** Support URL/mailto shown when an error indicates a credits/billing problem. */
  supportContact?: string | null;
  /** An explicit, already-created session (the /sessions/:id route). When given, this is the
   *  session — the sessionStorage cache is bypassed entirely, so opening a specific conversation
   *  by URL can never resurrect a different one the tab happened to have cached. */
  sessionId?: string;
  /** Sent once, automatically, on mount. Home mints a session from the user's opening line and
   *  hands it over here rather than duplicating the whole chat surface on the landing page. */
  initialMessage?: string;
  /** The structural project-thread id (SpaceDO `threads`), when this Chat renders a project
   *  thread rather than the top-level assistant session. Only threads have an "Assistant" tab —
   *  a Home/assistant session has no separate agent to consult, so there's no second lane to
   *  show (§A1.18 thread model: "this is fine in assistant sessions"). */
  threadId?: string;
  /** The PROJECT this thread lives in, when there is one — distinct from threadId (a structural
   *  id) because this is what the Naelao Agent Templates switcher and upload workspace scoping
   *  both key off. Absent for an assistant session, same as threadId. */
  projectId?: string;
  /** Project data is present on project threads so its canvas and thread rail can live in the
   *  same floating workspace card as Stats, Config, Files, and the other tools. */
  project?: Project;
  projectThreads?: ThreadSummary[];
  slug?: string;
}) {
  // Only used to label/scope the composer dock. Compared against the space this Chat was actually
  // given: the dock's member stack must never describe a DIFFERENT space than the conversation
  // belongs to, which is possible during a space switch before this component remounts.
  const { activeSpaceId, activeSpaceName, isBusinessSpace } = useActiveSpace();
  const dockIsBusinessSpace = isBusinessSpace && activeSpaceId === spaceId;
  // Existing assistant sessions use the same conversation surface as project threads. The
  // project-only tabs still key off threadId below, but the header/model/composer treatment is
  // shared by both durable conversation routes.
  const conversationMode = Boolean(threadId || sessionId);

  const [chatSessionId, setChatSessionId] = React.useState<string | null>(sessionId ?? null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  // Read at call time (not captured in a callback's own closure, which can be stale by the time a
  // retry actually fires) by continueInterruptedRun / InterruptedRunCard's onContinued — see
  // resumeOriginRef's own comment for why this matters: a retry that succeeds should fold its
  // answer into the SAME bubble the earlier attempt for this exchange already produced, the way a
  // few extra tool calls after an approval already do, instead of every retry starting a new one.
  const messagesRef = React.useRef<Message[]>(messages);
  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // The last assistant message's own persisted run id, once messages have loaded — see the
  // Sub-agents panel's lastRunId prop for why this exists (lastRun itself is client-only state,
  // gone on reload).
  const latestPersistedRunId = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role !== "user" && m.metadata?.run_id) return m.metadata.run_id;
    }
    return undefined;
  }, [messages]);
  const [input, setInput] = React.useState("");
  const [isLoading, setIsLoading] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [streamingContent, setStreamingContent] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  // A billing-gate failure (insufficient_credits / subscription_inactive / quota_exceeded /
  // infra_quota_exceeded) — rendered as UpgradeDialog instead of `error`'s bare banner, since
  // there's a real purchase/upgrade action to offer rather than just something to read.
  const [billingWall, setBillingWall] = React.useState<{ code: string; message: string } | null>(null);
  // A transient network/gateway hiccup being retried, live — Claude Code CLI's own "retrying…
  // (attempt x/10)" style, so a blip that clears itself a second later never has to read as an
  // outright failure the user must retype their message over. Cleared the moment a call succeeds
  // or the retry budget is genuinely exhausted (at which point `error` takes over instead).
  const [retryStatus, setRetryStatus] = React.useState<{ attempt: number; max: number } | null>(null);
  // Self-healing, Claude-Code-/goal-style: most run failures don't need a person — the agent gets
  // to try fixing its own mistake (a bad tool call, running out of steps) immediately, and a
  // provider quota/rate-limit clears on its own so it's worth a few backed-off retries before
  // bothering anyone. Only a genuinely human-shaped failure (a spend cap, an unreachable model, a
  // real approval) still shows the manual InterruptedRunCard — see refreshInterrupted below for
  // the actual decision, which reads the server's own classifyFailure verdict per interrupted run.
  const [selfHealStatus, setSelfHealStatus] = React.useState<{ mode: "fixing" | "waiting"; attempt: number; max: number } | null>(null);
  const autoHealAttemptsRef = React.useRef(0);
  const quotaRetryAttemptsRef = React.useRef(0);
  const selfHealTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // attachToRun itself needs streamRun (defined further down), and refreshInterrupted (defined
  // further UP, since pollUntilDone/streamRun both call it) needs to invoke a continuation via
  // attachToRun — a genuine mutual dependency a plain closure can't satisfy in declaration order.
  // A ref breaks the cycle: it's assigned fresh every render right after attachToRun is defined,
  // so by the time continueInterruptedRun actually RUNS (never during the initial render), it's
  // always pointing at the current one.
  const attachToRunRef = React.useRef<(sid: string, runId: string) => void>(() => {});
  const [initializing, setInitializing] = React.useState(true);
  // Starts true to match server-rendered markup (no window at SSR time, so a lazy-viewport-check
  // initializer here would hydration-mismatch). On desktop that's the right default — a docked
  // 260px column beside the chat. On mobile, .thread-panel becomes a `position:fixed` drawer at
  // `min(86vw,340px)` (packages/ui's own 900px breakpoint) — opening BY DEFAULT means it covers
  // nearly the entire screen and hides the chat before the user has done anything. This effect
  // runs once, right after mount, and closes it on a narrow viewport — a real bug caught by
  // screenshotting a real phone-width load: the composer/messages were completely invisible
  // behind the panel on first render.
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [panelWidth, setPanelWidth] = React.useState(250);
  const [panelResizeStart, setPanelResizeStart] = React.useState<{ x: number; width: number } | null>(null);
  const startPanelResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanelResizeStart({ x: event.clientX, width: panelWidth });
  };
  const updatePanelResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!panelResizeStart) return;
    const maxWidth = Math.min(720, Math.max(360, window.innerWidth * 0.6));
    setPanelWidth(Math.max(220, Math.min(maxWidth, panelResizeStart.width + panelResizeStart.x - event.clientX)));
  };
  React.useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches) {
      setPanelOpen(false);
    }
  }, []);
  const [panelTab, setPanelTab] = React.useState<WorkspaceTab>("stats");
  const [workspaceTabs, setWorkspaceTabs] = React.useState<WorkspaceTab[]>(["stats"]);
  const workspaceTabsStorageKey = React.useMemo(
    () => `naelao:workspace-tabs:${spaceId}:${threadId ? `thread:${threadId}` : `session:${sessionId ?? sessionKey}`}`,
    [spaceId, threadId, sessionId, sessionKey]
  );
  const [workspaceTabsHydratedKey, setWorkspaceTabsHydratedKey] = React.useState<string | null>(null);
  const [tabMenuOpen, setTabMenuOpen] = React.useState(false);
  const [canvasMenuOpen, setCanvasMenuOpen] = React.useState(false);
  const [canvases, setCanvases] = React.useState<Array<{ id: string; label: string; view: CanvasView }>>([]);
  const openWorkspaceTab = React.useCallback((tab: WorkspaceTab) => {
    setWorkspaceTabs((current) => current.includes(tab) ? current : [...current, tab]);
    setPanelTab(tab);
    setTabMenuOpen(false);
    setCanvasMenuOpen(false);
    setPanelOpen(true);
  }, []);
  const closeWorkspaceTab = React.useCallback((tab: WorkspaceTab) => {
    setWorkspaceTabs((current) => {
      const remaining = current.filter((item) => item !== tab);
      const next = remaining.length > 0 ? remaining : ["stats" as WorkspaceTab];
      setPanelTab((active) => active === tab ? next[Math.max(0, Math.min(current.indexOf(tab) - 1, next.length - 1))]! : active);
      return next;
    });
  }, []);

  React.useEffect(() => {
    setWorkspaceTabsHydratedKey(null);
    try {
      const parsed = JSON.parse(window.localStorage.getItem(workspaceTabsStorageKey) ?? "null") as { tabs?: unknown[]; active?: unknown } | null;
      const requestedPanel = new URLSearchParams(window.location.search).get("panel");
      const requestedTab = isWorkspaceTab(requestedPanel) && (requestedPanel !== "crons" || Boolean(projectId))
        ? requestedPanel
        : null;
      const saved = parsed?.tabs?.filter((tab): tab is WorkspaceTab => isWorkspaceTab(tab) && (tab !== "crons" || Boolean(projectId))) ?? [];
      if (requestedTab && !saved.includes(requestedTab)) saved.push(requestedTab);
      const tabs = saved.length > 0 ? Array.from(new Set(saved)) : ["stats" as WorkspaceTab];
      const active = requestedTab ?? (isWorkspaceTab(parsed?.active) && tabs.includes(parsed.active) ? parsed.active : tabs[0]!);
      setWorkspaceTabs(tabs);
      setPanelTab(active);
      if (requestedTab) setPanelOpen(true);
    } catch {
      setWorkspaceTabs(["stats"]);
      setPanelTab("stats");
    } finally {
      setWorkspaceTabsHydratedKey(workspaceTabsStorageKey);
    }
  }, [workspaceTabsStorageKey]);

  React.useEffect(() => {
    if (workspaceTabsHydratedKey !== workspaceTabsStorageKey) return;
    window.localStorage.setItem(workspaceTabsStorageKey, JSON.stringify({ tabs: workspaceTabs, active: panelTab }));
  }, [workspaceTabsHydratedKey, workspaceTabsStorageKey, workspaceTabs, panelTab]);
  const openCanvas = React.useCallback((id: string, label: string, view: CanvasView) => {
    const key = `canvas:${id}` as WorkspaceTab;
    setCanvases((current) => current.some((canvas) => canvas.id === id) ? current : [...current, { id, label, view }]);
    openWorkspaceTab(key);
  }, [openWorkspaceTab]);
  const canvasOptions: Array<{ id: string; label: string; view: CanvasView }> = project ? [
    { id: "deliverable", label: "Deliverable", view: "deliverable" },
    { id: "code", label: "Code Canvas", view: "code" },
    ...(project.kind === "CanvasFirst" || project.channel_config?.app_id ? [{ id: "micro-app", label: "Micro-App", view: "micro-app" as CanvasView }] : []),
    ...(project.channel_config?.container_enabled ? [{ id: "terminal", label: "Terminal", view: "terminal" as CanvasView }, { id: "gui", label: "GUI Display", view: "gui" as CanvasView }] : []),
  ] : [];
  const workspaceTabLabel = React.useCallback((tab: WorkspaceTab): string => {
    if (tab === "stats") return "Stats";
    if (tab === "assistant") return "Assistant";
    if (tab === "threads") return "Threads";
    if (tab === "messages") return "Messages";
    if (tab === "model") return "Model";
    if (tab === "connectors") return "Connected apps";
    if (tab === "members") return "Members";
    if (tab.startsWith("canvas:")) return canvases.find((canvas) => `canvas:${canvas.id}` === tab)?.label ?? "Canvas";
    return sidePanelTabs(Boolean(threadId)).find((item) => item.key === tab)?.label ?? tab;
  }, [canvases, threadId]);
  const [lastRun, setLastRun] = React.useState<AgentRun | null>(null);
  const [modelSearch, setModelSearch] = React.useState("");
  const [modelProvider, setModelProvider] = React.useState("all");
  const [workspaceMembers, setWorkspaceMembers] = React.useState<BusinessMember[] | null>(null);
  const [workspaceConnectors, setWorkspaceConnectors] = React.useState<ConnectorInfo[] | null>(null);
  const modelProviders = React.useMemo(() => Array.from(new Set(ALLOWED_MODELS.map(providerForModel))).sort(), []);
  const filteredModels = React.useMemo(() => ALLOWED_MODELS.filter((model) => {
    const matchesProvider = modelProvider === "all" || providerForModel(model) === modelProvider;
    const query = modelSearch.trim().toLowerCase();
    return matchesProvider && (!query || model.toLowerCase().includes(query) || modelLabel(model).toLowerCase().includes(query));
  }), [modelProvider, modelSearch]);

  React.useEffect(() => {
    let cancelled = false;
    if (workspaceTabs.includes("connectors") && workspaceConnectors === null) {
      getConnectorStatus(spaceId, session).then((rows) => { if (!cancelled) setWorkspaceConnectors(rows); }).catch(() => { if (!cancelled) setWorkspaceConnectors([]); });
    }
    if (workspaceTabs.includes("members") && dockIsBusinessSpace && workspaceMembers === null) {
      listBusinessMembers(spaceId, session).then((rows) => { if (!cancelled) setWorkspaceMembers(rows); }).catch(() => { if (!cancelled) setWorkspaceMembers([]); });
    }
    return () => { cancelled = true; };
  }, [workspaceTabs, workspaceConnectors, workspaceMembers, spaceId, session, dockIsBusinessSpace]);
  // Model switcher (Claude-Code-style per-session model + capability config) — a client-side
  // preference (modelPreference.ts), NOT the business's own stored default (that's
  // updateModelConfig/the Dashboard tab). Lazily read from localStorage so it survives reloads;
  // falls back to the platform default the very first time this space is ever opened.
  const [selectedModel, setSelectedModel] = React.useState<string>(() => getPreferredModel(spaceId) ?? DEFAULT_WORKING_MODEL);
  // Whether the person has actually PICKED a model for this space, as opposed to the placeholder
  // above. This distinction is load-bearing: the run request used to send `selectedModel`
  // unconditionally, and /agent/run treats an explicit model as an override of the business's own
  // configured one — so a browser with no stored preference silently forced every chat onto
  // DEFAULT_WORKING_MODEL and the model a builder had configured was never used. (On a deployment
  // whose default model is out of quota, that alone makes chat fail while a request that simply
  // omits the field succeeds.) Only a real choice is sent.
  const [modelIsExplicit, setModelIsExplicit] = React.useState<boolean>(() => getPreferredModel(spaceId) !== null);
  // The business's own configured model, for DISPLAY only — so the picker and the context-window
  // meter show what a run will really use instead of the placeholder. Never sent as an override.
  React.useEffect(() => {
    if (getPreferredModel(spaceId) !== null) return; // an explicit choice wins over the default
    let cancelled = false;
    getShellManifest(spaceId, session)
      .then((m) => {
        if (!cancelled && m.model && !getPreferredModel(spaceId)) setSelectedModel(m.model);
      })
      .catch(() => { /* keep the placeholder — display only, never blocks sending */ });
    return () => { cancelled = true; };
  }, [spaceId, session]);
  // Effort supersedes a directly-chosen reasoning level as the thing a person actually sets — the
  // model's own native reasoning param (selectedReasoningLevel below) is DERIVED from it, never
  // picked independently, so the two can never disagree. Defaults to "low": every model offers it,
  // and it's the safest default for someone who hasn't thought about escalation cost yet — see
  // effort.ts's own EFFORT_DESCRIPTIONS for what each level actually does.
  const [selectedEffort, setSelectedEffort] = React.useState<EffortLevel>(() => {
    const model = getPreferredModel(spaceId) ?? DEFAULT_WORKING_MODEL;
    const stored = getPreferredEffort(spaceId, model);
    return stored && isValidEffortLevel(model, stored) ? (stored as EffortLevel) : "low";
  });
  const selectedReasoningLevel = React.useMemo(
    () => nativeReasoningForEffort(selectedModel, selectedEffort),
    [selectedModel, selectedEffort]
  );
  const handleModelChange = React.useCallback(
    (model: string) => {
      setSelectedModel(model);
      setModelIsExplicit(true);
      storePreferredModel(spaceId, model);
      // A level stored for the PREVIOUS model may not exist on the new one's own ladder (a model
      // switch can shrink the ladder, e.g. from gpt-oss's 4 levels down to llama-3.3's 2) —
      // re-validate rather than carry over blindly.
      const stored = getPreferredEffort(spaceId, model);
      setSelectedEffort(stored && isValidEffortLevel(model, stored) ? (stored as EffortLevel) : "low");
    },
    [spaceId]
  );
  const handleEffortChange = React.useCallback(
    (effort: EffortLevel) => {
      setSelectedEffort(effort);
      storePreferredEffort(spaceId, selectedModel, effort);
    },
    [spaceId, selectedModel]
  );
  // A project can select among user-configured workers bound to that project.
  const [agentOptions, setAgentOptions] = React.useState<Array<{ id: string; name: string }>>([]);
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(null);
  // Transient feedback for the input bar's Upload button and the agent-template add action — not
  // an error, just a small "added/failed" confirmation that fades after a few seconds. Declared
  // here (rather than down by liveActivity, where it used to live) because handleAddAgentTemplate
  // below needs it in scope.
  const [uploadNotice, setUploadNotice] = React.useState<string | null>(null);
  // A soft, non-error notice for "this run is still going in the background" — shown when the
  // foreground poll stalls out on a durable run that hasn't failed, so the user isn't told a red
  // "timed out" for work that is actually still happening. Cleared on the next send.
  const [backgroundNotice, setBackgroundNotice] = React.useState<string | null>(null);

  const refreshAgentBindings = React.useCallback(async () => {
    if (!projectId) return;
    const [project, defs] = await Promise.all([
      getProject(spaceId, projectId, session),
      listAgentDefinitions(spaceId, session),
    ]);
    const allowedIds = project.allowed_agent_ids?.length ? project.allowed_agent_ids : (project.default_agent_id ? [project.default_agent_id] : []);
    if (allowedIds.length === 0) {
      setAgentOptions([{ id: "", name: "Space Assistant (default)" }]);
      setSelectedAgentId(null);
      return;
    }
    const nameById = new Map(defs.map((d: AgentDefinitionSummary) => [d.id.includes(":") ? d.id.slice(d.id.indexOf(":") + 1) : d.id, d.name ?? d.id]));
    setAgentOptions(allowedIds.map((id) => ({ id, name: nameById.get(id) ?? id })));
    setSelectedAgentId(project.default_agent_id ?? allowedIds[0] ?? null);
  }, [projectId, spaceId, session]);

  React.useEffect(() => {
    if (!projectId) { setAgentOptions([]); setSelectedAgentId(null); return; }
    let cancelled = false;
    refreshAgentBindings().catch(() => {
      if (!cancelled) { setAgentOptions([]); setSelectedAgentId(null); }
    });
    return () => { cancelled = true; };
  }, [projectId, refreshAgentBindings]);
  // The in-flight run's "currently doing X" trail (script-engine/loop.ts's TraceStep, live via
  // NaelaoAgentDO's in-memory progress map) — reset per send, attached to the completed message
  // once the run resolves so the tool-call/thinking summary stays visible under that turn.
  const [liveActivity, setLiveActivity] = React.useState<LiveRunStep[]>([]);
  // Real, previously-reported bug: a message's own pendingApproval/deferredApprovals are CLIENT-
  // ONLY (never persisted — see Message's own doc), attached only during the exact live poll/SSE
  // session that watched a run reach a gate. Navigate away, reload, or approve from the separate
  // /approvals page instead of this card, and the chat surface never learns anything happened —
  // the approval genuinely exists (HITLApprovalDO/suspended_runs has it) but nothing here shows
  // it. This periodically re-derives THIS session's still-open approvals from the durable,
  // space-wide list (filtered client-side by session_id — HITLApprovalDO's own GET /requests
  // doesn't filter server-side by session, so the filtering has to happen here) and renders them
  // as a persistent block near the composer, independent of which tab/page opened or resolves
  // them.
  const [sessionApprovals, setSessionApprovals] = React.useState<PendingApproval[]>([]);

  const endRef = React.useRef<HTMLDivElement>(null);
  const sseRef = React.useRef<EventSource | null>(null);
  const pollTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadlineRef = React.useRef(0);
  // Bug fix: send() mints a session and calls streamRun for the run it just started, but setting
  // chatSessionId to a NEW value also re-fires the "reattach to an in-flight run on mount" effect
  // below (its deps include chatSessionId) — and by then storeActiveRunId has already run, so that
  // effect sees the SAME run as "already in flight" and opens a SECOND EventSource for it. Two
  // independent SSE connections each append their own completed-answer bubble on "done", which is
  // exactly the double/triple-reply bug. This ref is the single gate: whichever call site reaches
  // a given runId first wins, and every other attempt for that same runId is a no-op.
  const attachedRunIdRef = React.useRef<string | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  // Grow the composer with its content up to the ceiling .dock-compose sets, then let it scroll.
  // Driven off `input` rather than onChange so a value put there by something else — a tip card,
  // an upload — resizes too, and so clearing it after a send snaps back to one line.
  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);
  // The standing "this didn't finish — continue?" offer for this thread. Server-backed, so it is
  // still here after a refresh: the offer is the only way to pick the work back up without
  // redoing side effects that already happened. Only shown for a failure kind that genuinely
  // needs a human (see refreshInterrupted below) — everything else self-heals first.
  const [interrupted, setInterrupted] = React.useState<InterruptedRun | null>(null);

  // The trailing message in this exchange, if it's an assistant reply this run's continuation
  // should fold into — undefined when the exchange has produced no bubble yet (the failed run
  // never reached finalizeAnswer) or when a NEWER user message already followed it (a stale
  // exchange a late-arriving retry must not silently attach itself onto).
  const originMessageIdForRetry = React.useCallback((): string | undefined => {
    const list = messagesRef.current;
    const last = list[list.length - 1];
    return last?.role === "assistant" ? last.id : undefined;
  }, []);

  // Re-enters the SAME run (its ledger key, so already-completed actions short-circuit rather
  // than repeat) — the shared machinery behind both the manual "Continue" button and every
  // self-heal attempt below.
  const continueInterruptedRun = React.useCallback(
    async (sid: string, runId: string) => {
      try {
        const res = await resolveInterruptedRun(spaceId, sid, runId, "continue", session);
        setSelfHealStatus(null);
        if (res.run_id) {
          setError(null);
          setBillingWall(null);
          setIsLoading(true);
          const originId = originMessageIdForRetry();
          if (originId) resumeOriginRef.current.set(res.run_id, originId);
          storeActiveRunId(spaceId, sessionKey, res.run_id);
          attachToRunRef.current(sid, res.run_id);
        }
        // else: the server declined to start a continuation (already handled elsewhere) — there's
        // nothing to attach to, so just stop pretending we're fixing it.
      } catch (err) {
        // The continue CALL itself failed (network, etc.) — distinct from the resulting run
        // failing again, which the run's own poll/stream loop already re-offers via
        // refreshInterrupted. The standing offer is still open server-side either way, so this
        // isn't lost — just surfaced plainly instead of retried silently forever.
        setSelfHealStatus(null);
        setError(userFacingErrorMessage(err, undefined, "Couldn't continue automatically."));
      }
    },
    [spaceId, session, sessionKey]
  );

  // Most failures don't need a person: an agent-fixable mistake (a bad tool call, running out of
  // steps) gets retried immediately, a provider quota/rate-limit gets a few backed-off retries
  // since it clears on its own, and only a genuinely human-shaped failure (a spend cap, an
  // unreachable model, a real pending approval) falls through to the manual InterruptedRunCard.
  // Bounded on both paths so a goal that's actually unrecoverable still hands back to the person
  // instead of retrying forever.
  // "user_cancelled": a run stopped by the person themselves must never be retried on their
  // behalf — self-healing exists to fix the AGENT's own mistakes, not to override a deliberate
  // stop the moment they refresh the page.
  const MANUAL_ONLY_FAILURE_KINDS = React.useRef(new Set(["budget_ceiling", "model_unavailable", "approval_pending", "user_cancelled"])).current;
  // The loop's own cancellation exit (script-engine/loop.ts) writes this exact string as the
  // run's error — matched here so the generic error banner doesn't duplicate the InterruptedRunCard
  // that refreshInterrupted is about to show for the same event; the card already says it, with a
  // Continue button attached, which a plain red error line cannot offer.
  const isUserStoppedError = React.useCallback((text: string | undefined) => !!text && text.startsWith("Stopped by you"), []);
  const MAX_AUTO_HEAL_ATTEMPTS = 3;
  const MAX_QUOTA_RETRY_ATTEMPTS = 4;
  const QUOTA_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];

  // Passive, mount-safe check: does a durable interrupted run exist for this session? Shows the
  // dialog if so, but NEVER starts a retry timer. This is deliberately the ONLY thing a
  // mount/reload is allowed to do — see handleLiveFailure below for the full auto-heal/quota-retry
  // chain, which must only ever be entered reactively, from an actual failure THIS tab just
  // watched happen. Without this split, mounting after a reload (or after the user deliberately
  // stopped a retry — see handleStop's "waiting" branch) would re-arm a fresh budget and fire a
  // brand-new round of automatic retries the person never asked for and may have already declined.
  const checkInterruptedRun = React.useCallback(
    async (sid: string) => {
      if (!session) return;
      let got: InterruptedRun | null;
      try {
        got = await getInterruptedRun(spaceId, sid, session);
      } catch {
        // Leave whatever is already shown. Clearing it on a transient read failure would tell the
        // user there is nothing to continue, which is the one wrong answer here.
        return;
      }
      if (!got) {
        setInterrupted(null);
        setSelfHealStatus(null);
        return;
      }
      // Purely a display decision — never touches the retry budget refs, never schedules a timer.
      setSelfHealStatus(null);
      setInterrupted(got);
    },
    [spaceId, session]
  );

  // The full self-heal chain: classify → auto-heal immediately, or back off and retry, or (once
  // exhausted) fall back to the manual card. Called ONLY from the live poll/stream failure
  // branches below — i.e. only reachable while this exact tab just watched a run fail in real
  // time. A page reload never reaches this function; see checkInterruptedRun above for what a
  // mount does instead.
  const handleLiveFailure = React.useCallback(
    async (sid: string) => {
      if (!session) return;
      let got: InterruptedRun | null;
      try {
        got = await getInterruptedRun(spaceId, sid, session);
      } catch {
        return;
      }
      if (!got) {
        setInterrupted(null);
        setSelfHealStatus(null);
        autoHealAttemptsRef.current = 0;
        quotaRetryAttemptsRef.current = 0;
        return;
      }
      const kind = got.failure_kind ?? "unknown";
      if (MANUAL_ONLY_FAILURE_KINDS.has(kind)) {
        setSelfHealStatus(null);
        setInterrupted(got);
        return;
      }
      if (got.clears_on_its_own) {
        if (quotaRetryAttemptsRef.current >= MAX_QUOTA_RETRY_ATTEMPTS) {
          // Retried enough times — hand it back rather than waiting forever on a window that
          // hasn't reopened yet.
          setSelfHealStatus(null);
          setInterrupted(got);
          return;
        }
        const attempt = quotaRetryAttemptsRef.current + 1;
        quotaRetryAttemptsRef.current = attempt;
        const delayMs = QUOTA_RETRY_DELAYS_MS[Math.min(attempt - 1, QUOTA_RETRY_DELAYS_MS.length - 1)];
        setInterrupted(null);
        setSelfHealStatus({ mode: "waiting", attempt, max: MAX_QUOTA_RETRY_ATTEMPTS });
        if (selfHealTimerRef.current) clearTimeout(selfHealTimerRef.current);
        const runId = got.run_id;
        selfHealTimerRef.current = setTimeout(() => { void continueInterruptedRun(sid, runId); }, delayMs);
        return;
      }
      // Agent-fixable: context_overflow / step_exhaustion / tool_error / unknown. Retry now — the
      // continuation carries the checkpoint forward, so the model gets to see what it already
      // tried rather than repeating the exact same mistake blind.
      if (autoHealAttemptsRef.current >= MAX_AUTO_HEAL_ATTEMPTS) {
        setSelfHealStatus(null);
        setInterrupted(got);
        return;
      }
      autoHealAttemptsRef.current += 1;
      setInterrupted(null);
      setSelfHealStatus({ mode: "fixing", attempt: autoHealAttemptsRef.current, max: MAX_AUTO_HEAL_ATTEMPTS });
      void continueInterruptedRun(sid, got.run_id);
    },
    [spaceId, session, continueInterruptedRun, MANUAL_ONLY_FAILURE_KINDS]
  );

  /** Ends a pending retry the person stopped before it fired — clears the backoff timer, stops the
   *  budget from advancing further, and shows the interrupted-run dialog immediately with a
   *  distinguishing message, instead of silently no-op'ing (there is no server-side run to cancel
   *  during the wait — the run that failed already terminated; this is purely ending the client's
   *  own retry loop). */
  const stopPendingRetry = React.useCallback(
    (sid: string) => {
      if (selfHealTimerRef.current) {
        clearTimeout(selfHealTimerRef.current);
        selfHealTimerRef.current = null;
      }
      // Exhaust both budgets so neither handleLiveFailure nor a future mount can re-arm a retry for
      // this same interruption.
      autoHealAttemptsRef.current = MAX_AUTO_HEAL_ATTEMPTS;
      quotaRetryAttemptsRef.current = MAX_QUOTA_RETRY_ATTEMPTS;
      setSelfHealStatus(null);
      setInterrupted((prev) =>
        prev ? { ...prev, failure_kind: "user_cancelled", reason: "Retry stopped by you." } : prev
      );
      if (!interrupted) {
        // Nothing was in local state yet (e.g. the very first waiting cycle) — fetch the real
        // record so the card has real context instead of nothing to show.
        void getInterruptedRun(spaceId, sid, session)
          .then((got) => {
            if (got) setInterrupted({ ...got, failure_kind: "user_cancelled", reason: "Retry stopped by you." });
          })
          .catch(() => {});
      }
    },
    [interrupted, spaceId, session]
  );

  // A manual Continue/Dismiss from the card itself, or landing on a fresh thread/session, resets
  // the self-heal budget — a new attempt at the SAME failure shouldn't inherit an exhausted
  // counter from a previous, unrelated one.
  const resetSelfHealBudget = React.useCallback(() => {
    autoHealAttemptsRef.current = 0;
    quotaRetryAttemptsRef.current = 0;
    if (selfHealTimerRef.current) { clearTimeout(selfHealTimerRef.current); selfHealTimerRef.current = null; }
  }, []);
  React.useEffect(() => {
    resetSelfHealBudget();
    return () => { if (selfHealTimerRef.current) clearTimeout(selfHealTimerRef.current); };
  }, [chatSessionId, resetSelfHealBudget]);
  // Maps a resumed-run's own id (handleResumeRun mints a fresh one) back to the message that held
  // the approval it continues — set by watchForResume once the continuation actually starts, read
  // by finalizeAnswer so that run's eventual answer is folded INTO that same bubble instead of
  // appearing as a brand new one, closer to how Claude keeps one long message going across a
  // mid-turn permission prompt.
  const resumeOriginRef = React.useRef<Map<string, string>>(new Map());

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  // Like Claude's own "new chat" — no session is minted just from landing here. A cached session
  // id (an earlier message already sent in this browser tab) resumes its history; otherwise the
  // composer sits empty and ready, and a session is only created lazily in handleSubmit on the
  // first actual send. This also means Home/a fresh thread never writes a session row purely from
  // being opened — matching the "nothing gets created until the user actually does something"
  // rule the business-first gating in the shell layout depends on.
  React.useEffect(() => {
    let cancelled = false;
    async function init() {
      setInitializing(true);
      setError(null);
      setBillingWall(null);
      try {
        const sid = sessionId ?? getChatSessionId(spaceId, sessionKey);
        if (!sid) {
          if (!cancelled) {
            setChatSessionId(null);
            setMessages([]);
          }
          return;
        }
        try {
          const existing = await getMessages(spaceId, sid, session);
          if (!cancelled) {
            setChatSessionId(sid);
            setMessages(existing);
          }
        } catch (err) {
          // A stale/invalid cached id (e.g. from a previous bug, or the session genuinely aged
          // out) — drop it and land empty rather than surface a raw error; the next send mints a
          // fresh one exactly like the first-ever visit would.
          if (err instanceof ApiError && err.status === 404 && !sessionId) {
            clearChatSessionId(spaceId, sessionKey);
            if (!cancelled) {
              setChatSessionId(null);
              setMessages([]);
            }
          } else {
            throw err;
          }
        }
      } catch (err) {
        if (!cancelled) setError(userFacingErrorMessage(err, undefined, "Failed to connect"));
      } finally {
        if (!cancelled) setInitializing(false);
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [spaceId, sessionKey, session, sessionId]);

  React.useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      sseRef.current?.close();
    };
  }, []);

  const stopPolling = React.useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const closeSSE = React.useCallback(() => {
    sseRef.current?.close();
    sseRef.current = null;
  }, []);

  // Shared by pollUntilDone and streamRun's "done" handling: when this runId is a resume
  // continuation (resumeOriginRef has an entry for it), fold the answer into the ORIGINAL
  // message's bubble instead of pushing a new row — one long message across an approval, the way
  // Claude keeps a single turn going across a mid-turn permission prompt. Any other run (the
  // ordinary case) appends a new message exactly as before.
  const finalizeAnswer = React.useCallback(
    (
      runId: string,
      answerText: string,
      activitySteps: LiveRunStep[],
      pendingApproval?: AgentRun["pending_approval"],
      pendingQuestion?: AgentRun["pending_question"],
      deferredApprovals?: AgentRun["deferred_approvals"],
      // What the viewer already watched stream in, so the finalized bubble picks up where the
      // live one left off instead of re-typing it (see Message.revealedPrefix).
      alreadyShown?: string
    ) => {
      const continuationOf = resumeOriginRef.current.get(runId);
      if (continuationOf) {
        resumeOriginRef.current.delete(runId);
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== continuationOf) return m;
            return {
              ...m,
              content: m.content ? `${m.content}\n\n${answerText}` : answerText,
              ...(activitySteps.length > 0 ? { activity: [...(m.activity ?? []), ...activitySteps] } : {}),
              // A continuation appends to an existing bubble, so what's "already shown" is that
              // whole bubble plus the separator this branch adds — otherwise the seed wouldn't be
              // a prefix of the new text and the reveal would restart the entire message.
              ...(alreadyShown
                ? { revealedPrefix: m.content ? `${m.content}\n\n${alreadyShown}` : alreadyShown }
                : {}),
              ...(pendingApproval ? { pendingApproval } : {}),
              ...(pendingQuestion ? { pendingQuestion } : {}),
              ...(deferredApprovals?.length ? { deferredApprovals: [...(m.deferredApprovals ?? []), ...deferredApprovals] } : {}),
            };
          })
        );
        return;
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `msg_${Date.now()}`, role: "assistant", content: answerText,
          created_at: new Date().toISOString(),
          justArrived: true,
          ...(alreadyShown ? { revealedPrefix: alreadyShown } : {}),
          ...(activitySteps.length > 0 ? { activity: activitySteps } : {}),
          ...(pendingApproval ? { pendingApproval } : {}),
          ...(pendingQuestion ? { pendingQuestion } : {}),
          ...(deferredApprovals?.length ? { deferredApprovals } : {}),
        },
      ]);
    },
    []
  );

  const pollUntilDone = React.useCallback(
    (sid: string, runId: string) => {
      // The DO's own /runs/:runId response carries the FULL live-progress list every tick (not a
      // delta, unlike the SSE endpoint's own "activity" events) — so each tick just replaces the
      // local copy with whatever's current, and the last one read is what gets attached to the
      // completed message below.
      let latestActivity: LiveRunStep[] = [];
      // The last partial answer actually rendered on screen, so the finalized bubble can pick up
      // the reveal where the live one left off rather than re-typing it (Message.revealedPrefix).
      let lastStreamed = "";
      // Bug fix: setInterval does NOT wait for a previous async callback to finish before firing
      // the next one. If a single pollRun round-trip ever takes longer than POLL_INTERVAL_MS (a
      // slow network tick, a GC pause, a burst of load), two or more overlapping callbacks each
      // independently see the SAME terminal status and each independently append their own
      // completed-message row — which is exactly the reported "same reply 2-3-4 times" bug (and,
      // since every duplicate carries the same pendingApproval/deferredApprovals, the same
      // approval card too). `settled` is the single gate: only the FIRST tick to observe a
      // terminal status is allowed to finalize; every later overlapping tick is a no-op.
      let settled = false;
      // A retry sequence inside one tick's pollRun call can genuinely outlast POLL_INTERVAL_MS
      // (see apiFetch's own backoff) — without this, a struggling backend would get a NEW,
      // independently-retrying poll call layered on every 1.5s on top of the ones still winding
      // down, compounding load on exactly the thing that's already having trouble.
      let inFlight = false;
      // A signature of the last progress we saw (step count + reply length). When it changes, the
      // run is genuinely moving, so the stall deadline is pushed out — see STALL_TIMEOUT_MS.
      let lastProgressSig = "";
      pollDeadlineRef.current = Date.now() + STALL_TIMEOUT_MS;
      pollTimerRef.current = setInterval(async () => {
        if (settled || inFlight) return;
        if (Date.now() > pollDeadlineRef.current) {
          if (settled) return;
          settled = true;
          stopPolling();
          setIsLoading(false);
          setStreamingContent("");
          setRetryStatus(null);
          // The run never reached a terminal state within the stall window — but it is durable and
          // keeps running server-side, so DON'T declare a hard failure or drop the active-run id.
          // Leaving storeActiveRunId in place lets the reattach-on-mount effect pick it back up on
          // the next reload/interaction (item 119's durable-run machinery). A soft, gray notice
          // instead of a red error, since nothing has actually gone wrong.
          setBackgroundNotice("Still working on this in the background — reopen this conversation to check on it.");
          return;
        }
        inFlight = true;
        try {
          const run = await pollRun(spaceId, sid, runId, session, (attempt, max) => setRetryStatus({ attempt, max }));
          if (settled) return;
          setRetryStatus(null);
          setLastRun(run);
          if (run.live_steps) {
            latestActivity = run.live_steps;
            setLiveActivity(latestActivity);
          }
          if (run.status === "running") {
            // partial_answer is the reply as the model is writing it; final_answer only exists
            // once the run has finished, so on a live tick the partial is the real signal.
            const growing = run.partial_answer ?? run.final_answer;
            if (growing) {
              lastStreamed = growing;
              setStreamingContent(growing);
            }
            // Genuine progress (a new step, or the reply growing) resets the stall deadline, so a
            // legitimately long multi-step run is never told it timed out.
            const sig = `${run.live_steps?.length ?? 0}:${(growing ?? "").length}`;
            if (sig !== lastProgressSig) {
              lastProgressSig = sig;
              pollDeadlineRef.current = Date.now() + STALL_TIMEOUT_MS;
            }
            return;
          }
          settled = true;
          stopPolling();
          setStopping(false);
          setStreamingContent("");
          setIsLoading(false);
          setLiveActivity([]);
          clearActiveRunId(spaceId, sessionKey);
          // awaiting_approval is grouped with completed on purpose: both have something real to
          // say. Without it this status matched no branch at all, so the reply simply vanished —
          // the user saw the spinner stop and nothing appear, with no way to know the agent was
          // waiting on them.
          if ((run.status === "completed" || run.status === "awaiting_approval") && run.final_answer) {
            finalizeAnswer(runId, run.final_answer, latestActivity, run.pending_approval, run.pending_question, run.deferred_approvals, lastStreamed);
          } else if (run.status === "failed" || run.status === "cancelled") {
            if (!isUserStoppedError(run.error)) {
              if (run.error_code && BILLING_ERROR_CODES.has(run.error_code)) {
                setBillingWall({ code: run.error_code, message: run.error ?? "You need to top up or subscribe to keep chatting." });
              } else {
                setError(userFacingErrorMessage(run.error, run.error_code, "The agent run failed"));
              }
            }
            // The run left a checkpoint; show the offer to continue it rather than only an error
            // the user can do nothing with except retype their request. This is a LIVE failure
            // this tab just watched happen — the full self-heal chain applies (unlike a mount).
            void handleLiveFailure(sid);
            // A run can fail on something UNRELATED while still carrying a real, still-open
            // approval it parked earlier — that approval must not vanish along with the error
            // banner, since it's a completely separate, still-actionable thing.
            if (run.deferred_approvals?.length) {
              const deferred = run.deferred_approvals;
              setMessages((prev) => [
                ...prev,
                {
                  id: `msg_${Date.now()}`, role: "assistant",
                  content: "Something else went wrong finishing this — but it also asked to run something that needs your approval first:",
                  created_at: new Date().toISOString(),
                  deferredApprovals: deferred,
                },
              ]);
            }
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            stopPolling();
            setStreamingContent("");
            setIsLoading(false);
            setLiveActivity([]);
            setRetryStatus(null);
            clearActiveRunId(spaceId, sessionKey);
            setError(userFacingErrorMessage(err, undefined, "Polling failed"));
          }
        } finally {
          inFlight = false;
        }
      }, POLL_INTERVAL_MS);
    },
    [spaceId, session, stopPolling, finalizeAnswer, handleLiveFailure, isUserStoppedError]
  );

  const streamRun = React.useCallback(
    // F-17: this must be async — it awaits getStreamUrl (which mints a short-lived stream ticket
    // rather than putting the raw nps_ session token in the EventSource URL). Callers fire it and
    // don't await (starting a stream is fire-and-forget), so the Promise return is intentional.
    async (sid: string, runId: string) => {
      if (typeof EventSource === "undefined") {
        pollUntilDone(sid, runId);
        return;
      }
      const url = await getStreamUrl(spaceId, sid, runId, session);
      const es = new EventSource(url);
      sseRef.current = es;
      let accumulated = "";
      // The SSE endpoint sends only the DELTA of new steps each tick (unlike the plain poll
      // route's full-list response) — accumulate locally so the completed message can carry the
      // whole trail, same reasoning as `accumulated` above for the answer text itself.
      let activitySteps: LiveRunStep[] = [];
      // Same overlapping-callback defense as pollUntilDone's `settled`: EventSource auto-reconnects
      // on a dropped connection, and a reconnect can redeliver a "done" the browser had already
      // queued for onmessage before the drop — without this, that shows up as the exact same
      // "duplicated reply/approval card" bug via the SSE path instead of the polling one.
      let doneHandled = false;

      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data) as {
            type: string; content?: string; offset?: number; run_id?: string; message?: string; steps?: LiveRunStep[];
            status?: AgentRun["status"]; final_answer?: string; error?: string; error_code?: string;
            pending_approval?: AgentRun["pending_approval"];
            pending_question?: AgentRun["pending_question"];
            deferred_approvals?: AgentRun["deferred_approvals"];
          };
          if (data.type === "activity" && data.steps?.length) {
            // Merge, never append: the stream re-sends a step whenever its text has grown (that's
            // what makes a sentence appear as it's written), so appending would print each
            // fragment as its own row. See mergeActivitySteps.
            activitySteps = mergeActivitySteps(activitySteps, data.steps);
            setLiveActivity(activitySteps);
          } else if (data.type === "delta" && data.content) {
            // Splice at the offset the server names rather than blindly appending. Appending is
            // correct exactly once: a reconnect, or attaching to a run already in progress,
            // would otherwise concatenate text that is already there. `offset` is absent on
            // older servers, where appending remains the right behaviour.
            accumulated =
              typeof data.offset === "number"
                ? accumulated.slice(0, data.offset) + data.content
                : accumulated + data.content;
            setStreamingContent(accumulated);
          } else if (data.type === "done") {
            if (doneHandled) return;
            doneHandled = true;
            closeSSE();
            setStreamingContent("");
            setIsLoading(false);
            setStopping(false);
            setLiveActivity([]);
            clearActiveRunId(spaceId, sessionKey);
            // The backend sends "done" for completed/failed/cancelled/awaiting_approval alike
            // (a run waiting on a person is not "still working" — see the server-side comment);
            // read the real status rather than assuming success, or a failed/declined run would
            // render as though it had answered normally.
            const status = data.status ?? "completed";
            setLastRun({ id: data.run_id ?? runId, status, final_answer: data.final_answer ?? accumulated });
            const answerText = data.final_answer ?? accumulated;
            if ((status === "completed" || status === "awaiting_approval") && answerText) {
              finalizeAnswer(data.run_id ?? runId, answerText, activitySteps, data.pending_approval, data.pending_question, data.deferred_approvals, accumulated);
            } else if (status === "failed" || status === "cancelled") {
              if (!isUserStoppedError(data.error)) {
                if (data.error_code && BILLING_ERROR_CODES.has(data.error_code)) {
                  setBillingWall({ code: data.error_code, message: data.error ?? "You need to top up or subscribe to keep chatting." });
                } else {
                  setError(userFacingErrorMessage(data.error, data.error_code, "The agent run failed"));
                }
              }
              void handleLiveFailure(sid);
              // Same "a real, still-open approval must not vanish along with an unrelated
              // failure" rule as the plain-polling fallback below.
              if (data.deferred_approvals?.length) {
                const deferred = data.deferred_approvals;
                setMessages((prev) => [
                  ...prev,
                  {
                    id: `msg_${Date.now()}`, role: "assistant",
                    content: "Something else went wrong finishing this — but it also asked to run something that needs your approval first:",
                    created_at: new Date().toISOString(),
                    deferredApprovals: deferred,
                  },
                ]);
              }
            }
          } else if (data.type === "error") {
            if (doneHandled) return;
            doneHandled = true;
            closeSSE();
            setStreamingContent("");
            setIsLoading(false);
            setLiveActivity([]);
            clearActiveRunId(spaceId, sessionKey);
            setError(userFacingErrorMessage(data.message, data.error_code, "The agent run failed"));
          }
        } catch {
          // malformed SSE chunk — ignore
        }
      };

      es.onerror = () => {
        closeSSE();
        if (doneHandled) return;
        if (accumulated === "") {
          pollUntilDone(sid, runId);
        } else {
          setStreamingContent("");
          setIsLoading(false);
        }
      };
    },
    [spaceId, sessionKey, session, closeSSE, pollUntilDone, finalizeAnswer, handleLiveFailure, isUserStoppedError]
  );

  // Single entry point for "start following this run's status" — both send() (a run it just
  // started) and the reattach-on-mount effect (a run it found already in flight) go through this,
  // so attachedRunIdRef guarantees streamRun is only ever opened once per runId no matter which
  // path gets there first or how many times either path fires.
  const attachToRun = React.useCallback(
    (sid: string, runId: string) => {
      if (attachedRunIdRef.current === runId) return;
      attachedRunIdRef.current = runId;
      void streamRun(sid, runId);
    },
    [streamRun]
  );
  // See attachToRunRef's own declaration for why this indirection exists (breaks a genuine mutual
  // dependency between refreshInterrupted, defined earlier, and attachToRun/streamRun, defined
  // here).
  React.useEffect(() => { attachToRunRef.current = attachToRun; }, [attachToRun]);

  // Poll (short-lived, bounded) for handleResumeRun's continuation run id to appear after an
  // approval, then attach to it via the SAME pollRun/streamRun machinery an ordinary run uses —
  // this is what makes the continuation's own tool calls show a real activity trail instead of
  // silently only appearing on the next reload with none. Registers the message-merge mapping
  // BEFORE attaching, so finalizeAnswer already knows to fold this run's answer into messageId.
  const watchForResume = React.useCallback(
    // messageId is optional: the persistent session-approvals block (below) isn't attached to any
    // one message, so approving from there has nothing to merge the continuation INTO — it just
    // appends as a new message once ready, via finalizeAnswer's own default branch.
    (approvalId: string, messageId?: string) => {
      if (!chatSessionId) return;
      const deadline = Date.now() + 20_000;
      const tick = async () => {
        try {
          const { resumed_run_id } = await getApprovalResumeStatus(spaceId, approvalId, session);
          if (resumed_run_id) {
            if (messageId) resumeOriginRef.current.set(resumed_run_id, messageId);
            setIsLoading(true);
            storeActiveRunId(spaceId, resumed_run_id, sessionKey);
            attachToRun(chatSessionId, resumed_run_id);
            return;
          }
        } catch {
          /* keep trying until the deadline — a transient lookup failure here just means one more
             wait; the approval itself already succeeded regardless. */
        }
        if (Date.now() < deadline) window.setTimeout(() => void tick(), 1500);
      };
      void tick();
    },
    [spaceId, chatSessionId, sessionKey, session, attachToRun]
  );

  // §A1.27: reattach to an in-flight run on mount (a reload, or a remount from navigating away
  // and back within the same tab) instead of only showing history with no sign a run is still
  // going. Runs once chatSessionId is resolved (i.e. init() above has finished).
  // The durable continue-offer is read on every mount — that is what makes it survive a refresh
  // or a closed tab. Separate from the in-flight-run reattach below: a thread can perfectly well
  // have an unfinished run to continue and nothing currently running.
  React.useEffect(() => {
    if (!chatSessionId) return;
    void checkInterruptedRun(chatSessionId);
  }, [chatSessionId, checkInterruptedRun]);

  // Reattach to a run that is still going.
  //
  // The server is asked first, and that is the whole point: sessionStorage is per-tab, so a run
  // started before you closed the tab was invisible to the tab you came back in — the agent kept
  // working and you saw a silent transcript. `getActiveRun` answers from durable state, so this
  // works from a new tab, another browser, or a different device. The stored id is kept as a
  // fallback for the case the server lookup itself fails, since it is still right within one tab.
  //
  // What arrives with the answer matters as much as the id: the steps and half-written reply
  // accumulated while you were away are painted immediately, THEN the live stream continues — so
  // coming back looks like catching up, not like starting over.
  React.useEffect(() => {
    if (!chatSessionId) return;
    let cancelled = false;
    (async () => {
      let activeRunId: string | null = null;
      try {
        const active = await getActiveRun(spaceId, chatSessionId, session);
        if (cancelled) return;
        if (active.active && active.run_id) {
          activeRunId = active.run_id;
          if (active.live_steps?.length) setLiveActivity(active.live_steps);
          if (active.partial_answer) setStreamingContent(active.partial_answer);
        }
      } catch {
        // Fall back to this tab's own memory of what it started.
        activeRunId = getActiveRunId(spaceId, sessionKey);
      }
      if (cancelled || !activeRunId) return;
      try {
        const run = await pollRun(spaceId, chatSessionId, activeRunId, session);
        if (cancelled) return;
        if (run.status === "running") {
          setIsLoading(true);
          storeActiveRunId(spaceId, activeRunId, sessionKey);
          attachToRun(chatSessionId, activeRunId);
        } else {
          // Already resolved while we were away — history (fetched above) already reflects it.
          clearActiveRunId(spaceId, sessionKey);
          setLiveActivity([]);
          setStreamingContent("");
        }
      } catch {
        // Can't confirm the run's state — leave it be rather than guess; the next send will
        // overwrite the stored id regardless.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attachToRun/session intentionally
    // excluded: this should only re-run when the session actually changes, not on every render
    // attachToRun/session identity happens to change.
  }, [chatSessionId, spaceId, sessionKey]);

  const refreshSessionApprovals = React.useCallback(async () => {
    if (!chatSessionId) return;
    try {
      const all = await listApprovals(spaceId, session);
      setSessionApprovals(all.filter((a) => a.session_id === chatSessionId));
    } catch {
      // A failed refresh leaves the last-known list showing rather than blanking it — the
      // separate /approvals page is the fallback if this keeps failing.
    }
  }, [spaceId, chatSessionId, session]);

  // Poll this thread's own still-open approvals independent of any live run this tab happens to
  // be watching — this is what makes an approval opened before this tab was here (or resolved
  // from the separate /approvals page) actually show up and clear here too.
  React.useEffect(() => {
    if (!chatSessionId) return;
    void refreshSessionApprovals();
    const timer = window.setInterval(() => void refreshSessionApprovals(), 8_000);
    return () => window.clearInterval(timer);
  }, [chatSessionId, refreshSessionApprovals]);

  // Lazy session creation: the very first send in a fresh thread/Home mints the session here, not
  // on mount — mirrors Claude's own "/new" behavior and means a session only ever exists once
  // there's a real message (or a real upload — see pendingUploads below) to attach it to. Shared
  // between `send` and the composer's upload handler, since an upload attached before the first
  // message needs a real session id to know where in the workspace it landed.
  const ensureSessionId = React.useCallback(async (): Promise<string> => {
    if (chatSessionId) return chatSessionId;
    // Link a project thread's session back to the thread server-side, so it never shows up as a
    // second, unrelated conversation in the flat Sessions sidebar (SpaceDO's listSessions
    // excludes anything linked this way) — an assistant/Home session has no threadId and links
    // to nothing, unchanged from before.
    const started = await startSession(spaceId, session, undefined, threadId);
    storeChatSessionId(spaceId, started.id, sessionKey);
    setChatSessionId(started.id);
    window.dispatchEvent(new CustomEvent("naelao:session-created", { detail: { spaceId, sessionId: started.id, threadId: threadId ?? null } }));
    return started.id;
  }, [chatSessionId, spaceId, session, sessionKey, threadId]);

  // Files attached via the dock's Uploads panel before the message that references them is sent.
  // Cleared once folded into an outgoing goal — see `send` below.
  const [pendingUploads, setPendingUploads] = React.useState<ChatUpload[]>([]);
  // AVOS plan step 6 — the "Cursor for X" visual inspector. Any interactive HTML preview on this
  // page (a workspace/artifact file, the Artifacts side-panel tab, an artifact rendered inline in
  // the transcript — see HtmlPreviewFrame) posts a real DOM `window` message when someone clicks
  // an element inside it; this ONE listener is what makes every one of those surfaces work without
  // threading a callback prop through each of them individually. Cleared once folded into an
  // outgoing goal, same lifecycle as pendingUploads above.
  const [inspectedElement, setInspectedElement] = React.useState<InspectedElement | null>(null);
  React.useEffect(() => {
    function onMessage(e: MessageEvent) {
      const inspectors = Array.from(
        document.querySelectorAll<HTMLIFrameElement>('iframe[data-naelao-dom-inspector="true"]')
      ).flatMap((frame) => frame.contentWindow ? [frame.contentWindow] : []);
      if (!isTrustedDomInspectionMessage(e.source, e.data, inspectors)) return;
      setInspectedElement({ selector: e.data.selector, tag: e.data.tag, text: e.data.text });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  // "Continue a heartbeat session as a normal one": the first real message SENT into an existing
  // session opened by explicit id (sessionId prop — a fresh Home/thread session is never a
  // heartbeat one, so this is safely scoped to skip the extra round trip in the common case)
  // promotes it out of the heartbeat filter. Guarded so this fires at most once per mount — after
  // the first attempt it's either already promoted (no-op) or genuinely not a heartbeat session.
  const heartbeatPromoteAttemptedRef = React.useRef(false);

  const send = React.useCallback(async (text: string) => {
    const trimmed = text.trim();
    if ((!trimmed && pendingUploads.length === 0 && !inspectedElement) || isLoading) return;
    setError(null);
    setBillingWall(null);
    setBackgroundNotice(null);
    setRetryStatus(null);
    setIsLoading(true);
    setStreamingContent("");
    setLiveActivity([]);
    const optimistic: Message = { id: `optimistic_${Date.now()}`, role: "user", content: trimmed, created_at: new Date().toISOString() };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const sid = await ensureSessionId();
      if (sessionId && !heartbeatPromoteAttemptedRef.current) {
        heartbeatPromoteAttemptedRef.current = true;
        void promoteSessionIfHeartbeat(spaceId, sid, session);
      }
      // A path relative to the agent's OWN r2-workspace root (see workspacePrefix() /
      // uploadsPrefix() on the agents worker) — the model can read it directly with
      // r2-workspace.read_file without needing to discover its own session id first.
      let goal = pendingUploads.length > 0
        ? `Attached files (in the workspace, read with r2-workspace.read_file): ${pendingUploads.map((u) => `uploads/${sid}/${u.name}`).join(", ")}\n\n${trimmed}`
        : trimmed;
      // AVOS plan step 6 — a pinned inspector selection describes the SAME thing a person clicking
      // that element could describe in words (tag/selector/text, never a fabricated source-file:
      // line — see HtmlPreviewFrame's own header for why), folded in as plain context exactly like
      // an attached file above.
      if (inspectedElement) {
        goal = `Referring to this element in the preview: <${inspectedElement.tag}> matching "${inspectedElement.selector}"${inspectedElement.text ? ` with text "${inspectedElement.text}"` : ""}.\n\n${goal}`;
      }
      setPendingUploads([]);
      setInspectedElement(null);
      const { agentRunId } = await sendMessage(
        spaceId,
        sid,
        goal,
        session,
        {
          // Only an explicit choice — see modelIsExplicit's own comment. Omitting the field is
          // what lets the server use the business's configured model.
          ...(modelIsExplicit ? { model: selectedModel } : {}),
          effort: selectedEffort,
          ...(selectedReasoningLevel ? { reasoningEffort: selectedReasoningLevel } : {}),
          ...(selectedAgentId ? { agentDefinitionId: selectedAgentId } : {}),
          // Root cause of "files land in the assistant workspace instead of the project
          // workspace": every run dispatched from here used to omit project_id entirely, even
          // though this component already knows it (the `projectId` prop, set for every project
          // thread). Without it the backend can't scope R2/KB/Memory-OS/journal to this thread's
          // project, so every one of them silently fell back to space-wide.
          ...(projectId ? { projectId } : {}),
          ...(pendingUploads.length ? { uploadNames: pendingUploads.map((upload) => upload.name) } : {}),
        },
        (attempt, max) => setRetryStatus({ attempt, max })
      );
      setRetryStatus(null);
      storeActiveRunId(spaceId, agentRunId, sessionKey);
      attachToRun(sid, agentRunId);
    } catch (err) {
      setIsLoading(false);
      setRetryStatus(null);
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      // The dispatch POST itself failing on a billing gate (rare — apps/shell doesn't send
      // Prefer: respond-sync, so this normally surfaces later via the async run's own error_code
      // above, not here) still deserves the same dialog rather than a bare banner.
      if (err instanceof ApiError && err.errorCode && BILLING_ERROR_CODES.has(err.errorCode)) {
        setBillingWall({ code: err.errorCode, message: err.message });
      } else {
        setError(userFacingErrorMessage(err, err instanceof ApiError ? err.errorCode : undefined, "Failed to send message"));
      }
    }
  }, [isLoading, pendingUploads, inspectedElement, ensureSessionId, spaceId, sessionKey, session, attachToRun, selectedModel, modelIsExplicit, selectedEffort, selectedReasoningLevel, selectedAgentId, sessionId, projectId]);

  /**
   * A message typed while the agent is still working.
   *
   * The composer used to be disabled outright, which meant a thought you had mid-run was simply
   * lost unless you held it in your head until the reply landed. Queued messages are sent
   * automatically, in order, as soon as the run finishes — so you can keep talking at your own
   * pace rather than the agent's.
   */
  const [queued, setQueued] = React.useState<string[]>([]);
  const queuedRef = React.useRef<string[]>([]);
  queuedRef.current = queued;

  // Generated widgets are validated before rendering. Fold their typed interaction back into
  // the same planner conversation as a structured user action; if a run is active, queue it so
  // the interaction cannot be dropped or race the current run.
  const handleWidgetAction = React.useCallback((widgetId: string, value: unknown) => {
    const action = `The user interacted with UI widget "${widgetId}". Action value: ${JSON.stringify(value)}. Continue the task using this choice.`;
    if (isLoading) setQueued((current) => [...current, action]);
    else void send(action);
  }, [isLoading, send]);

  /** Stop the run in flight — OR, if the agent is between retry attempts (the backoff wait, no
   *  server-side run actually executing), end that retry loop right here. Optimistic on the
   *  button, authoritative on the server: the agent reports what it had already completed, so
   *  stopping is never the same as losing the work. */
  const handleStop = React.useCallback(async () => {
    if (!chatSessionId) return;
    // Waiting between retries: there is nothing running server-side to cancel — the run that
    // failed already terminated. Clicking Stop here ends the retry loop and shows the dialog
    // immediately, distinguishing "you stopped it" from a run that's still genuinely executing.
    if (selfHealStatus?.mode === "waiting") {
      stopPendingRetry(chatSessionId);
      return;
    }
    const runId = lastRun?.id ?? getActiveRunId(spaceId, sessionKey);
    if (!runId) return;
    setStopping(true);
    try {
      await cancelRun(spaceId, chatSessionId, runId, session);
    } catch {
      // The run may have finished in the same instant — the poll below settles it either way, so
      // there is nothing useful to show for a failed stop on an already-finished run.
    }
  }, [lastRun, chatSessionId, spaceId, sessionKey, session, selfHealStatus, stopPendingRetry]);

  const handleSubmit = React.useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput("");
    // Mid-run, the message is queued rather than dropped — the drain effect below sends it the
    // moment the agent is free, in the order you typed.
    if (isLoading) {
      setQueued((prev) => [...prev, trimmed]);
      return;
    }
    await send(trimmed);
  }, [input, send, isLoading]);

  // Drain the queue when the agent goes idle. One at a time and in order: sending them together
  // would collapse several separate thoughts into one goal, which is not what was typed.
  React.useEffect(() => {
    if (isLoading || queued.length === 0) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    void send(next!);
  }, [isLoading, queued, send]);

  // Home hands its opening line over here rather than duplicating the chat surface on the landing
  // page. Guarded by a ref, not just the empty-history check: React 18 StrictMode double-invokes
  // effects in development, and "send the user's first message twice" is not a dev-only annoyance
  // — it would bill two real agent runs.
  // Edit-and-ask-again on the last thing the user said. Scoped to the last message deliberately:
  // editing an earlier one would have to discard every exchange after it, and a destructive
  // rewrite of the conversation is not what someone fixing a typo is asking for.
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editDraft, setEditDraft] = React.useState("");
  /** Which message last received a tap — the touch equivalent of :hover for the action row. */
  const [revealedActionsId, setRevealedActionsId] = React.useState<string | null>(null);
  const lastUserMessageId = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") return messages[i]!.id;
    return null;
  }, [messages]);

  const submitEdit = React.useCallback(
    async (messageId: string) => {
      const text = editDraft.trim();
      if (!text) return;
      setEditingId(null);
      // Drop the edited message and everything after it, then ask again — on the SERVER as well as
      // in the view. Truncating only locally used to leave the original question and answer in the
      // transcript, so the next reload rendered the old pair and the new pair: four bubbles for
      // what the user experienced as one correction.
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        return idx === -1 ? prev : prev.slice(0, idx);
      });
      // Best-effort: a failed cleanup must not cost the user their re-ask. Worst case the stale
      // pair reappears on reload — exactly the old behaviour, never worse. A client-minted id
      // (`optimistic_`/`msg_`) has no server row to truncate from, so skip the pointless round trip.
      const sid = chatSessionId;
      const clientMinted = messageId.startsWith("optimistic_") || messageId.startsWith("msg_");
      if (sid && !clientMinted) {
        await truncateMessagesFrom(spaceId, sid, messageId, session).catch(() => {});
      }
      await send(text);
    },
    [editDraft, send, chatSessionId, spaceId, session]
  );

  const initialSentRef = React.useRef(false);
  // Latched separately from the prop. The caller strips the message from the URL as soon as it has
  // handed it over, so by the time this surface is ready to send, the prop may already have gone
  // back to undefined — which is exactly how a user's first message came to be dropped in silence.
  // Defence in depth alongside the page's own latch: whoever passes it, the first non-empty value
  // wins and cannot be retracted.
  const pendingInitialRef = React.useRef<string | null>(null);
  if (initialMessage && !pendingInitialRef.current && !initialSentRef.current) {
    pendingInitialRef.current = initialMessage;
  }
  React.useEffect(() => {
    const pending = pendingInitialRef.current;
    if (!pending || initializing || initialSentRef.current) return;
    if (messages.length > 0) return;
    initialSentRef.current = true;
    pendingInitialRef.current = null;
    void send(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once when the surface is ready.
  }, [initialMessage, initializing]);

  if (initializing) {
    return (
      <div className="home-view">
        <span style={{ color: "var(--text3)", fontSize: 13 }}>Connecting…</span>
      </div>
    );
  }

  // Don't show a second, duplicate card for an approval a rendered message ALREADY carries its
  // own inline card for (the live-tab flow) — the persistent block below is only for ones no
  // message in this render has attached.
  const attachedApprovalIds = new Set<string>();
  for (const m of messages) {
    if (m.pendingApproval) attachedApprovalIds.add(m.pendingApproval.approval_id);
    if (m.pendingQuestion) attachedApprovalIds.add(m.pendingQuestion.question_id ?? m.pendingQuestion.approval_id);
    for (const d of m.deferredApprovals ?? []) attachedApprovalIds.add(d.approval_id);
  }
  const unattachedApprovals = sessionApprovals.filter((a) => !attachedApprovalIds.has(a.id));

  // The business assistant speaking into this thread on the owner's behalf, and the reply it
  // drew, belong together: rendered as two adjacent left-aligned bubbles they read as one speaker
  // asking and then answering their own question. groupDelegations pairs them; `delegationReplyIds`
  // is what stops the reply ALSO rendering as its own bubble below the card.
  const visibleMessages = messages.filter((m) => m.role !== "system" && m.role !== "tool");
  const delegationItems = groupDelegations(visibleMessages);
  const delegationByRequestId = new Map(
    delegationItems.filter((i) => i.kind === "delegation").map((i) => [i.request.id, i] as const)
  );
  const delegationReplyIds = new Set(
    delegationItems.flatMap((i) => (i.kind === "delegation" && i.reply ? [i.reply.id] : []))
  );

  return (
    <div className="chat-layout">
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div className="topbar thread-topbar">
          <button
            type="button"
            className="thread-mobile-control thread-mobile-menu"
            aria-label="Open menu"
            title="Open menu"
            onClick={() => window.dispatchEvent(new CustomEvent("naelao:toggle-mobile-nav"))}
          >
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor">
              <line x1="2" y1="4" x2="14" y2="4" />
              <line x1="2" y1="8" x2="14" y2="8" />
              <line x1="2" y1="12" x2="14" y2="12" />
            </svg>
          </button>
          <div className="thread-title-wrap">
            <div className="thread-title">{title}</div>
            {conversationMode && (
              <div className="thread-model-summary">
                <button type="button" className="thread-model-button" onClick={() => openWorkspaceTab("model")} aria-label="Open model settings">
                  {modelLabel(selectedModel)} · {effortOptionsForModel(selectedModel).find((option) => option.level === selectedEffort)?.label ?? selectedEffort}⌄
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="thread-mobile-control thread-workspace-control"
            aria-label={panelOpen ? "Close workspace panel" : "Open workspace panel"}
            title={panelOpen ? "Close workspace panel" : "Open workspace panel"}
            onClick={() => setPanelOpen((current) => !current)}
          >
            {workspaceTabIcon(panelTab)}
          </button>
        </div>

        <div className="chat-area">
          {projectId && <ProjectPullRequestPanel spaceId={spaceId} projectId={projectId} session={session} />}
          {visibleMessages
            // Already shown inside its delegation card above — never a second bubble.
            .filter((m) => !delegationReplyIds.has(m.id))
            .map((m) =>
              delegationByRequestId.has(m.id) ? (
                <div key={m.id} id={`message-point-${m.id}`}>
                  <AssistantDelegationCard request={m} reply={delegationByRequestId.get(m.id)!.reply} />
                </div>
              ) : (
              <div
                key={m.id}
                id={`message-point-${m.id}`}
                className={["msg-row", m.role === "user" ? "user" : "", revealedActionsId === m.id ? "revealed" : ""].filter(Boolean).join(" ")}
                // Tap-to-reveal for touch, where :hover never fires. Harmless on a mouse — the
                // row is already revealed by hover before any click lands.
                onClick={() => setRevealedActionsId(m.id)}
              >
                {m.role !== "user" && (
                  <div className="ai-icon">
                    <svg viewBox="0 0 14 14">
                      <path d="M7 1L12.5 4.25V10.75L7 14L1.5 10.75V4.25L7 1Z" />
                    </svg>
                  </div>
                )}
                <div style={{ minWidth: 0 }}>
                  {/* Only for a NAMED agent. The Space Assistant is the default voice of this
                      surface and labelling every one of its replies is noise; a project agent
                      speaking in the same thread is the case worth distinguishing. */}
                  {authorLabel(m) && (
                    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
                      <span
                        aria-hidden
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: "50%",
                          background: "var(--accent)",
                          color: "#fff",
                          fontSize: 8.5,
                          fontWeight: 700,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        {authorLabel(m)!.slice(0, 1)}
                      </span>
                      <span style={{ fontSize: 11.5, color: "var(--text3)", fontWeight: 600 }}>
                        {authorLabel(m)}
                      </span>
                    </div>
                  )}
                  {/* The sequence this turn actually went through — thinking, tool calls, mid-run
                      replies — rendered BEFORE the final answer bubble below it, because that's
                      the real order it happened in (see ActivityFeed.tsx). Renders nothing for a
                      trivial answer-only turn. m.activity is client-only (this run happened in
                      THIS browser session); after a reload it's gone, but the run's own id
                      survives in metadata.run_id and the trace itself is durable server-side —
                      PersistedActivitySequence re-fetches it on demand instead of it disappearing. */}
                  {/* animate={false}: `activity` is only ever set by finalizeAnswer, i.e. from a run
                      whose steps the viewer just watched appear in the live block above. Re-playing
                      that reveal on the finalized bubble is the same "snap" as re-typing the answer
                      text — the sequence is already read. (The reload path below is a different
                      branch: PersistedActivitySequence fetches a trace nobody watched live.) */}
                  {m.role !== "user" && m.activity && <div data-technical-detail="execution_trace"><ActivitySequence steps={m.activity} animate={false} /></div>}
                  {m.role !== "user" && !m.activity && m.metadata?.run_id && chatSessionId && (
                    <div data-technical-detail="execution_trace"><PersistedActivitySequence spaceId={spaceId} sessionId={chatSessionId} runId={m.metadata.run_id} session={session} /></div>
                  )}
                  {editingId === m.id ? (
                    <div className="bubble user" style={{ display: "grid", gap: 6, minWidth: 260 }}>
                      <textarea
                        className="msg-input"
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitEdit(m.id); }
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        rows={2}
                        style={{ background: "transparent", color: "inherit", border: "none", resize: "vertical", width: "100%" }}
                        autoFocus
                      />
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                        <button type="button" className="btn btn-primary btn-sm" disabled={!editDraft.trim()} onClick={() => void submitEdit(m.id)}>
                          Send
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className={["bubble", m.role === "user" ? "user" : ""].filter(Boolean).join(" ")}>
                      {/* The user's own message stays literal — they typed it, and rendering their
                          text as markdown would silently restyle whatever they wrote. `.bubble.user`
                          carries white-space:pre-wrap so their line breaks survive. An assistant or
                          agent reply IS markdown: it arrives with **bold**, bullets and ``` fences
                          that were previously shown as raw characters. */}
                      {m.role === "user"
                        ? m.content
                        : <RevealText text={m.content} animate={m.justArrived} revealFrom={m.revealedPrefix} markdown onAction={handleWidgetAction} />}
                    </div>
                  )}
                  {m.role !== "user" && projectId && m.metadata?.citations?.length ? (
                    <CitationBadges citations={m.metadata.citations} spaceId={spaceId} projectId={projectId} session={session} />
                  ) : null}
                  {/* Copy on every message; edit only on the LAST thing you said — editing
                      something further back would silently discard every exchange after it, which
                      is a destructive act dressed up as a typo fix. Icons rather than labels, and
                      revealed on hover (or on tap, see revealedActionsId) so a quiet thread stays
                      quiet. */}
                  {editingId !== m.id && (
                    <MessageActions
                      content={m.content}
                      align={m.role === "user" ? "right" : "left"}
                      {...(m.role === "user" && m.id === lastUserMessageId && !isLoading
                        ? { onEdit: () => { setEditingId(m.id); setEditDraft(m.content); } }
                        : {})}
                    />
                  )}
                  {/* In-chat approval card, at the exact turn the run stopped waiting on a
                      person — see InlineApprovalCard's own header for why this doesn't need to
                      duplicate the separate /approvals inbox to be useful here. */}
                  {m.role !== "user" && m.pendingApproval && (
                    <InlineApprovalCard
                      spaceId={spaceId}
                      approval={m.pendingApproval}
                      session={session}
                      onResolved={(decision) => {
                        if (decision === "approved") watchForResume(m.pendingApproval!.approval_id, m.id);
                        void refreshSessionApprovals();
                      }}
                    />
                  )}
                  {m.role !== "user" && m.pendingQuestion && (
                    <InlineQuestionCard
                      spaceId={spaceId}
                      question={m.pendingQuestion}
                      session={session}
                      onAnswered={() => {
                        const id = m.pendingQuestion!.question_id ?? m.pendingQuestion!.approval_id;
                        if (id) watchForResume(id, m.id);
                        void refreshSessionApprovals();
                      }}
                    />
                  )}
                  {/* Actions the run parked and carried on around (as opposed to pendingApproval,
                      where the WHOLE run stopped) — a run can even finish (or fail on something
                      unrelated) while still carrying one or more of these; they must show up
                      regardless. Live-reported bug: this used to be silently dropped entirely, so
                      a real, open approval existed with no sign of it anywhere in the chat. */}
                  {m.role !== "user" && m.deferredApprovals?.map((a) => (
                    <InlineApprovalCard
                      key={a.approval_id}
                      spaceId={spaceId}
                      approval={a}
                      session={session}
                      onResolved={(decision) => {
                        if (decision === "approved") watchForResume(a.approval_id, m.id);
                        void refreshSessionApprovals();
                      }}
                    />
                  ))}
                  {/* The assistant tried to use a connected-but-not-yet-connected app — let the
                      person connect it right here instead of hunting for the Connectors page. */}
                  {m.role !== "user" && m.metadata?.needs_connector && m.metadata.connector_id && (
                    <InlineConnectorCard
                      spaceId={spaceId}
                      connectorId={m.metadata.connector_id}
                      connectorName={m.metadata.connector_name ?? m.metadata.connector_id}
                      session={session}
                    />
                  )}
                  {/* item 79: where the assistant delegated to a project agent on the user's
                      behalf, right at the turn it happened — collapsed by default, expandable
                      in place. A separate, private exchange (see SubthreadPanel's own header),
                      never appended to this visible transcript itself. */}
                  {m.metadata?.consulted_threads?.map((c) => (
                    <div key={c.thread_id} style={{ marginTop: 6, maxWidth: 420 }}>
                      <SubthreadEntry spaceId={spaceId} thread={consultThreadSummary(spaceId, c)} session={session} inline />
                    </div>
                  ))}
                  {m.role !== "user" && projectId && m.metadata?.workspace_publication?.review?.card && (
                    <InlinePullRequestCard
                      spaceId={spaceId}
                      projectId={projectId}
                      review={m.metadata.workspace_publication.review}
                      session={session}
                    />
                  )}
                  {m.role !== "user" && m.metadata?.widget_deliveries?.map((delivery, index) => (
                    <ExtensionWidgetCard key={`${delivery.event_id}:${delivery.installation_id}:${index}`} view={delivery.view} />
                  ))}
                  {/* Step 5/7/11: an artifact the assistant created this turn — inline preview
                      (iframe for HTML) + download, right under the reply, like Claude. */}
                  {m.role !== "user" && m.metadata?.widget_events?.filter(event => event.version === 1 && event.type === "artifact.created" && typeof event.data.artifact_id === "string" && typeof event.data.filename === "string").map((event) => (
                    <InlineArtifactCard
                      key={event.id}
                      spaceId={spaceId}
                      artifactId={event.data.artifact_id as string}
                      filename={event.data.filename as string}
                      {...(typeof event.data.content_type === "string" ? { contentType: event.data.content_type } : {})}
                      session={session}
                    />
                  ))}
                  {m.role !== "user" && m.metadata?.created_artifacts?.filter(art => !m.metadata?.widget_events?.some(event => event.version === 1 && event.type === "artifact.created" && event.data.artifact_id === art.artifact_id && typeof event.data.filename === "string")).map((art) => (
                    <InlineArtifactCard
                      key={art.artifact_id}
                      spaceId={spaceId}
                      artifactId={art.artifact_id}
                      filename={art.filename}
                      {...(art.content_type ? { contentType: art.content_type } : {})}
                      session={session}
                    />
                  ))}
                </div>
              </div>
              )
            )}

          {/* A transient network/gateway hiccup being retried automatically — shown INSTEAD of
              the ordinary typing/activity indicator (not alongside it) while it's happening, so
              there's one clear status line rather than two competing ones. Cleared the moment
              the retry succeeds or genuinely exhausts (at which point `error` takes over). */}
          {isLoading && retryStatus && (
            <div className="msg-row">
              <div className="ai-icon">
                <svg viewBox="0 0 14 14">
                  <path d="M7 1L12.5 4.25V10.75L7 14L1.5 10.75V4.25L7 1Z" />
                </svg>
              </div>
              <div className="bubble" style={{ color: "var(--text3)", fontStyle: "italic" }}>
                Request failed, retrying ({retryStatus.attempt}/{retryStatus.max})…
              </div>
            </div>
          )}
          {isLoading && !retryStatus && streamingContent && (
            <div className="msg-row">
              <div className="ai-icon">
                <svg viewBox="0 0 14 14">
                  <path d="M7 1L12.5 4.25V10.75L7 14L1.5 10.75V4.25L7 1Z" />
                </svg>
              </div>
              <div style={{ minWidth: 0 }}>
                {liveActivity.length > 0 && <ActivitySequence steps={liveActivity} animate live />}
                <div className="bubble"><RevealText text={streamingContent} animate markdown onAction={handleWidgetAction} /></div>
              </div>
            </div>
          )}
          {isLoading && !retryStatus && !streamingContent && (
            <div className="msg-row">
              <div className="ai-icon">
                <svg viewBox="0 0 14 14">
                  <path d="M7 1L12.5 4.25V10.75L7 14L1.5 10.75V4.25L7 1Z" />
                </svg>
              </div>
              {liveActivity.length > 0 ? (
                <div style={{ minWidth: 0 }}>
                  <ActivitySequence steps={liveActivity} animate live />
                </div>
              ) : (
                <div className="bubble typing-indicator">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
              )}
            </div>
          )}
          {/* Self-healing in progress — the agent fixing its own mistake, or waiting out a
              provider quota/rate-limit that clears on its own. Not the InterruptedRunCard: that's
              reserved for when self-healing gives up or the failure genuinely needs a person. */}
          {selfHealStatus && (
            <div className="msg-row">
              <div className="ai-icon">
                <svg viewBox="0 0 14 14">
                  <path d="M7 1L12.5 4.25V10.75L7 14L1.5 10.75V4.25L7 1Z" />
                </svg>
              </div>
              <div className="bubble" style={{ color: "var(--text3)", fontStyle: "italic" }}>
                {selfHealStatus.mode === "fixing"
                  ? `That didn't work — trying a different approach (attempt ${selfHealStatus.attempt}/${selfHealStatus.max})…`
                  : `Waiting for available capacity, then retrying automatically (attempt ${selfHealStatus.attempt}/${selfHealStatus.max})…`}
              </div>
            </div>
          )}
          {/* The durable offer to continue. Rendered independently of `error`, which is
              in-page state and disappears on reload — this is the part that has to still be
              here tomorrow. */}
          {interrupted && chatSessionId && (
            <div className="msg-row">
              <InterruptedRunCard
                interrupted={interrupted}
                spaceId={spaceId}
                sessionId={chatSessionId}
                session={session}
                onContinued={(newRunId) => {
                  setInterrupted(null);
                  resetSelfHealBudget();
                  setError(null);
                  setBillingWall(null);
                  setIsLoading(true);
                  // Same merge as the self-heal path (continueInterruptedRun) — a manual Continue
                  // click is just this same continuation, dispatched by the person instead of
                  // automatically. Without this, clicking Continue a second time on the same
                  // exchange (a retry that itself hit a different failure) would fork the
                  // conversation into two separate bubbles instead of one that kept going.
                  const originId = originMessageIdForRetry();
                  if (originId) resumeOriginRef.current.set(newRunId, originId);
                  storeActiveRunId(spaceId, sessionKey, newRunId);
                  attachToRun(chatSessionId, newRunId);
                }}
                onDismissed={() => { setInterrupted(null); resetSelfHealBudget(); }}
              />
            </div>
          )}
          {error && (
            <div className="msg-row">
              {error === "destructive_mutation_denied" || error === "egress_dlp_blocked" ? (
                <SecurityBoundaryCard code={error} />
              ) : <div className="bubble" style={{ color: "#dc2626" }}>
                {error}
                {/* Show support contact for billing/credit errors so a stuck user always has
                    a path to a human — driven by manifest.legal.support_contact. */}
                {supportContact && (error.includes("credit") || error.includes("subscri") || error.includes("quota") || error.includes("402")) && (
                  <span style={{ display: "block", marginTop: 6, fontSize: "0.85em" }}>
                    Need help?{" "}
                    <a href={supportContact} style={{ color: "#dc2626", textDecoration: "underline" }}>
                      Contact support
                    </a>
                  </span>
                )}
              </div>}
            </div>
          )}
          {billingWall && (
            <UpgradeDialog
              errorCode={billingWall.code}
              message={billingWall.message}
              supportContact={supportContact}
              onClose={() => setBillingWall(null)}
            />
          )}
          {unattachedApprovals.length > 0 && (
            <div className="msg-row">
              <div style={{ minWidth: 0, width: "100%" }}>
                <div style={{ fontSize: 11.5, color: "var(--text3)", marginBottom: 4, fontWeight: 600 }}>
                  Waiting on you
                </div>
                {unattachedApprovals.map((a) => a.kind === "question" ? (
                  <InlineQuestionCard
                    key={a.id}
                    spaceId={spaceId}
                    question={{ approval_id: a.id, question_id: a.id, action_name: "AskUser", question: a.question ?? "Please provide the missing information.", options: (() => { try { return a.options_json ? JSON.parse(a.options_json) as string[] : []; } catch { return []; } })() }}
                    session={session}
                    onAnswered={() => { setSessionApprovals((prev) => prev.filter((x) => x.id !== a.id)); watchForResume(a.id); }}
                  />
                ) : (
                  <InlineApprovalCard
                    key={a.id}
                    spaceId={spaceId}
                    approval={{
                      approval_id: a.id,
                      action_name: a.tool_name,
                      ...(() => {
                        try {
                          return { params: JSON.parse(a.tool_input) as Record<string, unknown> };
                        } catch {
                          return {};
                        }
                      })(),
                      expires_at: a.expires_at,
                    }}
                    session={session}
                    onResolved={(decision) => {
                      setSessionApprovals((prev) => prev.filter((x) => x.id !== a.id));
                      if (decision === "approved") watchForResume(a.id);
                    }}
                  />
                ))}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="chat-input-area">
          {chatSessionId && <OwnerVoiceCall
            spaceId={spaceId}
            sessionId={chatSessionId}
            session={session}
            {...(projectId ? { projectId } : {})}
          />}
          {chatSessionId && (
            <ContextUsageMeter
              spaceId={spaceId}
              sessionId={chatSessionId}
              session={session}
              model={selectedModel}
              refreshKey={messages.length}
              compact
            />
          )}
          <ComposerDock
            spaceId={spaceId}
            {...(projectId ? { projectId } : {})}
            {...(chatSessionId ? { sessionId: chatSessionId } : {})}
            session={session}
            model={selectedModel}
            reasoningLevel={selectedReasoningLevel}
            onModelChange={handleModelChange}
            effort={selectedEffort}
            onEffortChange={handleEffortChange}
            threadMode={conversationMode}
            ideas={!threadId && visibleMessages.length === 0 && !input.trim() ? (
              <div className="composer-ideas" aria-label="Ideas">
                {['Draft a plan for this venture', 'Review the latest project context', 'Create a useful first deliverable'].map((idea) => (
                  <button key={idea} type="button" onClick={() => setInput(idea)}>{idea}</button>
                ))}
              </div>
            ) : null}
            spaceName={activeSpaceName ?? undefined}
            isBusinessSpace={dockIsBusinessSpace}
            agentOptions={agentOptions}
            selectedAgentId={selectedAgentId ?? ""}
            onAgentChange={(id) => setSelectedAgentId(id === "" ? null : id)}
            onNotice={(msg) => {
              setUploadNotice(msg);
              window.setTimeout(() => setUploadNotice((cur) => (cur === msg ? null : cur)), 4000);
            }}
            onUseTip={(text) => setInput(text)}
            onDictation={(text) => setInput((current) => `${current}${current && !/\s$/.test(current) ? " " : ""}${text}`)}
            ensureSessionId={ensureSessionId}
            pendingUploads={pendingUploads}
            onUploadsChange={setPendingUploads}
          >
            <div className="input-container">
              {pendingUploads.length > 0 && (
                <div className="pending-uploads">
                  {pendingUploads.map((u) => (
                    <span key={u.key} className="pending-upload-chip">
                      {u.name}
                      <button
                        type="button"
                        aria-label={`Remove ${u.name}`}
                        onClick={() => setPendingUploads((prev) => prev.filter((p) => p.key !== u.key))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {/* AVOS plan step 6 — the Visual Inspector Pin Chip: what was clicked in a preview,
                  pinned above the input until sent or cleared. */}
              {inspectedElement && (
                <div className="pending-uploads">
                  <span className="pending-upload-chip" title={inspectedElement.text || inspectedElement.selector}>
                    🎯 Inspecting: {inspectedElement.tag} · {inspectedElement.selector}
                    <button type="button" aria-label="Clear inspected element" onClick={() => setInspectedElement(null)}>
                      ×
                    </button>
                  </span>
                </div>
              )}
              <div className="input-top">
                <textarea
                  className="msg-input"
                  placeholder={isLoading ? "Type your next message — it'll send when this finishes…" : "Message…"}
                  value={input}
                  ref={inputRef}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSubmit();
                    }
                  }}
                  rows={1}
                />
                {/* No chatSessionId gate here — a fresh thread/Home has none yet by design
                    (lazy creation), and the input must stay usable so the first send can mint one.
                    Also shown during the retry backoff wait (selfHealStatus.mode === "waiting") —
                    nothing is running server-side then, but the agent IS about to try again on a
                    timer, and clicking Stop here ends that retry loop instead of silently doing
                    nothing (see handleStop). */}
                {(isLoading || selfHealStatus?.mode === "waiting") && !input.trim() ? (
                  <button
                    className="send-btn"
                    type="button"
                    aria-label="Stop"
                    title={
                      selfHealStatus?.mode === "waiting"
                        ? "Stop — cancels the pending automatic retry"
                        : "Stop — the agent finishes what it's doing and reports what it completed"
                    }
                    disabled={stopping}
                    onClick={() => void handleStop()}
                  >
                    {stopping ? "…" : "■"}
                  </button>
                ) : (
                <button className="send-btn" type="button" disabled={!input.trim()} onClick={() => void handleSubmit()}>
                  <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                </button>
                )}
              </div>
              {queued.length > 0 && (
                <div style={{ fontSize: 11.5, color: "var(--text3)", padding: "4px 2px 0" }}>
                  {queued.length === 1 ? "1 message queued" : `${queued.length} messages queued`} — sending when this finishes.
                  <button
                    type="button"
                    onClick={() => setQueued([])}
                    style={{ marginLeft: 8, background: "transparent", border: "none", color: "var(--text3)", cursor: "pointer", textDecoration: "underline" }}
                  >
                    clear
                  </button>
                </div>
              )}
            </div>
          </ComposerDock>
          {uploadNotice && <p style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 4 }}>{uploadNotice}</p>}
          {backgroundNotice && <p style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 4 }}>⏳ {backgroundNotice}</p>}
          <p className="disclaimer">AI-generated responses may be inaccurate.</p>
        </div>
      </div>

      <div className={`workspace-panel-shell ${panelOpen ? "open" : "collapsed"}`} style={{ width: panelOpen ? panelWidth + 12 : 56 }}>
      {panelOpen ? (
        <>
          {/* Mobile-only (CSS-gated — see packages/ui's own media query): .thread-panel becomes a
              fixed drawer below 900px, and this is what lets a tap outside it close it, matching
              #sidebar's own backdrop in the shell layout. */}
          <div className="thread-panel-backdrop show" onClick={() => setPanelOpen(false)} />
          <div className="thread-panel" style={{ width: panelWidth }}>
          <div className="thread-panel-resizer" role="separator" aria-label="Resize workspace panel" aria-orientation="vertical" onPointerDown={startPanelResize} onPointerMove={updatePanelResize} onPointerUp={() => setPanelResizeStart(null)} onPointerCancel={() => setPanelResizeStart(null)} />
          {tabMenuOpen && (
            <div className="workspace-tab-menu" role="menu" aria-label="Add workspace tab">
              {[...(threadId ? [{ key: "assistant" as WorkspaceTab, label: "Assistant" }] : []), { key: "messages" as WorkspaceTab, label: "Messages" }, ...(conversationMode ? [{ key: "model" as WorkspaceTab, label: "Model" }] : []), ...(project ? [{ key: "threads" as WorkspaceTab, label: "Threads" }] : []), ...(dockIsBusinessSpace ? [{ key: "members" as WorkspaceTab, label: "Members" }] : []), { key: "connectors" as WorkspaceTab, label: "Connected apps" }, ...sidePanelTabs(Boolean(threadId)).filter((tab) => tab.key !== "heartbeats").map((tab) => ({ key: tab.key as WorkspaceTab, label: tab.label }))].map((tab) => (
                <button key={tab.key} type="button" role="menuitem" onClick={() => openWorkspaceTab(tab.key)}>{tab.label}</button>
              ))}
            </div>
          )}
          {canvasMenuOpen && (
            <div className="workspace-tab-menu" role="menu" aria-label="Add canvas tab">
              {canvasOptions.length > 0 ? (
                canvasOptions.map((canvas) => (
                  <button key={canvas.id} type="button" role="menuitem" onClick={() => openCanvas(canvas.id, canvas.label, canvas.view)}>{canvas.view === "code" ? "⌘" : "📄"} {canvas.label}</button>
                ))
              ) : (
                <span className="workspace-tab-empty">No canvases available</span>
              )}
            </div>
          )}
          <div className="tp-tabs" aria-label="Open workspace tabs">
            <div className="tp-tab-scroll">
            {workspaceTabs.map((tab) => {
              const label = workspaceTabLabel(tab);
              return (
                <div key={tab} className={["tp-tab", panelTab === tab ? "active" : ""].filter(Boolean).join(" ")}>
                  <button type="button" className="tp-tab-label" onClick={() => setPanelTab(tab)}>{label}</button>
                  <button type="button" className="tp-tab-close" aria-label={`Close ${label} tab`} title={`Close ${label} tab`} onClick={() => closeWorkspaceTab(tab)}>×</button>
                </div>
              );
            })}
            </div>
            <div className="tp-tab-actions" aria-label="Workspace controls">
              <button type="button" className="tp-header-btn" aria-label="Add workspace tab" title="Add workspace tab" onClick={() => { setTabMenuOpen((open) => !open); setCanvasMenuOpen(false); }}>+</button>
              <button type="button" className="tp-header-btn" aria-label="List canvases" title="List canvases" onClick={() => { setCanvasMenuOpen((open) => !open); setTabMenuOpen(false); }}>◫</button>
              <button type="button" className="tp-header-btn" aria-label="Collapse workspace panel" title="Collapse workspace panel" onClick={() => setPanelOpen(false)}>×</button>
            </div>
          </div>
          <div className={`tp-body ${panelTab === "stats" ? "tp-body-stats" : ""}`}>
            {panelTab === "assistant" && threadId && (
              <SubthreadPanel spaceId={spaceId} threadId={threadId} session={session} />
            )}
            {panelTab === "messages" && (
              <div className="workspace-messages-panel">
                <div className="tp-section">Messages</div>
                {visibleMessages.length === 0 ? <p className="workspace-tab-empty">No messages yet.</p> : visibleMessages.map((message, index) => (
                  <button
                    key={message.id}
                    type="button"
                    className="workspace-message-link"
                    onClick={() => document.getElementById(`message-point-${message.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                  >
                    <span className={`workspace-message-dot ${message.role === "user" ? "user" : "assistant"}`} aria-hidden />
                    <span><strong>{message.role === "user" ? "You" : "Assistant"}</strong><small>{index + 1}</small><span>{messagePreview(message)}</span></span>
                  </button>
                ))}
              </div>
            )}
            {panelTab === "stats" && (
              <>
                <div className="tp-stat">
                  <span className="tp-stat-label">Session</span>
                  <span className="tp-stat-val">{chatSessionId?.slice(0, 8) ?? "—"}</span>
                </div>
                <div className="tp-stat">
                  <span className="tp-stat-label">Messages</span>
                  <span className="tp-stat-val">{messages.length}</span>
                </div>
                <div className="tp-stat">
                  <span className="tp-stat-label">Last run</span>
                  <span className={["tp-stat-val", lastRun?.status === "completed" ? "green" : lastRun?.status === "failed" ? "amber" : ""].filter(Boolean).join(" ")}>
                    {lastRun?.status ?? "—"}
                  </span>
                </div>
                <div className="tp-stat"><span className="tp-stat-label">Live output estimate</span><span className="tp-stat-val">{Math.ceil((liveActivity.filter(step => step.partial).map(step => step.message ?? step.narration ?? step.output ?? "").join("")).length / 3.85)} tokens</span></div>
                <div className="tp-stat"><span className="tp-stat-label">Provider usage (input / output)</span><span className="tp-stat-val">{(() => {
                  const persisted = messages.flatMap<{ input_tokens?: number; output_tokens?: number }>(message => message.metadata?.provider_usage ? [message.metadata.provider_usage] : message.activity?.filter(step => step.usage_source === "provider") ?? []);
                  const reported = [...persisted, ...liveActivity.filter(step => step.usage_source === "provider")];
                  return reported.length ? `${reported.reduce((n, step) => n + (step.input_tokens ?? 0), 0)} / ${reported.reduce((n, step) => n + (step.output_tokens ?? 0), 0)}` : "Unavailable";
                })()}</span></div>
                <ContextUsageMeter
                  spaceId={spaceId}
                  sessionId={chatSessionId}
                  session={session}
                  model={selectedModel}
                  refreshKey={messages.length}
                />
              </>
            )}
            {panelTab === "threads" && project && (
              <div className="workspace-threads">
                <div className="tp-section"># Team Room</div>
                {(["tier_1_team", "tier_2_task", "tier_3_consult", "tier_4_scratchpad"] as const).map((tier) => {
                  const rows = projectThreads.filter((thread) => (thread.thread_tier ?? "tier_2_task") === tier);
                  const heading = tier === "tier_1_team" ? "Team room" : tier === "tier_2_task" ? "Task threads" : tier === "tier_3_consult" ? "Worker consultations" : "Private scratchpads";
                  return <React.Fragment key={tier}><div className="tp-section">{heading}</div>{rows.length === 0 ? <p className="workspace-tab-empty">No {heading.toLowerCase()}.</p> : rows.map((thread) => (
                    <Link key={thread.id} className={["tp-thread-link", thread.id === threadId ? "active" : ""].filter(Boolean).join(" ")} href={slug ? `/p/${slug}/threads/${thread.id}` : "#"}>{tier === "tier_1_team" ? "#" : tier === "tier_4_scratchpad" ? "◌" : "◇"} {thread.title || heading}</Link>
                  ))}</React.Fragment>;
                })}
              </div>
            )}
            {panelTab === "model" && conversationMode && (
              <div className="workspace-model-settings">
                <div className="tp-section">Planner model</div>
                <div className="workspace-active-model">{modelLabel(selectedModel)} <span>· {effortOptionsForModel(selectedModel).find((option) => option.level === selectedEffort)?.label ?? selectedEffort}</span></div>
                <p className="workspace-tab-empty">This choice sets the lead planner. Leaf workers are selected automatically from task context and the Effort cost ceiling. Cost tiers are relative; actual cost varies with usage.</p>
                <div className="workspace-model-filters">
                  <input type="search" placeholder="Search models…" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} />
                  <select aria-label="Filter models by provider" value={modelProvider} onChange={(event) => setModelProvider(event.target.value)}><option value="all">All providers</option>{modelProviders.map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select>
                </div>
                <div className="workspace-model-grid">
                  {filteredModels.map((model) => (
                    <button key={model} type="button" className={["workspace-model-card", model === selectedModel ? "active" : ""].filter(Boolean).join(" ")} title={benchmarkForModel(model) ? `${benchmarkForModel(model)!.costTier} relative cost (${benchmarkForModel(model)!.costBasis}): ${benchmarkForModel(model)!.costNote}` : undefined} onClick={() => handleModelChange(model)}><span>{modelLabel(model)}</span><small>{providerForModel(model)} · {benchmarkForModel(model)?.costTier ?? "standard"} ({benchmarkForModel(model)?.costBasis ?? "estimated"})</small>{model === selectedModel && <b>Selected</b>}</button>
                  ))}
                </div>
                <div className="tp-section">Planner effort and worker cost ceiling</div>
                {effortOptionsForModel(selectedModel).map((option) => (
                  <button key={option.level} type="button" className={['tp-thread-link', option.level === selectedEffort ? 'active' : ''].filter(Boolean).join(' ')} onClick={() => handleEffortChange(option.level)}>{option.level.toUpperCase()}{option.level === selectedEffort ? " ✓" : ""}</button>
                ))}
              </div>
            )}
            {panelTab === "connectors" && (
              <div className="workspace-threads">
                <div className="tp-section">Connected apps</div>
                {workspaceConnectors === null ? <p className="workspace-tab-empty">Loading apps…</p> : workspaceConnectors.length === 0 ? <p className="workspace-tab-empty">No apps available yet.</p> : workspaceConnectors.map((connector) => <div key={connector.id} className="workspace-directory-row"><span className={connector.connected ? "connected" : ""}>{connector.logo ? <img src={connector.logo} alt="" /> : connector.name.slice(0, 1)}</span><div><strong>{connector.name}</strong><small>{connector.category}</small></div><b>{connector.connected ? "Connected" : connector.status === "available" ? "Available" : "Soon"}</b></div>)}
                {slug && <Link className="tp-thread-link active" href={`/p/${slug}/connectors`}>Advanced connected app settings →</Link>}
              </div>
            )}
            {panelTab === "members" && (
              <div className="workspace-threads">
                <div className="tp-section">Workspace members</div>
                {workspaceMembers === null ? <p className="workspace-tab-empty">Loading members…</p> : workspaceMembers.length === 0 ? <p className="workspace-tab-empty">No workspace members found.</p> : workspaceMembers.map((member) => <div key={member.end_user_id} className="workspace-directory-row"><span>{member.end_user_id.slice(0, 2).toUpperCase()}</span><div><strong>{member.end_user_id}</strong><small>Joined {new Date(member.joined_at).toLocaleDateString()}</small></div><b>{member.role}</b></div>)}
                {slug && <Link className="tp-thread-link active" href={`/p/${slug}/settings`}>Advanced member settings →</Link>}
              </div>
            )}
            {panelTab.startsWith("canvas:") && project && (
              <div className="workspace-canvas-tab">
                <CanvasContainer project={project} spaceId={spaceId} creds={session} standalone canvasView={canvases.find((canvas) => `canvas:${canvas.id}` === panelTab)?.view ?? "deliverable"} />
              </div>
            )}
            {panelTab !== "stats" && panelTab !== "assistant" && panelTab !== "threads" && panelTab !== "messages" && panelTab !== "model" && panelTab !== "connectors" && panelTab !== "members" && !panelTab.startsWith("canvas:") && (
              <AssistantSidePanelBody
                spaceId={spaceId}
                session={session}
                tab={panelTab as SidePanelTab}
                // Only in a project thread, and only when the switcher has an explicit agent
                // picked (not the synthetic "Space Assistant (default)" entry, id "") — otherwise
                // Config falls back to the space-wide policy, which is the correct behavior when
                // nothing is explicitly bound.
                agentId={projectId && selectedAgentId ? selectedAgentId : undefined}
                projectId={projectId}
                projectAgentIds={project?.allowed_agent_ids}
                // lastRun resets on reload (client-only state) — without the fallback, the
                // Sub-agents tab would say "no run yet in this conversation" right after a
                // refresh even when the assistant genuinely ran a sub-agent last message. The
                // last assistant message's own persisted run_id (metadata, durable) covers that.
                lastRunId={lastRun?.id ?? latestPersistedRunId}
                // The agent DO is addressed per conversation, so Sub-agents has to name THIS
                // session or it reads the space-wide assistant DO — which never saw this chat's
                // spawns and therefore always answered "none".
                sessionId={chatSessionId}
                isBusinessSpace={dockIsBusinessSpace}
              />
            )}
          </div>
        </div>
        </>
      ) : (
        <aside className="workspace-tab-rail" aria-label="Collapsed workspace tabs">
          <button
            type="button"
            className="workspace-rail-toggle"
            aria-label="Open workspace panel"
            title="Open workspace panel"
            onClick={() => setPanelOpen(true)}
          >
            ‹
          </button>
          <div className="workspace-rail-tabs" aria-label="Workspace tabs">
            {workspaceTabs.map((tab) => {
              const label = workspaceTabLabel(tab);
              return (
                <button
                  key={tab}
                  type="button"
                  className={["workspace-rail-tab", panelTab === tab ? "active" : ""].filter(Boolean).join(" ")}
                  aria-label={`Open ${label} tab`}
                  title={label}
                  onClick={() => { setPanelTab(tab); setPanelOpen(true); }}
                >
                  {workspaceTabIcon(tab)}
                </button>
              );
            })}
          </div>
        </aside>
      )}
      </div>
    </div>
  );
}
