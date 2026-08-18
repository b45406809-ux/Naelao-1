"use client";

export const runtime = "edge";

// The agent library for whichever space is currently active.
//
// Two things were wrong here before: it listed `product.space_id` — the product ROOT — so someone
// inside a business saw a different space's agents (or none), and it declared configuring an agent
// "a builder capability", which stopped being true once the per-agent policy routes gained a
// business-membership floor. Each card now opens that agent's own settings page.
//
// Naelao Agent Templates: instead of every project agent being the same generic identity with
// different config bolted on by hand, a real, distinct configuration (tool list, autonomy,
// vertical instructions) can be instantiated here directly — created space-wide (not bound to any
// one project yet), so it immediately shows up as a choice in every project's "Default agent"
// picker and can be added to a project's own switcher from that project's own page.

import * as React from "react";
import Link from "next/link";
import { Card, CardTitle, CardDesc, Button, Modal } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { useToast, Toast } from "@naelao/ui";
import {
  listAgentDefinitions,
  listAgentTemplates,
  instantiateAgentTemplate,
  listProjects,
  type Project,
  type AgentDefinitionSummary,
  type AgentTemplateSummary,
} from "@/lib/api";

export default function AgentsPage() {
  const product = useProduct();
  const { session } = useProductAuth();
  const { activeSpaceId, activeSpaceName, isBusinessSpace } = useActiveSpace();
  const { toast, show } = useToast();
  const [agents, setAgents] = React.useState<AgentDefinitionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  const [templatePickerOpen, setTemplatePickerOpen] = React.useState(false);
  const [templates, setTemplates] = React.useState<AgentTemplateSummary[]>([]);
  const [templatesLoading, setTemplatesLoading] = React.useState(false);
  const [instantiating, setInstantiating] = React.useState(false);
  // Step 16: after a template is chosen, pick which project to add it to before instantiating.
  const [pendingTemplate, setPendingTemplate] = React.useState<AgentTemplateSummary | null>(null);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = React.useState(false);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(() => {
    if (!creds) return;
    setLoading(true);
    setFailed(false);
    listAgentDefinitions(activeSpaceId, creds)
      .then((a) => setAgents(a))
      // A load failure must never render as "you have no agents" — that reads as a fact about the
      // business rather than a fact about this request.
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, session]);

  React.useEffect(() => { refresh(); }, [refresh]);

  async function openTemplatePicker() {
    setTemplatePickerOpen(true);
    if (templates.length > 0 || !creds) return;
    setTemplatesLoading(true);
    try {
      setTemplates(await listAgentTemplates(activeSpaceId, creds));
    } catch {
      show("Couldn't load agent templates");
    } finally {
      setTemplatesLoading(false);
    }
  }

  // Step 16: choosing a template no longer instantiates immediately — it opens a project picker
  // so the agent is added to a project the user chooses (or the assistant/space-wide).
  async function handleAddFromTemplate(t: AgentTemplateSummary) {
    if (!creds || instantiating) return;
    setPendingTemplate(t);
    setTemplatePickerOpen(false);
    setProjectsLoading(true);
    try {
      setProjects(await listProjects(activeSpaceId, creds));
    } catch {
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }

  async function confirmAddToProject(projectId?: string) {
    if (!creds || !pendingTemplate || instantiating) return;
    const t = pendingTemplate;
    setInstantiating(true);
    try {
      await instantiateAgentTemplate(activeSpaceId, creds, {
        template_id: t.id,
        ...(projectId ? { project_id: projectId } : {}),
      });
      setPendingTemplate(null);
      show(projectId ? `${t.name} added to that project` : `${t.name} added`);
      refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't add this agent");
    } finally {
      setInstantiating(false);
    }
  }

  return (
    <div className="page-view">
      <div className="page-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div className="page-title">Agents</div>
          <div className="page-subtitle">
            The specialists working in {isBusinessSpace && activeSpaceName ? activeSpaceName : product.product_name},
            alongside your assistant. Open one to set what it may do on its own.
          </div>
        </div>
        <Button onClick={() => void openTemplatePicker()}>+ Add from template</Button>
      </div>

      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : failed ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          Couldn&apos;t load the agent list just now.{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.location.reload()}>
            Try again
          </button>
        </p>
      ) : agents.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          No specialist agents here yet. Add one from a Naelao Agent Template above, or they arrive
          with the templates you add to a business — your assistant works on its own until then.
        </p>
      ) : (
        <div className="grid-3">
          {agents.map((a) => (
            <Link key={a.id} href={`/p/${product.slug}/agents/${encodeURIComponent(a.id)}`} style={{ textDecoration: "none" }}>
              <Card>
                <CardTitle>{a.name ?? a.id}</CardTitle>
                {a.description && <CardDesc>{a.description}</CardDesc>}
                <div style={{ marginTop: 10, fontSize: 12, color: "var(--accent)" }}>Configure →</div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Modal open={templatePickerOpen} onClose={() => setTemplatePickerOpen(false)} title="Naelao Agent Templates">
        <p style={{ fontSize: 12.5, color: "var(--text3)", margin: "0 0 12px" }}>
          Each template is a real, distinct configuration — its own tool list, autonomy default,
          and vertical instructions — not a label on the same generic agent.
        </p>
        {templatesLoading ? (
          <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
        ) : (
          <div className="app-grid">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                className="card app-card"
                disabled={instantiating}
                onClick={() => void handleAddFromTemplate(t)}
                style={{ textAlign: "left", cursor: instantiating ? "default" : "pointer", font: "inherit" }}
              >
                <CardTitle>{t.name}</CardTitle>
                <CardDesc>{t.description}</CardDesc>
                <span className="app-card-tag">{t.category}</span>
              </button>
            ))}
          </div>
        )}
      </Modal>
      {/* Step 16: pick which project to add the chosen template agent to. */}
      <Modal open={pendingTemplate !== null} onClose={() => setPendingTemplate(null)} title={pendingTemplate ? `Add "${pendingTemplate.name}" to…` : "Add to project"}>
        <p style={{ fontSize: 12.5, color: "var(--text3)", margin: "0 0 12px" }}>
          Choose which project this agent works in. It gets that project&apos;s workspace, journal and threads.
        </p>
        {projectsLoading ? (
          <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading projects…</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className="settings-row"
                disabled={instantiating}
                onClick={() => void confirmAddToProject(p.id)}
                style={{ textAlign: "left", cursor: instantiating ? "default" : "pointer", font: "inherit", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "transparent" }}
              >
                {p.name}
              </button>
            ))}
            <button
              type="button"
              className="settings-row"
              disabled={instantiating}
              onClick={() => void confirmAddToProject(undefined)}
              style={{ textAlign: "left", cursor: instantiating ? "default" : "pointer", font: "inherit", border: "1px dashed var(--border)", borderRadius: 8, padding: "10px 12px", background: "transparent", color: "var(--text3)" }}
            >
              Add without a project (space-wide / assistant)
            </button>
          </div>
        )}
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}
