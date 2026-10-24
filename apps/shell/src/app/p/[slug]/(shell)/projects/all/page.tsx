"use client";

// Projects are generic workspaces. The four kernel kinds select interaction layout; installed
// Space Templates/extensions supply domain behavior and project-specific setup.

import * as React from "react";
import Link from "next/link";
import { Button, Card, CardTitle, CardDesc, CardMeta, Modal, FormInput, FormTextarea, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { PROJECT_KINDS, type ProjectKind } from "@naelao/agent-sdk";
import {
  listProjects,
  createProject,
  createProjectFromTemplate,
  getShellManifest,
  type Project,
} from "@/lib/api";

interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  kind: string;
}

export default function ProjectsAllPage() {
  const product = useProduct();
  const { activeSpaceId } = useActiveSpace();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [templates, setTemplates] = React.useState<ProjectTemplate[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // Two-step dialog: pick a template/plugin (or "Blank") first, then — only for Blank — name it.
  const [modalOpen, setModalOpen] = React.useState(false);
  const [pickedTemplate, setPickedTemplate] = React.useState<ProjectTemplate | "blank" | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [projectKind, setProjectKind] = React.useState<ProjectKind>("DualPane");
  const [creating, setCreating] = React.useState(false);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [projectResult, manifestResult] = await Promise.allSettled([
        listProjects(activeSpaceId, creds),
        getShellManifest(activeSpaceId, creds),
      ]);

      // A product end-user can open the shell before joining a business. The catalog is still
      // useful in that state, while the business-scoped project list correctly returns 403.
      if (projectResult.status === "fulfilled") {
        setProjects(projectResult.value);
      } else {
        throw projectResult.reason;
      }

      const manifest = manifestResult.status === "fulfilled" ? manifestResult.value : null;
      const catalog = manifest?.project_template_catalog ?? [];
      setTemplates(catalog);

    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Couldn't load projects");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  function openModal() {
    setPickedTemplate(null);
    setName("");
    setDescription("");
    setProjectKind("DualPane");
    setModalOpen(true);
  }

  async function handleCreateFromTemplate(t: ProjectTemplate) {
    if (!creds) return;
    setCreating(true);
    try {
      await createProjectFromTemplate(activeSpaceId, creds, t.id);
      setModalOpen(false);
      show(`"${t.name}" is set up and ready.`);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateNamed(e: React.FormEvent) {
    e.preventDefault();
    if (!creds || !name.trim()) return;
    setCreating(true);
    try {
      await createProject(activeSpaceId, creds, name.trim(), description.trim() || undefined, projectKind);
      setModalOpen(false);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page-view">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="page-title">All Projects</div>
          <div className="page-subtitle">Workspaces your agents access through threads.</div>
        </div>
        <Button onClick={openModal} disabled={loading || !!loadError}>New Project</Button>
      </div>

      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : loadError ? (
        <div role="alert"><p>{loadError}</p><Button variant="secondary" onClick={() => void refresh()}>Retry</Button></div>
      ) : projects.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>No projects yet.</p>
      ) : (
        <div className="grid-3">
          {projects.map((p) => (
            <Link key={p.id} href={`/p/${product.slug}/projects/${p.id}`} style={{ textDecoration: "none" }}>
              <Card>
                <CardTitle>{p.name}</CardTitle>
                {p.description && <CardDesc>{p.description}</CardDesc>}
                <CardMeta>{p.max_threads > 0 ? `Up to ${p.max_threads} threads` : "Unlimited threads"}</CardMeta>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        width={760}
        title={pickedTemplate === "blank" ? "Blank project" : "New Project"}
        footer={
          pickedTemplate === "blank" ? (
            <>
              <Button variant="secondary" type="button" onClick={() => setPickedTemplate(null)}>
                Back
              </Button>
              <Button onClick={handleCreateNamed} disabled={creating || !name.trim()}>
                {creating ? "Creating…" : "Create"}
              </Button>
            </>
          ) : (
            <Button variant="secondary" type="button" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
          )
        }
      >
        {pickedTemplate === "blank" ? (
          <form onSubmit={handleCreateNamed} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FormInput aria-label="Project name" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            <FormTextarea placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text2)" }}>
              Project layout
              <select aria-label="Project layout" value={projectKind} onChange={(e) => setProjectKind(e.target.value as ProjectKind)}>
                {PROJECT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>
          </form>
        ) : (
          <div>
            <p style={{ fontSize: 12.5, color: "var(--text3)", margin: "0 0 12px" }}>
              A template sets up the project's kind, spend limits and agent in one step. Or start blank.
            </p>
            <div className="app-grid project-template-grid">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="card app-card"
                  disabled={creating}
                  onClick={() => void handleCreateFromTemplate(t)}
                  style={{ textAlign: "left", cursor: creating ? "default" : "pointer", font: "inherit" }}
                >
                  <div className="app-card-header">
                    <div className="app-card-initial">{t.name.slice(0, 1)}</div>
                    <CardTitle>{t.name}</CardTitle>
                  </div>
                  <div className="app-card-desc card-desc">{t.description}</div>
                  <span className="app-card-tag">{t.kind.replace(/_/g, " ")}</span>
                </button>
              ))}
              <button
                type="button"
                className="card app-card"
                disabled={creating}
                onClick={() => setPickedTemplate("blank")}
                style={{ textAlign: "left", cursor: creating ? "default" : "pointer", font: "inherit", borderStyle: "dashed" }}
              >
                <div className="app-card-header">
                  <div className="app-card-initial" style={{ background: "var(--surface2)", color: "var(--text3)" }}>+</div>
                  <CardTitle>Blank project</CardTitle>
                </div>
                <div className="app-card-desc card-desc">Start from scratch — name it and configure it yourself later.</div>
              </button>
            </div>


          </div>
        )}
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}
