"use client";

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
  listArchetypes,
  getSkillsDirectory,
  getConnectorStatus,
  type Project,
  type AgentDefinitionSummary,
  type AgentTemplateSummary,
  type AssistantCapabilities,
  type ArchetypePreset,
  type DirectorySkill,
  type ConnectorInfo,
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
  const [skillDirectory, setSkillDirectory] = React.useState<DirectorySkill[]>([]);
  const [connectorDirectory, setConnectorDirectory] = React.useState<ConnectorInfo[]>([]);
  const [cSkills, setCSkills] = React.useState<Set<string>>(new Set());
  const [cConnectors, setCConnectors] = React.useState<Set<string>>(new Set());
  const [cMode, setCMode] = React.useState<"always_ask" | "gate_unless_listed" | "yolo">("gate_unless_listed");
  const [cProject, setCProject] = React.useState<string>("");
  const [creating, setCreating] = React.useState(false);
  // AVOS plan step 5 — an optional capability-firewall archetype. Empty = unrestricted (the
  // tools checked above are used verbatim), matching the backend's own opt-in default.
  const [archetypes, setArchetypes] = React.useState<ArchetypePreset[]>([]);
  const [cArchetype, setCArchetype] = React.useState<string>("");

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
    // AVOS plan step 5 — best-effort; an empty list just means the archetype picker offers only
    // "No restriction", which is the same behavior this had before archetypes existed.
    if (archetypes.length === 0) listArchetypes(activeSpaceId, creds).then(setArchetypes).catch(() => setArchetypes([]));
    if (skillDirectory.length === 0) getSkillsDirectory(activeSpaceId, creds).then((directory) => setSkillDirectory(directory?.skills ?? [])).catch(() => setSkillDirectory([]));
    if (connectorDirectory.length === 0) getConnectorStatus(activeSpaceId, creds).then(setConnectorDirectory).catch(() => setConnectorDirectory([]));
  }

  async function submitCustomAgent() {
    if (!creds || creating) return;
    if (!cName.trim() || !cInstr.trim()) { show("Name and instructions are required"); return; }
    setCreating(true);
    try {
      const created = await createCustomAgent(activeSpaceId, creds, {
        name: cName.trim(),
        ...(cDesc.trim() ? { description: cDesc.trim() } : {}),
        instructions: cInstr.trim(),
        prebuilt_scripts: [...cTools],
        skills: [...cSkills],
        connectors: [...cConnectors],
        approval_mode: cMode,
        ...(cProject ? { project_id: cProject } : {}),
        // AVOS plan step 5 — the archetype, when one is chosen, clamps the tool list above to what
        // that role is allowed. Omitted entirely when unset, so an unrestricted custom agent is
        // still the default and existing behavior is unchanged.
        ...(cArchetype ? { archetype: cArchetype } : {}),
      });
      setCustomOpen(false);
      setCName(""); setCDesc(""); setCInstr(""); setCProject(""); setCArchetype("");
      setCTools(new Set()); setCSkills(new Set()); setCConnectors(new Set());
      // The archetype may have silently dropped some of the tools that were checked — say so,
      // rather than letting the agent later look like it "can't do what it was configured to do"
      // with no explanation anywhere.
      show(
        created.rejected_scripts && created.rejected_scripts.length > 0
          ? `${cName.trim()} created — its archetype doesn't allow: ${created.rejected_scripts.join(", ")}`
          : `${cName.trim()} created`
      );
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
          <div className="page-title">Workers</div>
          <div className="page-subtitle">
            The specialist workers in {isBusinessSpace && activeSpaceName ? activeSpaceName : product.product_name},
            alongside your assistant. Open one to set what it may do on its own.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" onClick={() => void openCustomBuilder()}>+ Create custom worker</Button>
          <Button onClick={() => void openTemplatePicker()}>+ Add worker</Button>
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
          No specialist workers here yet. Add one from the worker directory above, or they arrive
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

      <Modal open={templatePickerOpen} onClose={() => setTemplatePickerOpen(false)} title="Worker directory">
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
      <Modal open={customOpen} onClose={() => setCustomOpen(false)} title="Create a custom worker">
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
          <div style={{ fontSize: 12.5 }}>
            <div style={{ color: "var(--text3)", marginBottom: 6 }}>Skills directory</div>
            <div className="workspace-directory-grid" style={{ maxHeight: 210, overflowY: "auto" }}>
              {skillDirectory.length === 0 ? <span style={{ color: "var(--text3)", fontSize: 12 }}>No installable skills are available yet.</span> : skillDirectory.map((skill) => <label key={skill.name} className="workspace-directory-card" style={{ minHeight: 0, cursor: "pointer" }}><span><input type="checkbox" checked={cSkills.has(skill.name)} onChange={(event) => setCSkills((current) => { const next = new Set(current); event.target.checked ? next.add(skill.name) : next.delete(skill.name); return next; })} /> <strong>{skill.name}</strong></span><p>{skill.description}</p></label>)}
            </div>
          </div>
          <div style={{ fontSize: 12.5 }}>
            <div style={{ color: "var(--text3)", marginBottom: 6 }}>Connected apps</div>
            <div className="workspace-directory-grid" style={{ maxHeight: 210, overflowY: "auto" }}>
              {connectorDirectory.length === 0 ? <span style={{ color: "var(--text3)", fontSize: 12 }}>No connected apps are available yet.</span> : connectorDirectory.map((connector) => <label key={connector.id} className="workspace-directory-card" style={{ minHeight: 0, cursor: "pointer", opacity: connector.connected ? 1 : .6 }}><span><input type="checkbox" disabled={!connector.connected} checked={cConnectors.has(connector.id)} onChange={(event) => setCConnectors((current) => { const next = new Set(current); event.target.checked ? next.add(connector.id) : next.delete(connector.id); return next; })} /> <strong>{connector.name}</strong></span><p>{connector.connected ? connector.category : "Connect this app first"}</p></label>)}
            </div>
          </div>
          <label style={{ fontSize: 12.5 }}>
            <div style={{ color: "var(--text3)", marginBottom: 4 }}>Archetype (optional)</div>
            <select value={cArchetype} onChange={(e) => setCArchetype(e.target.value)} style={inputStyle}>
              <option value="">No restriction — use exactly the tools checked above</option>
              {archetypes.map((a) => <option key={a.role} value={a.role}>{a.label}</option>)}
            </select>
            {cArchetype && (
              <div style={{ color: "var(--text3)", fontSize: 10.5, marginTop: 4 }}>
                {archetypes.find((a) => a.role === cArchetype)?.description}
                {" "}Anything checked above outside this role&apos;s allowed tools won&apos;t be granted.
              </div>
            )}
          </label>
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
              {creating ? "Creating…" : "Create worker"}
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
