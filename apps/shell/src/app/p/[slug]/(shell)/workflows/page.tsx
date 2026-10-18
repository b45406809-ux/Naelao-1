"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useSessionCredentials } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { listProjects, type Project } from "@/lib/api";
import { AssistantSidePanelBody } from "@/components/AssistantSidePanels";
import { WorkflowPlanComposer } from "@/components/WorkflowPlanComposer";

export default function WorkflowsPage() {
  const product = useProduct();
  const { activeSpaceId } = useActiveSpace();
  const session = useSessionCredentials();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [projectId, setProjectId] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    if (!session) return;
    let live = true;
    setLoading(true); setError(null); setProjects([]); setProjectId("");
    listProjects(activeSpaceId, session).then(items => {
      if (!live) return;
      const active = items.filter(p => p.status !== "archived");
      setProjects(active); setProjectId(active[0]?.id ?? "");
    }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : "Couldn't load projects."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [activeSpaceId, session, retry]);
  const selected = projects.find(p => p.id === projectId);
  return <div className="page-view">
    <div className="page-header"><h1 className="page-title">Workflows</h1><p className="page-subtitle">Build workflows and schedule recurring work for each project’s internal planner. External channel conversations are handled by installed project extensions.</p></div>
    {loading ? <p role="status">Loading projects…</p> : error ? <div role="alert"><p>{error}</p><Button onClick={() => setRetry(value => value + 1)}>Retry</Button></div> : !projects.length ? <div className="card"><h2>Create a project to automate your work</h2><p>Each workflow belongs to a project, with its own files and access permissions.</p><Link href={`/p/${product.slug}/projects/all`}>Choose a project template</Link></div> : <>
      <label htmlFor="workflow-project">Project</label>
      <select id="workflow-project" className="form-input" value={projectId} onChange={event => setProjectId(event.target.value)} style={{ margin: "8px 0 24px", maxWidth: 480 }}>
        {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      {selected && session && <div key={`${activeSpaceId}:${selected.id}`} className="card" style={{ cursor: "default" }}>
        <WorkflowPlanComposer spaceId={activeSpaceId} projectId={selected.id} session={session} />
        <AssistantSidePanelBody tab="crons" spaceId={activeSpaceId} projectId={selected.id} session={session} isBusinessSpace={activeSpaceId !== product.space_id} />
      </div>}
    </>}
  </div>;
}
