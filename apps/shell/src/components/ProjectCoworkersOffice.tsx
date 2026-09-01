"use client";

import * as React from "react";
import Link from "next/link";
import {
  Card,
  CardLabel,
  CardValue,
  Modal,
  FormInput,
  FormSelect,
  FormTextarea,
  useToast,
  Toast,
} from "@naelao/ui";
import {
  listProjectRoster,
  upsertProjectRosterBot,
  updateProjectRosterBot,
  deleteProjectRosterBot,
  getProjectJournalFull,
  checkProjectGoalsCycle,
  getProjectSpendCap,
  updateProjectSpendCap,
  recordProjectCommit,
  updateProject,
  type ProjectRosterBot,
  type ProjectGitCommit,
  type ProjectJournalFull,
  type ProjectSpendCap as ProjectSpendCapType,
  type SessionCredentials,
  type Project,
} from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";

interface ProjectCoworkersOfficeProps {
  project: Project;
  spaceId: string;
  productSlug: string;
  creds: SessionCredentials;
  onOpenThread?: (threadId: string) => void;
}

const PRESET_BOT_ARCHETYPES = [
  {
    name: "Architect Bot",
    handle: "@ArchitectBot",
    role: "System Architecture & Task Planning",
    avatar: "📐",
    model: "google/gemini-2.5-pro",
    skills: ["task_decomposition", "schema_scaffolding", "pr_planning"],
    activity: "Monitoring backlog & milestone architecture",
  },
  {
    name: "Dev Bot",
    handle: "@DevBot",
    role: "Full-Stack Implementation Engineer",
    avatar: "⚡",
    model: "anthropic/claude-3-7-sonnet",
    skills: ["code_execution", "git_branching", "sqlite_fs", "npm_test"],
    activity: "Ready for feature tasks & bug fixes",
  },
  {
    name: "Review Bot",
    handle: "@ReviewBot",
    role: "Autonomous Code Review & QA",
    avatar: "🔍",
    model: "openai/gpt-4.5-turbo",
    skills: ["ast_linting", "security_scan", "diff_audit", "pr_merge"],
    activity: "Waiting for open Pull Requests",
  },
  {
    name: "Ops Bot",
    handle: "@OpsBot",
    role: "DevOps, Journal Sync & Deployments",
    avatar: "🚀",
    model: "groq/llama-3.3-70b",
    skills: ["journal_sync", "cf_pages_deploy", "container_health"],
    activity: "Synchronizing project journal & health checks",
  },
  {
    name: "Security Auditor Bot",
    handle: "@SecurityBot",
    role: "Vulnerability Scanning & Auth Hardening",
    avatar: "🛡️",
    model: "anthropic/claude-3-7-sonnet",
    skills: ["jwt_audit", "sql_injection_defense", "rbac_verification"],
    activity: "Continuous permission rule analysis",
  },
  {
    name: "Growth & Analytics Bot",
    handle: "@GrowthBot",
    role: "SEO, Landing Page Copy & Funnel Analytics",
    avatar: "📈",
    model: "google/gemini-2.5-flash",
    skills: ["seo_optimization", "copywriting", "conversion_tracking"],
    activity: "Optimizing conversion funnels",
  },
];

