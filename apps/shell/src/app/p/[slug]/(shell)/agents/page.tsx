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
  createCustomAgent,
  getAssistantCapabilities,
  listProjects,
  type Project,
  type AgentDefinitionSummary,
  type AgentTemplateSummary,
  type AssistantCapabilities,
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
  // Step 17: custom agent builder.
  const [customOpen, setCustomOpen] = React.useState(false);
  const [caps, setCaps] = React.useState<AssistantCapabilities | null>(null);
  const [cName, setCName] = React.useState("");
  const [cDesc, setCDesc] = React.useState("");
  const [cInstr, setCInstr] = React.useState("");
  const [cTools, setCTools] = React.useState<Set<string>>(new Set(["web-search", "knowledge-base", "code-exec", "project-journal"]));
  const [cMode, setCMode] = React.useState<"always_ask" | "gate_unless_listed" | "yolo">("gate_unless_listed");
  const [cProject, setCProject] = React.useState<string>("");
  const [creating, setCreating] = React.useState(false);

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

  async function openCustomBuilder() {
    if (!creds) return;
    setCustomOpen(true);
    if (!caps) getAssistantCapabilities(activeSpaceId, creds).then(setCaps).catch(() => setCaps({ prebuilts: [], skills: [], prebuilt_count: 0, skill_count: 0 }));
    if (projects.length === 0) listProjects(activeSpaceId, creds).then(setProjects).catch(() => {});
  }

  async function submitCustomAgent() {
    if (!creds || creating) return;
    if (!cName.trim() || !cInstr.trim()) { show("Name and instructions are required"); return; }
    setCreating(true);
    try {
      await createCustomAgent(activeSpaceId, creds, {
        name: cName.trim(),
        ...(cDesc.trim() ? { description: cDesc.trim() } : {}),
        instructions: cInstr.trim(),
        prebuilt_scripts: [...cTools],
        approval_mode: cMode,
        ...(cProject ? { project_id: cProject } : {}),
      });
      setCustomOpen(false);
      setCName(""); setCDesc(""); setCInstr(""); setCProject("");
      show(`${cName.trim()} created`);
      refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't create the agent");
    } finally {
      setCreating(false);
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
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" onClick={() => void openCustomBuilder()}>+ Create custom</Button>
          <Button onClick={() => void openTemplatePicker()}>+ Add from template</Button>
        </div>
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
      {/* Step 17: custom agent builder — instructions, tool list, autonomy, project. */}
      <Modal open={customOpen} onClose={() => setCustomOpen(false)} title="Create a custom agent">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 12.5 }}>
            <div style={{ color: "var(--text3)", marginBottom: 4 }}>Name</div>
            <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="e.g. SEO Writer" style={inputStyle} />
          </label>
          <label style={{ fontSize: 12.5 }}>
            <div style={{ color: "var(--text3)", marginBottom: 4 }}>Short description (optional)</div>
            <input value={cDesc} onChange={(e) => setCDesc(e.target.value)} placeholder="What it does, in a line" style={inputStyle} />
          </label>
          <label style={{ fontSize: 12.5 }}>
            <div style={{ color: "var(--text3)", marginBottom: 4 }}>Instructions</div>
            <textarea value={cInstr} onChange={(e) => setCInstr(e.target.value)} rows={5} placeholder="How this agent should behave, what it's for, any rules it must follow…" style={{ ...inputStyle, resize: "vertical" }} />
          </label>
          <div style={{ fontSize: 12.5 }}>
            <div style={{ color: "var(--text3)", marginBottom: 6 }}>Tools it can use</div>
            {caps === null ? (
              <div style={{ color: "var(--text3)", fontSize: 12 }}>Loading…</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, maxHeight: 180, overflowY: "auto" }}>
                {caps.prebuilts.map((p) => (
                  <label key={p.name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={cTools.has(p.name)}
                      onChange={(e) => setCTools((prev) => { const n = new Set(prev); if (e.target.checked) n.add(p.name); else n.delete(p.name); return n; })}
                    />
                    <span title={p.description}>{p.name}</span>
                  </label>
                ))}
              </div>
            )}
            <div style={{ color: "var(--text3)", fontSize: 10.5, marginTop: 4 }}>r2-workspace, memory and notifications are always included.</div>
          </div>
          <label style={{ fontSize: 12.5 }}>
            <div style={{ color: "var(--text3)", marginBottom: 4 }}>Autonomy</div>
            <select value={cMode} onChange={(e) => setCMode(e.target.value as typeof cMode)} style={inputStyle}>
              <option value="always_ask">Always ask before acting</option>
              <option value="gate_unless_listed">Ask for anything not pre-approved</option>
              <option value="yolo">Full autonomy (never ask)</option>
            </select>
          </label>
          <label style={{ fontSize: 12.5 }}>
            <div style={{ color: "var(--text3)", marginBottom: 4 }}>Project (optional)</div>
            <select value={cProject} onChange={(e) => setCProject(e.target.value)} style={inputStyle}>
              <option value="">No project (space-wide)</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button variant="secondary" onClick={() => setCustomOpen(false)}>Cancel</Button>
            <Button disabled={creating || !cName.trim() || !cInstr.trim()} onClick={() => void submitCustomAgent()}>
              {creating ? "Creating…" : "Create agent"}
            </Button>
          </div>
        </div>
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", fontSize: 13, borderRadius: 8,
  border: "1px solid var(--border)", background: "var(--surface1, var(--bg))", color: "var(--text1)",
};
