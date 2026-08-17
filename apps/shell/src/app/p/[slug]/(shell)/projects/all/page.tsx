"use client";

export const runtime = "edge";

// The full project list (moved off /projects, which now redirects straight into the business's
// default General project — see /projects/page.tsx). "New Project" opens a template grid first,
// matching how creating a business already works: pick a real preset (kind, execution ceiling,
// spend cap, agent binding and starter rules all set up in one call) or start blank.

import * as React from "react";
import Link from "next/link";
import { Button, Card, CardTitle, CardDesc, CardMeta, Modal, FormInput, FormTextarea, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  listProjects,
  createProject,
  createProjectFromTemplate,
  getShellManifest,
  getFeatureKinds,
  type Project,
  type FeatureKind,
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
  // The "plugins directory" — native business-feature projects (Wallet, CRM, Business Email, …)
  // this business could add, already role-filtered server-side by the caller's real business
  // role. A singleton kind already present as an active project is filtered out client-side too
  // (not just left to the server's own 409) so the grid never offers a doomed create attempt.
  const [featureKinds, setFeatureKinds] = React.useState<FeatureKind[]>([]);
  const [loading, setLoading] = React.useState(true);

  // Two-step dialog: pick a template/plugin (or "Blank") first, then — only for Blank — name it.
  const [modalOpen, setModalOpen] = React.useState(false);
  const [pickedTemplate, setPickedTemplate] = React.useState<ProjectTemplate | "blank" | null>(null);
  const [pickedKind, setPickedKind] = React.useState<FeatureKind | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      const [projectList, manifest, kinds] = await Promise.all([
        listProjects(activeSpaceId, creds),
        getShellManifest(activeSpaceId, creds).catch(() => null),
        getFeatureKinds(activeSpaceId, creds).catch(() => []),
      ]);
      setProjects(projectList);
      setTemplates(manifest?.project_template_catalog ?? []);
      const activeSingletonKinds = new Set(projectList.filter((p) => p.status !== "archived").map((p) => p.kind));
      setFeatureKinds(kinds.filter((k) => !k.singleton || !activeSingletonKinds.has(k.kind)));
    } catch {
      show("Couldn't load projects");
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
    setPickedKind(null);
    setName("");
    setDescription("");
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

  function pickKind(k: FeatureKind) {
    setPickedKind(k);
    setPickedTemplate(null);
    setName(k.label);
    setDescription(k.description);
  }

  // Handles both the "Blank project" step and a picked plugin/feature-kind step — both just need
  // a name (and, for a feature kind, that kind on the create call).
  async function handleCreateNamed(e: React.FormEvent) {
    e.preventDefault();
    if (!creds || !name.trim()) return;
    setCreating(true);
    try {
      await createProject(activeSpaceId, creds, name.trim(), description.trim() || undefined, pickedKind?.kind);
      setModalOpen(false);
      if (pickedKind) show(`"${name.trim()}" added.`);
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
        <Button onClick={openModal}>New Project</Button>
      </div>

      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
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
        title={pickedTemplate === "blank" ? "Blank project" : pickedKind ? pickedKind.label : "New Project"}
        footer={
          pickedTemplate === "blank" || pickedKind ? (
            <>
              <Button variant="secondary" type="button" onClick={() => { setPickedTemplate(null); setPickedKind(null); }}>
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
        {pickedTemplate === "blank" || pickedKind ? (
          <form onSubmit={handleCreateNamed} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FormInput placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            <FormTextarea placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </form>
        ) : (
          <div>
            <p style={{ fontSize: 12.5, color: "var(--text3)", margin: "0 0 12px" }}>
              A template sets up the project's kind, spend limits and agent in one step. Or start blank.
            </p>
            <div className="app-grid">
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

            {featureKinds.length > 0 && (
              <>
                <p style={{ fontSize: 12.5, color: "var(--text3)", margin: "16px 0 12px" }}>
                  Plugins — native business infrastructure (a wallet, a CRM, a shared inbox…) as its
                  own project, with its own thread and access control.
                </p>
                <div className="app-grid">
                  {featureKinds.map((k) => (
                    <button
                      key={k.kind}
                      type="button"
                      className="card app-card"
                      disabled={creating}
                      onClick={() => pickKind(k)}
                      style={{ textAlign: "left", cursor: creating ? "default" : "pointer", font: "inherit" }}
                    >
                      <div className="app-card-header">
                        <div className="app-card-initial">{k.label.slice(0, 1)}</div>
                        <CardTitle>{k.label}</CardTitle>
                      </div>
                      <div className="app-card-desc card-desc">{k.description}</div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}