export function ProjectCoworkersOffice({
  project,
  spaceId,
  productSlug,
  creds,
}: ProjectCoworkersOfficeProps) {
  const { show, toast } = useToast();
  const [loading, setLoading] = React.useState(true);
  const [journal, setJournal] = React.useState<ProjectJournalFull | null>(null);
  const [spendCap, setSpendCap] = React.useState<ProjectSpendCapType | null>(null);
  const [activeTab, setActiveTab] = React.useState<"roster" | "journal" | "commits" | "spend">("roster");

  // Add Bot Modal state
  const [addBotOpen, setAddBotOpen] = React.useState(false);
  const [botName, setBotName] = React.useState("");
  const [botHandle, setBotHandle] = React.useState("");
  const [botRole, setBotRole] = React.useState("");
  const [botAvatar, setBotAvatar] = React.useState("🤖");
  const [botModel, setBotModel] = React.useState("google/gemini-2.5-pro");
  const [botSkills, setBotSkills] = React.useState("");
  const [submittingBot, setSubmittingBot] = React.useState(false);

  // Spend limit modal state
  const [spendModalOpen, setSpendModalOpen] = React.useState(false);
  const [draftSpendLimit, setDraftSpendLimit] = React.useState("1000");
  const [savingSpend, setSavingSpend] = React.useState(false);

  // Quick commit simulator modal
  const [commitModalOpen, setCommitModalOpen] = React.useState(false);
  const [commitMessage, setCommitMessage] = React.useState("");
  const [commitBranch, setCommitBranch] = React.useState("main");
  const [commitAuthorBot, setCommitAuthorBot] = React.useState("@DevBot");
  const [recordingCommit, setRecordingCommit] = React.useState(false);

  // Delegation cycle state
  const [cyclingGoals, setCyclingGoals] = React.useState(false);
  const [lifecycle, setLifecycle] = React.useState<"finite" | "continuous">(
    (project.lifecycle as "finite" | "continuous") || "finite"
  );
  const [updatingLifecycle, setUpdatingLifecycle] = React.useState(false);

  const loadData = React.useCallback(async () => {
    try {
      const [journalData, spendData] = await Promise.all([
        getProjectJournalFull(spaceId, project.id, creds),
        getProjectSpendCap(spaceId, project.id, creds),
      ]);
      setJournal(journalData);
      setSpendCap(spendData);
      setDraftSpendLimit(String(spendData.daily_credit_limit));
    } catch {
      // Best-effort fallback
    } finally {
      setLoading(false);
    }
  }, [spaceId, project.id, creds]);

  React.useEffect(() => {
    void loadData();
    const interval = setInterval(loadData, 12000); // Live poll for team office status
    return () => clearInterval(interval);
  }, [loadData]);

  async function handleAddBot(e: React.FormEvent) {
    e.preventDefault();
    if (!botName.trim() || !botHandle.trim() || submittingBot) return;
    setSubmittingBot(true);
    try {
      const skillsArray = botSkills
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await upsertProjectRosterBot(
        spaceId,
        project.id,
        {
          name: botName.trim(),
          handle: botHandle.startsWith("@") ? botHandle.trim() : `@${botHandle.trim()}`,
          role: botRole.trim() || "Autonomous Specialist",
          avatar: botAvatar.trim() || "🤖",
          model: botModel,
          skills: skillsArray.length > 0 ? skillsArray : ["code_runner", "task_execution"],
          status: "idle",
          current_activity: "Ready for task assignments",
        },
        creds
      );
      show(`Added ${botName} to project roster`);
      setAddBotOpen(false);
      setBotName("");
      setBotHandle("");
      setBotRole("");
      setBotSkills("");
      await loadData();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to add bot coworker");
    } finally {
      setSubmittingBot(false);
    }
  }

  function applyPreset(preset: typeof PRESET_BOT_ARCHETYPES[0]) {
    setBotName(preset.name);
    setBotHandle(preset.handle);
    setBotRole(preset.role);
    setBotAvatar(preset.avatar);
    setBotModel(preset.model);
    setBotSkills(preset.skills.join(", "));
  }

  async function handleSaveSpend(e: React.FormEvent) {
    e.preventDefault();
    setSavingSpend(true);
    try {
      const limit = Number(draftSpendLimit) || 1000;
      await updateProjectSpendCap(spaceId, project.id, { daily_credit_limit: limit, reset_tripped: true }, creds);
      show("Updated project daily spend cap");
      setSpendModalOpen(false);
      await loadData();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to update spend limit");
    } finally {
      setSavingSpend(false);
    }
  }

  async function handleRecordCommit(e: React.FormEvent) {
    e.preventDefault();
    if (!commitMessage.trim() || recordingCommit) return;
    setRecordingCommit(true);
    try {
      await recordProjectCommit(
        spaceId,
        project.id,
        {
          branch: commitBranch.trim() || "main",
          message: commitMessage.trim(),
          author_name: commitAuthorBot,
          author_type: "bot",
          diff_stats: { files_changed: 2, additions: 45, deletions: 12 },
        },
        creds
      );
      show("Recorded git commit in Cloudflare Artifacts ledger");
      setCommitModalOpen(false);
      setCommitMessage("");
      await loadData();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to record commit");
    } finally {
      setRecordingCommit(false);
    }
  }

  async function handleToggleLifecycle(next: "finite" | "continuous") {
    if (updatingLifecycle || next === lifecycle) return;
    setUpdatingLifecycle(true);
    try {
      await updateProject(spaceId, project.id, creds, { lifecycle: next });
      setLifecycle(next);
      show(
        next === "finite"
          ? "Mode set to Finite Sprint: Alarms will clear and project will hibernate at $0 once all tasks complete."
          : "Mode set to Continuous 24/7 Desk: Active listening for schedules, webhooks, and chats."
      );
      await loadData();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to update project lifecycle");
    } finally {
      setUpdatingLifecycle(false);
    }
  }

  async function handleTriggerGoalCheck() {
    setCyclingGoals(true);
    try {
      const res = await checkProjectGoalsCycle(spaceId, project.id, creds);
      if (res.all_completed) {
        show("🎉 All sprint tasks completed! Triggered Space Assistant next cycle delegation.");
      } else {
        show(`Sprint in progress (${res.completed}/${res.total} tasks complete).`);
      }
      await loadData();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to check sprint cycle");
    } finally {
      setCyclingGoals(false);
    }
  }

  const roster = journal?.roster ?? [];
  const tasks = journal?.tasks ?? [];
  const commits = journal?.commits ?? [];
  const summary = journal?.summary ?? {
    totalTasks: 0,
    completedTasks: 0,
    inProgressTasks: 0,
    blockedTasks: 0,
    pendingTasks: 0,
    progressPct: 100,
    allGoalsCompleted: true,
  };

  const spendUsed = spendCap?.today_credits_used ?? 0;
  const spendLimit = spendCap?.daily_credit_limit ?? 1000;
  const spendPct = Math.min(100, Math.round((spendUsed / spendLimit) * 100));

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "18px 20px",
        marginBottom: 24,
      }}
    >
      {/* Header with Title & Navigation Tabs */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
          paddingBottom: 14,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              background: "rgba(99, 102, 241, 0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
            }}
          >
            🏢
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
                Multi-Agent Virtual Office
              </span>
              <span
                className="badge badge-green"
                style={{ fontSize: 10, padding: "2px 6px" }}
              >
                {roster.filter((b) => b.status === "working").length} Active Now
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text3)" }}>
              Autonomous Coworkers · Living Project Journal · Git Artifacts Stream
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setSpendModalOpen(true)}
            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}
          >
            <span style={{ fontSize: 13 }}>💳</span>
            <span>Spend: {spendUsed}/{spendLimit} cr</span>
            {spendCap?.circuit_breaker_tripped && (
              <span className="badge" style={{ background: "#ef4444", color: "#fff", fontSize: 9 }}>
                Tripped
              </span>
            )}
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setCommitModalOpen(true)}
            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}
          >
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor" width={12} height={12}>
              <circle cx="8" cy="8" r="3" /><line x1="8" y1="1" x2="8" y2="5" /><line x1="8" y1="11" x2="8" y2="15" />
            </svg>
            + Commit
          </button>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setAddBotOpen(true)}
            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}
          >
            <span style={{ fontSize: 13 }}>+</span>
            <span>Add Coworker Bot</span>
          </button>
        </div>
      </div>

      {/* Lifecycle Architecture & Hibernation Status Banner */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          padding: "10px 14px",
          background: "var(--surface2)",
          borderRadius: 8,
          border: "1px solid var(--border)",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text2)" }}>
            Lifecycle Engine:
          </span>
          <div style={{ display: "inline-flex", borderRadius: 6, padding: 2, background: "var(--surface)" }}>
            <button
              type="button"
              disabled={updatingLifecycle}
              onClick={() => void handleToggleLifecycle("finite")}
              style={{
                fontSize: 11,
                padding: "3px 10px",
                borderRadius: 4,
                border: "none",
                cursor: "pointer",
                fontWeight: lifecycle === "finite" ? 600 : 400,
                background: lifecycle === "finite" ? "var(--accent)" : "transparent",
                color: lifecycle === "finite" ? "#fff" : "var(--text3)",
                transition: "all 0.15s ease",
              }}
              title="Build & Sleep: Automatically hibernates at $0 when tasks reach 100%"
            >
              🏁 Finite Task (Build & Sleep)
            </button>
            <button
              type="button"
              disabled={updatingLifecycle}
              onClick={() => void handleToggleLifecycle("continuous")}
              style={{
                fontSize: 11,
                padding: "3px 10px",
                borderRadius: 4,
                border: "none",
                cursor: "pointer",
                fontWeight: lifecycle === "continuous" ? 600 : 400,
                background: lifecycle === "continuous" ? "var(--accent)" : "transparent",
                color: lifecycle === "continuous" ? "#fff" : "var(--text3)",
                transition: "all 0.15s ease",
              }}
              title="Standing Desk: Stays awake 24/7 for customer messages, webhooks, and cron loops"
            >
              🔄 Standing Desk (Continuous 24/7)
            </button>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {lifecycle === "finite" ? (
            summary.allGoalsCompleted && summary.totalTasks > 0 ? (
              <span
                className="badge"
                style={{
                  background: "rgba(16, 185, 129, 0.15)",
                  color: "#10b981",
                  border: "1px solid rgba(16, 185, 129, 0.3)",
                  fontSize: 11,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
                title="All sprint tasks completed. Durable Object alarms are cleared to prevent runaway token spend."
              >
                💤 Hibernating ($0 Cost · Alarms Cleared)
              </span>
            ) : (
              <span
                className="badge badge-yellow"
                style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}
              >
                ⚡ Active Sprint ({summary.completedTasks}/{summary.totalTasks} Tasks)
              </span>
            )
          ) : (
            <span
              className="badge"
              style={{
                background: "rgba(59, 130, 246, 0.15)",
                color: "#3b82f6",
                border: "1px solid rgba(59, 130, 246, 0.3)",
                fontSize: 11,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
              title="Continuous listening mode for 24/7 operations, webhooks, and chat channels."
            >
              🔄 24/7 Standing Loop Active
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => setActiveTab("roster")}
          className="btn btn-sm"
          style={{
            background: activeTab === "roster" ? "var(--accent)" : "var(--surface2)",
            color: activeTab === "roster" ? "#fff" : "var(--text2)",
            border: "1px solid var(--border)",
            fontSize: 12,
            padding: "4px 12px",
          }}
        >
          🤖 Coworker Roster ({roster.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("journal")}
          className="btn btn-sm"
          style={{
            background: activeTab === "journal" ? "var(--accent)" : "var(--surface2)",
            color: activeTab === "journal" ? "#fff" : "var(--text2)",
            border: "1px solid var(--border)",
            fontSize: 12,
            padding: "4px 12px",
          }}
        >
          📋 Living Journal ({summary.completedTasks}/{summary.totalTasks} Done)
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("commits")}
          className="btn btn-sm"
          style={{
            background: activeTab === "commits" ? "var(--accent)" : "var(--surface2)",
            color: activeTab === "commits" ? "#fff" : "var(--text2)",
            border: "1px solid var(--border)",
            fontSize: 12,
            padding: "4px 12px",
          }}
        >
          ⚡ Git Commits ({commits.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("spend")}
          className="btn btn-sm"
          style={{
            background: activeTab === "spend" ? "var(--accent)" : "var(--surface2)",
            color: activeTab === "spend" ? "#fff" : "var(--text2)",
            border: "1px solid var(--border)",
            fontSize: 12,
            padding: "4px 12px",
          }}
        >
          🛡️ Spend & Circuit Breaker
        </button>
      </div>

      {/* TAB 1: COWORKER ROSTER */}
      {activeTab === "roster" && (
        <div>
          {roster.length === 0 ? (
            <div style={{ textAlign: "center", padding: "24px 0", color: "var(--text3)", fontSize: 13 }}>
              No bot coworkers configured yet. Click &ldquo;Add Coworker Bot&rdquo; to bootstrap your AI team pod.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                gap: 12,
              }}
            >
              {roster.map((bot) => {
                const isWorking = bot.status === "working";
                const isBlocked = bot.status === "blocked";
                return (
                  <div
                    key={bot.id}
                    style={{
                      background: "var(--surface2)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "14px 16px",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      transition: "all var(--transition)",
                    }}
                  >
                    <div>
                      {/* Top: Avatar, Name, Handle & Status Badge */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: 8,
                          marginBottom: 8,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 24 }}>{bot.avatar || "🤖"}</span>
                          <div>
                            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
                              {bot.name}
                            </div>
                            <div style={{ fontSize: 11.5, color: "var(--accent)" }}>
                              {bot.handle}
                            </div>
                          </div>
                        </div>
                        <span
                          className={`badge ${isWorking ? "badge-green" : isBlocked ? "badge-amber" : ""}`}
                          style={{
                            fontSize: 10,
                            padding: "2px 6px",
                            background: !isWorking && !isBlocked ? "var(--surface3)" : undefined,
                            color: !isWorking && !isBlocked ? "var(--text3)" : undefined,
                          }}
                        >
                          <span
                            className="badge-dot"
                            style={{
                              background: isWorking ? "#22c55e" : isBlocked ? "#f59e0b" : "#94a3b8",
                            }}
                          />
                          {bot.status.toUpperCase()}
                        </span>
                      </div>

                      {/* Role & Current Activity */}
                      <div style={{ fontSize: 12, color: "var(--text2)", marginBottom: 6, fontWeight: 500 }}>
                        {bot.role}
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "var(--text3)",
                          background: "var(--surface)",
                          padding: "6px 8px",
                          borderRadius: 6,
                          border: "1px solid var(--border)",
                          marginBottom: 10,
                          lineHeight: 1.4,
                        }}
                      >
                        <strong style={{ color: "var(--text2)" }}>Activity: </strong>
                        {bot.current_activity || "Standing by for instructions"}
                      </div>

                      {/* Skills Tags */}
                      {bot.skills && bot.skills.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
                          {bot.skills.map((skill) => (
                            <span
                              key={skill}
                              style={{
                                fontSize: 9.5,
                                color: "var(--text3)",
                                background: "var(--surface3)",
                                padding: "1px 5px",
                                borderRadius: 3,
                              }}
                            >
                              #{skill}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Footer: Model & Actions */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        paddingTop: 8,
                        borderTop: "1px solid var(--border)",
                        fontSize: 11,
                        color: "var(--text3)",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
                        {bot.model?.split("/")[1] ?? "gemini-2.5-pro"}
                      </span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Link
                          href={`/p/${productSlug}/projects/${project.id}?mention=${encodeURIComponent(bot.handle)}`}
                          className="btn btn-ghost btn-sm"
                          style={{ fontSize: 10.5, padding: "2px 6px", textDecoration: "none" }}
                        >
                          @Mention
                        </Link>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: LIVING PROJECT JOURNAL & DAG */}
      {activeTab === "journal" && (
        <div>
          {/* Sprint Progress Gauge */}
          <div
            style={{
              background: "var(--surface2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "12px 16px",
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                <span style={{ fontWeight: 600, color: "var(--text)" }}>Sprint Milestone Goals</span>
                <span style={{ color: "var(--accent)", fontWeight: 600 }}>{summary.progressPct}% Complete</span>
              </div>
              <div
                style={{
                  height: 8,
                  width: "100%",
                  background: "var(--surface3)",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${summary.progressPct}%`,
                    background: summary.progressPct === 100 ? "#22c55e" : "var(--accent)",
                    transition: "width 0.4s ease",
                  }}
                />
              </div>
            </div>

            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleTriggerGoalCheck}
              disabled={cyclingGoals}
              style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 5 }}
            >
              <span>{cyclingGoals ? "Delegating..." : "🔄 Trigger Sprint Delegation"}</span>
            </button>
          </div>

          {/* Task DAG List */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {tasks.length === 0 ? (
              <div style={{ textAlign: "center", padding: "16px 0", color: "var(--text3)", fontSize: 13 }}>
                No active tasks in journal. The Space Assistant creates sub-agent DAG tasks automatically during sprint planning.
              </div>
            ) : (
              tasks.map((task) => {
                const isCompleted = task.status === "completed";
                const isProgress = task.status === "in_progress";
                const isBlocked = task.status === "blocked";
                return (
                  <div
                    key={task.id}
                    style={{
                      background: "var(--surface2)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "10px 14px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 14 }}>
                        {isCompleted ? "✅" : isProgress ? "⏳" : isBlocked ? "🚫" : "📋"}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            color: isCompleted ? "var(--text3)" : "var(--text)",
                            textDecoration: isCompleted ? "line-through" : "none",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {task.title}
                        </div>
                        {task.assigned_agent && (
                          <div style={{ fontSize: 11, color: "var(--accent)" }}>
                            Assigned to {task.assigned_agent}
                          </div>
                        )}
                      </div>
                    </div>

                    <span
                      className={`badge ${isCompleted ? "badge-green" : isProgress ? "badge-blue" : isBlocked ? "badge-amber" : ""}`}
                      style={{ fontSize: 10, padding: "2px 6px", textTransform: "capitalize" }}
                    >
                      {task.status.replace("_", " ")}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* TAB 3: GIT COMMITS STREAM */}
      {activeTab === "commits" && (
        <div>
          {commits.length === 0 ? (
            <div style={{ textAlign: "center", padding: "20px 0", color: "var(--text3)", fontSize: 13 }}>
              No commits pushed yet. AI coworkers record autonomous commits with diff stats when merging PRs into Cloudflare Artifacts.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {commits.map((commit) => (
                <div
                  key={commit.id}
                  style={{
                    background: "var(--surface2)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "10px 14px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 11,
                        fontFamily: "monospace",
                        background: "var(--surface3)",
                        padding: "2px 6px",
                        borderRadius: 4,
                        color: "var(--accent)",
                        fontWeight: 600,
                      }}
                    >
                      {commit.id.slice(0, 9)}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color: "var(--text)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {commit.message}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text3)", display: "flex", gap: 8 }}>
                        <span>by <strong>{commit.author_name}</strong></span>
                        <span>·</span>
                        <span style={{ color: "var(--text2)" }}>branch: {commit.branch}</span>
                        {commit.pr_id && (
                          <>
                            <span>·</span>
                            <span style={{ color: "var(--accent)" }}>PR #{commit.pr_id}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    {commit.diff_stats && (commit.diff_stats.additions !== undefined || commit.diff_stats.deletions !== undefined) && (
                      <div style={{ fontSize: 11, fontFamily: "monospace", marginBottom: 2 }}>
                        <span style={{ color: "#22c55e" }}>+{commit.diff_stats.additions ?? 0}</span>{" "}
                        <span style={{ color: "#ef4444" }}>-{commit.diff_stats.deletions ?? 0}</span>
                      </div>
                    )}
                    <div style={{ fontSize: 10.5, color: "var(--text3)" }}>
                      {relativeTime(commit.created_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: SPEND & CIRCUIT BREAKER */}
      {activeTab === "spend" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div
            style={{
              background: "var(--surface2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "14px 16px",
            }}
          >
            <div style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
              Daily Compute Usage
            </div>
            <div style={{ fontSize: 24, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
              {spendUsed} <span style={{ fontSize: 14, color: "var(--text3)", fontWeight: 400 }}>/ {spendLimit} credits</span>
            </div>
            <div
              style={{
                height: 8,
                width: "100%",
                background: "var(--surface3)",
                borderRadius: 4,
                overflow: "hidden",
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${spendPct}%`,
                  background: spendPct > 90 ? "#ef4444" : spendPct > 75 ? "#f59e0b" : "var(--accent)",
                }}
              />
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text3)" }}>
              Auto-resets at 00:00 UTC ({spendCap?.last_reset_date || "Today"})
            </div>
          </div>

          <div
            style={{
              background: "var(--surface2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                Circuit Breaker Safety
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: spendCap?.circuit_breaker_tripped ? "#ef4444" : "#22c55e",
                  }}
                />
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                  {spendCap?.circuit_breaker_tripped ? "Circuit Breaker Tripped" : "Protection Active"}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text3)", lineHeight: 1.4 }}>
                Recursion depth limit (&le; 4) and budget capping prevent runaway bot loops from exhausting your balance.
              </div>
            </div>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSpendModalOpen(true)}
              style={{ fontSize: 11, alignSelf: "flex-start", marginTop: 10 }}
            >
              Adjust Limit / Reset
            </button>
          </div>
        </div>
      )}

      {/* MODAL: ADD COWORKER BOT */}
      <Modal open={addBotOpen} onClose={() => setAddBotOpen(false)} title="Add AI Coworker to Project Pod">
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 500, color: "var(--text2)", display: "block", marginBottom: 6 }}>
            Quick Start Archetypes
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {PRESET_BOT_ARCHETYPES.map((preset) => (
              <button
                key={preset.name}
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => applyPreset(preset)}
                style={{ fontSize: 11, padding: "3px 8px" }}
              >
                {preset.avatar} {preset.name}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleAddBot} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <FormInput
            label="Coworker Name"
            placeholder="e.g. Architect Bot"
            value={botName}
            onChange={(e) => setBotName(e.target.value)}
            required
          />
          <FormInput
            label="Chat Handle (@mention)"
            placeholder="e.g. @ArchitectBot"
            value={botHandle}
            onChange={(e) => setBotHandle(e.target.value)}
            required
          />
          <FormInput
            label="Role & Focus"
            placeholder="e.g. System Architecture & Task Planning"
            value={botRole}
            onChange={(e) => setBotRole(e.target.value)}
            required
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
            <FormInput
              label="Avatar Emoji"
              placeholder="🤖"
              value={botAvatar}
              onChange={(e) => setBotAvatar(e.target.value)}
            />
            <FormSelect
              label="LLM Engine"
              value={botModel}
              onChange={(e) => setBotModel(e.target.value)}
              options={[
                { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (Architecture & Complex Logic)" },
                { value: "anthropic/claude-3-7-sonnet", label: "Claude 3.7 Sonnet (Coding & Testing)" },
                { value: "openai/gpt-4.5-turbo", label: "GPT-4.5 Turbo (Code Review & Audit)" },
                { value: "groq/llama-3.3-70b", label: "Llama 3.3 70B (Fast Ops & Summaries)" },
              ]}
            />
          </div>
          <FormInput
            label="Specialist Skills (comma separated)"
            placeholder="code_execution, git_branching, schema_scaffolding"
            value={botSkills}
            onChange={(e) => setBotSkills(e.target.value)}
          />

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAddBotOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={submittingBot}>
              {submittingBot ? "Adding..." : "Add to Project Roster"}
            </button>
          </div>
        </form>
      </Modal>

      {/* MODAL: ADJUST SPEND LIMIT */}
      <Modal open={spendModalOpen} onClose={() => setSpendModalOpen(false)} title="Project Daily Compute Spend Limit">
        <form onSubmit={handleSaveSpend} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ fontSize: 12.5, color: "var(--text2)", margin: 0 }}>
            Configure the maximum daily AI compute credits this project pod can consume across all autonomous coworkers and heartbeat runs.
          </p>
          <FormInput
            label="Daily Credit Limit"
            type="number"
            value={draftSpendLimit}
            onChange={(e) => setDraftSpendLimit(e.target.value)}
            required
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSpendModalOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={savingSpend}>
              {savingSpend ? "Saving..." : "Save Limit & Reset Breaker"}
            </button>
          </div>
        </form>
      </Modal>

      {/* MODAL: RECORD GIT COMMIT */}
      <Modal open={commitModalOpen} onClose={() => setCommitModalOpen(false)} title="Record Project Git Commit">
        <form onSubmit={handleRecordCommit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <FormInput
            label="Commit Message"
            placeholder="e.g. feat(billing): add stripe webhook handler"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            required
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <FormInput
              label="Branch"
              placeholder="main"
              value={commitBranch}
              onChange={(e) => setCommitBranch(e.target.value)}
            />
            <FormSelect
              label="Author Bot"
              value={commitAuthorBot}
              onChange={(e) => setCommitAuthorBot(e.target.value)}
              options={roster.map((b) => ({ value: b.handle, label: `${b.avatar || "🤖"} ${b.name} (${b.handle})` }))}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCommitModalOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={recordingCommit}>
              {recordingCommit ? "Recording..." : "Record Commit"}
            </button>
          </div>
        </form>
      </Modal>

      {toast && <Toast message={toast.message} />}
    </div>
  );
}
