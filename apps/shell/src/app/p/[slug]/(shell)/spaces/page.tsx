"use client";

export const runtime = "edge";

// Discover — the hub for everything that isn't a conversation: the businesses you run, the
// business templates you could start next, and what those templates actually give you (the
// project presets and the agents that run them).
//
// Renamed from the old "Spaces" list, which showed the product root as a card alongside your
// businesses. In business-first (hybrid/tenant) mode the product root is not a workspace at all —
// listing it as one invited people to click into an empty, permanently-childless space.

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Badge, Card, CardTitle, CardDesc, Modal, FormInput, Toggle, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { getShellManifest, listMyBusinesses, createBusiness, type ShellManifest, type Business } from "@/lib/api";

// Phase F (§A1.17): a sentinel selection meaning "no template — the assistant helps build this
// business from scratch," distinct from an empty Set (which used to mean the same thing but
// wasn't a labeled choice). Never sent to the backend as a template id.
const CUSTOM_BUSINESS = "__custom__";

export default function DiscoverPage() {
  const product = useProduct();
  const router = useRouter();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const [manifest, setManifest] = React.useState<ShellManifest | null>(null);
  const [businesses, setBusinesses] = React.useState<Business[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [selectedTemplates, setSelectedTemplates] = React.useState<Set<string>>(new Set());
  const [creating, setCreating] = React.useState(false);
  // A rejection here (e.g. plan_upgrade_required for a paid-only template) previously surfaced
  // ONLY as a 2.8s auto-dismissing toast, easy to miss — leaving the dialog looking like it just
  // silently did nothing. Keeping the message here too makes it stick until the user retries or
  // closes the dialog.
  const [createError, setCreateError] = React.useState<string | null>(null);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      const [m, b] = await Promise.all([getShellManifest(product.space_id, creds), listMyBusinesses(product.space_id, creds)]);
      setManifest(m);
      setBusinesses(b);
    } catch {
      show("Couldn't load Discover");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.space_id, session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  function toggleTemplate(id: string) {
    setSelectedTemplates((prev) => {
      // Selecting Custom clears any real templates (and vice versa) — they're mutually exclusive:
      // Custom means "no template at all," so mixing it with a real one is meaningless.
      if (id === CUSTOM_BUSINESS) return prev.has(CUSTOM_BUSINESS) ? new Set() : new Set([CUSTOM_BUSINESS]);
      const next = new Set(prev);
      next.delete(CUSTOM_BUSINESS);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openCreate(templateId?: string) {
    setSelectedTemplates(templateId ? new Set([templateId]) : new Set());
    setCreateError(null);
    setModalOpen(true);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!creds || !name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const allowed = manifest?.allowed_child_space_types ?? ["launchpad"];
      const templateIds = Array.from(selectedTemplates).filter((id) => id !== CUSTOM_BUSINESS);
      const created = await createBusiness(product.space_id, creds, {
        name: name.trim(),
        spacetype_id: allowed[0] ?? "launchpad",
        template_ids: templateIds,
      });
      setModalOpen(false);
      setName("");
      setSelectedTemplates(new Set());
      // Straight into setup rather than back to a list. A business that's been created but never
      // configured does nothing at all — its assistant has no account to read and no way to reach
      // its owner — so dropping someone on a card that says "active" would be misleading.
      router.push(`/p/${product.slug}/spaces/${created.space_id}/onboarding`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create business";
      setCreateError(message);
      show(message);
    } finally {
      setCreating(false);
    }
  }

  function closeModal() {
    setModalOpen(false);
    setCreateError(null);
  }

  const canCreate = manifest?.membership_model === "tenant" || manifest?.membership_model === "hybrid";
  // Phase F: render from the real, coming_soon-aware catalog (shell/manifest's template_catalog,
  // already intersected server-side with the builder's business_templates narrowing) instead of a
  // hardcoded duplicate of LAUNCHPAD_TEMPLATES.
  const availableTemplates = manifest?.template_catalog ?? [];
  const projectTemplates = manifest?.project_template_catalog ?? [];
  const agentCatalog = manifest?.agent_catalog ?? [];
  // Set by the shell layout's business-first redirect (layout.tsx) when a hybrid/tenant user has
  // zero businesses and tried to reach a workspace page (Home, Projects, ...) that only makes
  // sense inside one — explains why they landed here instead of where they clicked.
  const firstRun = useSearchParams().get("onboarding") === "1" && !loading && businesses.length === 0;

  return (
    <div className="page-view">
      {firstRun && (
        <div
          style={{
            padding: "12px 16px",
            marginBottom: 16,
            borderRadius: 10,
            background: "var(--accent-soft, #eef2ff)",
            border: "1px solid var(--accent, #5b52f0)",
            fontSize: 13,
          }}
        >
          Start your first business below — everything (chat, projects, agents) lives inside a
          business, so there&rsquo;s nothing to do until you have one.
        </div>
      )}

      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="page-title">Discover</div>
          <div className="page-subtitle">Your businesses, and what you could start next.</div>
        </div>
        {canCreate && <Button onClick={() => openCreate()}>New business</Button>}
      </div>

      <div className="section-label">Your businesses</div>
      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : businesses.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          {canCreate
            ? "Nothing here yet — pick a template below and your assistant takes it from there."
            : "This product doesn't support customer-created businesses."}
        </p>
      ) : (
        <div className="grid-3">
          {businesses.map((b) => (
            <Link key={b.id} href={`/p/${product.slug}/spaces/${b.id}`} style={{ textDecoration: "none" }}>
              <Card>
                <CardTitle>{b.name}</CardTitle>
                <CardDesc>Your role: {b.role}</CardDesc>
                <Badge color={b.space_status === "active" ? "green" : "amber"}>{b.space_status}</Badge>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {canCreate && availableTemplates.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 26 }}>
            Start a business
          </div>
          <div className="grid-3">
            {availableTemplates.map((t) => (
              <Card
                key={t.id}
                interactive={!t.coming_soon}
                onClick={t.coming_soon ? undefined : () => openCreate(t.id)}
                style={t.coming_soon ? { opacity: 0.55, cursor: "default" } : { cursor: "pointer" }}
              >
                <CardTitle>{t.name}</CardTitle>
                <CardDesc>
                  {t.coming_soon
                    ? "Not available yet."
                    : "Preconfigured workspaces, agents and setup — ready to run."}
                </CardDesc>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {t.coming_soon && <Badge color="amber">Coming soon</Badge>}
                  {/* The backend rejects a non-free_tier_eligible template on the free plan, so
                      say it here rather than after a failed click. */}
                  {!t.coming_soon && !t.free_tier_eligible && <Badge color="amber">Requires plan upgrade</Badge>}
                </div>
              </Card>
            ))}
            <Card interactive onClick={() => openCreate(CUSTOM_BUSINESS)} style={{ cursor: "pointer" }}>
              <CardTitle>Custom</CardTitle>
              <CardDesc>Start from scratch — your assistant helps you design and set it up.</CardDesc>
            </Card>
          </div>
        </>
      )}

      {/* Informational, not actionable from here: project presets apply to a project INSIDE a
          business, and agents are installed per business. Showing them answers "what do I
          actually get?" before someone commits to creating one. */}
      {projectTemplates.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 26 }}>
            Project templates
          </div>
          <div className="grid-3">
            {projectTemplates.map((t) => (
              <Card key={t.id} interactive={false}>
                <CardTitle>{t.name}</CardTitle>
                <CardDesc>{t.description}</CardDesc>
                <Badge color="blue">{t.kind.replace(/_/g, " ")}</Badge>
              </Card>
            ))}
          </div>
          <p style={{ fontSize: 12, color: "var(--text3)", marginTop: 8 }}>
            Add these to a project inside one of your businesses — your assistant can set one up for
            you when you ask.
          </p>
        </>
      )}

      {agentCatalog.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 26 }}>
            Agents
          </div>
          <div className="grid-3">
            {agentCatalog.map((a) => (
              <Card key={a.id} interactive={false}>
                <CardTitle>{a.name}</CardTitle>
                <CardDesc>{a.description}</CardDesc>
              </Card>
            ))}
          </div>
          <p style={{ fontSize: 12, color: "var(--text3)", marginTop: 8 }}>
            Installed automatically by the template you choose — you never wire them up yourself.
          </p>
        </>
      )}

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title="Start a business"
        footer={
          <>
            <Button variant="secondary" type="button" onClick={closeModal}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <FormInput placeholder="What's it called?" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          <div className="section-label" style={{ marginTop: 8 }}>
            Template
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
            <Toggle on={selectedTemplates.has(CUSTOM_BUSINESS)} onChange={() => toggleTemplate(CUSTOM_BUSINESS)} label="Custom" />
            Custom — build from scratch with the assistant
          </label>
          {availableTemplates.map((t) =>
            t.coming_soon ? (
              <label key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, opacity: 0.5 }}>
                <Toggle on={false} onChange={() => {}} disabled label={t.name} />
                {t.name}
                <Badge color="amber">Coming soon</Badge>
              </label>
            ) : (
              <label key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                <Toggle on={selectedTemplates.has(t.id)} onChange={() => toggleTemplate(t.id)} label={t.name} />
                {t.name}
                {!t.free_tier_eligible && <Badge color="amber">Requires plan upgrade</Badge>}
              </label>
            )
          )}
          {selectedTemplates.has(CUSTOM_BUSINESS) && (
            <p style={{ fontSize: 12, color: "var(--text3)" }}>The assistant will help you design and set up this business.</p>
          )}
          {createError && (
            <p style={{ fontSize: 12, color: "#dc2626" }} role="alert">
              {createError}
            </p>
          )}
        </form>
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}
