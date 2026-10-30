"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { listDepartmentProjects, listDepartments, type DepartmentOption, type Project } from "@/lib/api";

export default function DepartmentProjectsPage() {
  const params = useParams<{ spaceId: string; departmentId: string }>();
  const product = useProduct();
  const { session } = useProductAuth();
  const { activeSpaceId, setActiveSpace } = useActiveSpace();
  const [department, setDepartment] = React.useState<DepartmentOption | null>(null);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const creds = React.useMemo(() => session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null,
    [session?.session_token, session?.end_user_id]);

  React.useEffect(() => {
    if (!creds) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDepartment(null);
    setProjects([]);
    if (activeSpaceId !== params.spaceId) setActiveSpace(params.spaceId);
    Promise.all([
      listDepartments(params.spaceId, creds),
      listDepartmentProjects(params.spaceId, params.departmentId, creds),
    ]).then(([departments, items]) => {
      if (cancelled) return;
      const selected = departments.find((item) => item.id === params.departmentId && item.parent_id === params.spaceId);
      if (!selected) throw new Error("Department not found in this space");
      setDepartment(selected);
      setProjects(items);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Couldn't load this department");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [activeSpaceId, params.spaceId, params.departmentId, creds, setActiveSpace]);

  if (loading) return <div className="page-view">Loading department…</div>;
  if (error || !department) return <main className="page-view"><h1>Department unavailable</h1><output>{error ?? "This department is unavailable."}</output></main>;

  return (
    <main className="page-view">
      <nav aria-label="Breadcrumb" style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--text3)", fontSize: 12, marginBottom: 16 }}>
        <Link href={`/p/${product.slug}/spaces/${params.spaceId}`} style={{ color: "var(--text2)" }}>Space</Link>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{department.name}</span>
      </nav>
      <header className="page-header">
        <h1 className="page-title">{department.name}</h1>
        <p className="page-subtitle">Projects associated with this department</p>
      </header>
      {projects.length === 0 ? (
        <p style={{ color: "var(--text3)" }}>No projects are linked to this department yet.</p>
      ) : (
        <div className="grid-2">
          {projects.map((project) => (
            <Link key={project.id} href={`/p/${product.slug}/projects/${encodeURIComponent(project.id)}?departmentId=${encodeURIComponent(department.id)}`} className="card" style={{ textDecoration: "none" }}>
              <div className="card-title">{project.name}</div>
              {project.description && <div className="card-desc">{project.description}</div>}
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
