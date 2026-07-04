"use client";

import * as React from "react";
import Link from "next/link";
import { Button, Card, CardTitle, CardDesc, CardMeta, Modal, FormInput, FormTextarea, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { listProjects, createProject, type Project } from "@/lib/api";

export default function ProjectsPage() {
  const product = useProduct();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      setProjects(await listProjects(product.space_id, creds));
    } catch {
      show("Couldn't load projects");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.space_id, session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!creds || !name.trim()) return;
    setCreating(true);
    try {
      await createProject(product.space_id, creds, name.trim(), description.trim() || undefined);
      setModalOpen(false);
      setName("");
      setDescription("");
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
          <div className="page-title">Projects</div>
          <div className="page-subtitle">Workspaces your agents access through threads.</div>
        </div>
        <Button onClick={() => setModalOpen(true)}>New Project</Button>
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
        title="New Project"
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)} type="button">
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <FormInput placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          <FormTextarea placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </form>
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}
