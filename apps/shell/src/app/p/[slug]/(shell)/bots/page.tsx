"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardDesc, CardTitle } from "@naelao/ui";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProduct } from "@/lib/product-context";
import { useSessionCredentials } from "@/lib/auth-provider";
import { createThread, listAgentDefinitions, listProjects, listThreads, type AgentDefinitionSummary, type Project, type ThreadSummary } from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";

export default function ProjectBotsPage() {
  const product = useProduct();
  const { activeSpaceId } = useActiveSpace();
  const session = useSessionCredentials();
  const router = useRouter();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [agents, setAgents] = React.useState<AgentDefinitionSummary[]>([]);
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
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
    try {
      const [nextProjects, nextAgents, nextThreads] = await Promise.all([
        listProjects(activeSpaceId, session),
        listAgentDefinitions(activeSpaceId, session),
        listThreads(activeSpaceId, session),
      ]);
      setProjects(nextProjects.filter((project) => project.status === "active"));
      setAgents(nextAgents);
      setThreads(nextThreads.filter((thread) => thread.project_id && !thread.parent_thread_id && thread.thread_kind === "primary"));
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

  async function startThread(project: Project) {
    if (!session || creatingProjectId) return;
    setCreatingProjectId(project.id);
    try {
      const thread = await createThread(activeSpaceId, session, { project_id: project.id, title: "Project Bot" });
      router.push(`/p/${product.slug}/threads/${thread.id}`);
    } catch {
      setLoadError(true);
      setCreatingProjectId(null);
    }
  }

  const openThread = (threadId: string) => router.push(`/p/${product.slug}/threads/${threadId}`);

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Project Bots</div>
        <div className="page-subtitle">Internal planners for your projects. Each Bot uses the project’s own threads, knowledge, permissions, and workspace.</div>
      </div>
      <div role="note" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 12, marginBottom: 16, color: "var(--text2)", fontSize: 12.5 }}>
        Project Bots use the same planner and worker system as the Space Assistant, scoped to one project. Customer-facing channel handlers are separate extensions and never open these internal threads.
      </div>

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
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {latestThread && <Button variant="secondary" onClick={() => openThread(latestThread.id)}>Continue</Button>}
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
