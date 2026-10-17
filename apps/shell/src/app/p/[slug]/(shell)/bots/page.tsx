"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardDesc, CardTitle } from "@naelao/ui";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProduct } from "@/lib/product-context";
import { useSessionCredentials } from "@/lib/auth-provider";
import { createThread, listAgentDefinitions, listProjects, listScheduledJobs, listThreads, type AgentDefinitionSummary, type Project, type ScheduledJob, type ThreadSummary } from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";

export default function ProjectBotsPage() {
  const product = useProduct();
  const { activeSpaceId } = useActiveSpace();
  const session = useSessionCredentials();
  const router = useRouter();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [agents, setAgents] = React.useState<AgentDefinitionSummary[]>([]);
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [scheduledJobs, setScheduledJobs] = React.useState<ScheduledJob[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [creatingProjectId, setCreatingProjectId] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setLoadError(false);
    setProjects([]);
    setAgents([]);
    setThreads([]);
      setScheduledJobs([]);
    try {
      const [nextProjects, nextAgents, nextThreads, nextJobs] = await Promise.all([
        listProjects(activeSpaceId, session),
        listAgentDefinitions(activeSpaceId, session),
        listThreads(activeSpaceId, session),
        listScheduledJobs(activeSpaceId, session, { projectId: null, visibleProjects: true }),
      ]);
      setProjects(nextProjects.filter((project) => project.status === "active"));
      setAgents(nextAgents);
      setThreads(nextThreads.filter((thread) => thread.project_id && !thread.parent_thread_id && thread.thread_kind === "primary"));
      setScheduledJobs(nextJobs);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [activeSpaceId, session]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const agentById = React.useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const latestThreadByProject = React.useMemo(() => {
    const latest = new Map<string, ThreadSummary>();
    for (const thread of threads) {
      const projectId = thread.project_id;
      if (!projectId) continue;
      const current = latest.get(projectId);
      if (!current || new Date(thread.updated_at).getTime() > new Date(current.updated_at).getTime()) latest.set(projectId, thread);
    }
    return latest;
  }, [threads]);

  const reviewSignals = React.useMemo(() => {
    const inactivityCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return projects.filter((project) => {
      const activity = Date.parse(project.last_activity_at ?? project.created_at);
      return project.status === "active" && Number.isFinite(activity) && activity < inactivityCutoff;
    });
  }, [projects]);

  async function startThread(project: Project, panel?: "crons") {
    if (!session || creatingProjectId) return;
    setCreatingProjectId(project.id);
    try {
      const thread = await createThread(activeSpaceId, session, { project_id: project.id, title: "Project Bot" });
      router.push(`/p/${product.slug}/threads/${thread.id}${panel ? `?panel=${panel}` : ""}`);
    } catch {
      setLoadError(true);
      setCreatingProjectId(null);
    }
  }

  const openThread = (threadId: string, panel?: "crons") => router.push(`/p/${product.slug}/threads/${threadId}${panel ? `?panel=${panel}` : ""}`);

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Project Bots</div>
        <div className="page-subtitle">Internal planners for your projects. Each Bot uses the project’s own threads, knowledge, permissions, and workspace.</div>
      </div>
      <div role="note" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 12, marginBottom: 16, color: "var(--text2)", fontSize: 12.5 }}>
        Project Bots use the same planner and worker system as the Space Assistant, scoped to one project. Customer-facing channel handlers are separate extensions and never open these internal threads.
      </div>

      {!loading && !loadError && reviewSignals.length > 0 && (
        <section aria-labelledby="portfolio-review-title" className="settings-block" style={{ padding: 14, marginBottom: 16 }}>
          <div id="portfolio-review-title" style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Projects to review</div>
          <p style={{ margin: "0 0 10px", color: "var(--text3)", fontSize: 12 }}>
            These active projects have no recorded activity for at least 30 days. This is a review signal only; it does not pause Bots or extensions, archive projects, or delete data.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {reviewSignals.map((project) => (
              <Button key={project.id} variant="secondary" onClick={() => router.push(`/p/${product.slug}/projects/${project.id}`)}>
                Review {project.name}
              </Button>
            ))}
          </div>
        </section>
      )}

      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading project Bots…</p>
      ) : loadError ? (
        <div role="alert" style={{ display: "flex", alignItems: "center", gap: 12, color: "#dc2626", fontSize: 13 }}>
          <span>Couldn’t load project Bots or start that thread.</span>
          <Button variant="secondary" onClick={() => void refresh()}>Retry</Button>
        </div>
      ) : projects.length === 0 ? (
        <div className="settings-block" style={{ padding: 16 }}>
          <CardTitle>No projects yet</CardTitle>
          <CardDesc>Create a project to get a project-scoped Bot with its own internal threads and workspace.</CardDesc>
          <Button style={{ marginTop: 12 }} onClick={() => router.push(`/p/${product.slug}/projects/all`)}>Create a project</Button>
        </div>
      ) : (
        <div className="grid-3">
          {projects.map((project) => {
            const planner = project.default_agent_id ? agentById.get(project.default_agent_id) : undefined;
            const latestThread = latestThreadByProject.get(project.id);
            const projectJobs = scheduledJobs.filter((job) => job.project_id === project.id);
            const nextRoutine = projectJobs
              .filter((job) => job.enabled && job.next_run_at != null)
              .sort((a, b) => a.next_run_at! - b.next_run_at!)[0];
            const isCreating = creatingProjectId === project.id;
            return (
              <Card key={project.id}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <div>
                    <CardTitle>{project.name}</CardTitle>
                    <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 3 }}>Internal Project Bot · Project scoped</div>
                  </div>
                  <span className="badge badge-blue">Planner</span>
                </div>
                <CardDesc>{planner?.name ?? "Project Bot"}{project.description ? ` · ${project.description}` : ""}</CardDesc>
                <div style={{ minHeight: 34, fontSize: 11.5, color: "var(--text3)", margin: "10px 0" }}>
                  {latestThread ? `Last thread activity ${relativeTime(latestThread.updated_at)}` : "No project threads yet"}
                </div>
                <div style={{ minHeight: 30, fontSize: 11.5, color: "var(--text3)", marginBottom: 10 }}>
                  {nextRoutine
                    ? `Next routine: ${nextRoutine.name} · ${relativeTime(new Date(nextRoutine.next_run_at!).toISOString())}`
                    : projectJobs.length > 0
                      ? `${projectJobs.length} routine${projectJobs.length === 1 ? "" : "s"} paused`
                      : "No proactive routine set"}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {latestThread && <Button variant="secondary" onClick={() => openThread(latestThread.id)}>Continue</Button>}
                  <Button variant="secondary" disabled={creatingProjectId !== null} onClick={() => latestThread ? openThread(latestThread.id, "crons") : void startThread(project, "crons")}>Routines</Button>
                  <Button disabled={creatingProjectId !== null} onClick={() => void startThread(project)}>
                    {isCreating ? "Opening…" : latestThread ? "New thread" : "Talk to Project Bot"}
                  </Button>
                  <Button variant="ghost" onClick={() => router.push(`/p/${product.slug}/projects/${project.id}`)}>Project settings</Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
