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
import { Button, Badge, Card, CardTitle, CardDesc, Modal, FormInput, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import {
  getShellManifest,
  listMyBusinesses,
  createBusiness,
  getTemplateActivity,
  type ShellManifest,
  type Business,
  type TemplateActivity,
} from "@/lib/api";
import { listModelBenchmarks, DEFAULT_WORKING_MODEL, type CostTier } from "@naelao/billing-core";
import { modelLabel } from "@/components/ModelSelector";

const COST_TIER_LABEL: Record<CostTier, string> = { economy: "Economy", standard: "Standard", premium: "Premium" };
const COST_TIER_BADGE: Record<CostTier, "green" | "blue" | "amber"> = { economy: "green", standard: "blue", premium: "amber" };

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
  // Whether the businesses list actually loaded. Critical distinction: a FAILED load used to
  // render identically to "you genuinely have no businesses" — the two calls were awaited with
  // Promise.all, so one failing threw both away, leaving the page confidently telling someone who
  // owns businesses that they own none, with a 2.8s toast as the only clue. Telling a user their
  // work is gone is much worse than telling them a page didn't load.
  const [businessesFailed, setBusinessesFailed] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [templateActivity, setTemplateActivity] = React.useState<TemplateActivity[]>([]);
  const [showAllModels, setShowAllModels] = React.useState(false);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    // allSettled, not all: each of these fails independently (the manifest drives the template
    // catalogue, businesses drives the list, activity is a nice-to-have showcase) and one must
    // never take out the others.
    const [m, b] = await Promise.allSettled([
      getShellManifest(product.space_id, creds),
      listMyBusinesses(product.space_id, creds),
    ]);
    if (m.status === "fulfilled") setManifest(m.value);
    if (b.status === "fulfilled") {
      setBusinesses(b.value);
      setBusinessesFailed(false);
    } else {
      setBusinessesFailed(true);
    }
    if (m.status === "rejected" && b.status === "rejected") show("Couldn't load Discover");
    setLoading(false);
    // Genuinely optional — a failure here just means the showcase section doesn't render, never
    // an error the user sees.
    getTemplateActivity(product.space_id, creds).then(setTemplateActivity).catch(() => {});
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

  const filteredBusinesses = query.trim()
    ? businesses.filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase()))
    : businesses;

  // Showcase rows: activity joined against real template names, sorted by how many businesses are
  // actually running each one. A template with zero active businesses simply doesn't appear —
  // there's nothing honest to say about it yet.
  const showcaseRows = templateActivity
    .map((a) => ({ ...a, name: availableTemplates.find((t) => t.id === a.template_id)?.name ?? a.template_id }))
    .filter((r) => r.active_count > 0);

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

      {!loading && !businessesFailed && businesses.length > 0 && (
        <div className="search-bar" style={{ marginBottom: 16 }}>
          <FormInput
            placeholder="Search your businesses…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      <div className="section-label">
        Your businesses{!loading && !businessesFailed && businesses.length > 0 ? ` (${filteredBusinesses.length}${query.trim() ? ` of ${businesses.length}` : ""})` : ""}
      </div>
      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : businessesFailed ? (
        // Never silently degrade to "you have none" — say the list didn't load and offer a retry.
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
          <span style={{ color: "#dc2626" }} role="alert">
            Couldn&rsquo;t load your businesses. They&rsquo;re still there — this is a loading problem.
          </span>
          <Button variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : businesses.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          {canCreate
            ? "Nothing here yet — pick a template below and your assistant takes it from there."
            // Not "this product doesn't support customer-created businesses": that is how the
            // platform describes itself to itself, not something an end user should have to
            // decode. Say what it means for them.
            : "You don't run any businesses here yet. Your workspace lives in this product directly."}
        </p>
      ) : filteredBusinesses.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>No business matches &ldquo;{query}&rdquo;.</p>
      ) : (
        <div className="grid-3">
          {filteredBusinesses.map((b) => {
            // A business created but never configured does nothing at all — its assistant has no
            // account to read and no way to reach its owner. That's the single most useful thing
            // this page can tell someone, so it gets the card's primary action.
            const needsSetup = b.onboarding_status != null && b.onboarding_status !== "complete";
            const provisioning = b.space_status !== "active";
            return (
              <Link
                key={b.id}
                href={needsSetup ? `/p/${product.slug}/spaces/${b.id}/onboarding` : `/p/${product.slug}/spaces/${b.id}`}
                style={{ textDecoration: "none" }}
              >
                <Card interactive>
                  <CardTitle>{b.name}</CardTitle>
                  <CardDesc>
                    {needsSetup
                      ? "Setup isn't finished — it can't run until it is."
                      : `Your role: ${b.role}`}
                  </CardDesc>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {needsSetup && <Badge color="amber">Finish setup</Badge>}
                    <Badge color={provisioning ? "amber" : "green"}>
                      {provisioning ? b.space_status : "active"}
                    </Badge>
                    {b.template_id && <Badge color="blue">{b.template_id.replace(/-/g, " ")}</Badge>}
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      {/* What other businesses are doing — aggregate counts only, never a name or a figure that
          would identify or expose anyone (see the route's own header for why this is safe to
          show cross-tenant). A signal that a template is a real, chosen thing, not a leaderboard
          to compete on — no buying or selling here, just visibility into what's out there. */}
      {showcaseRows.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 26 }}>
            What other businesses are doing
          </div>
          <div className="grid-3">
            {showcaseRows.map((r) => (
              <Card key={r.template_id} interactive={false}>
                <CardTitle>{r.name.replace(/-/g, " ")}</CardTitle>
                <CardDesc>
                  {r.active_count} business{r.active_count === 1 ? "" : "es"} running this template
                </CardDesc>
                {r.created_last_30d > 0 && (
                  <Badge color="green">{r.created_last_30d} new this month</Badge>
                )}
              </Card>
            ))}
          </div>
        </>
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

      {/* Model Benchmarks — every model an agent can actually run on, what it's good at, and what
          it costs, so you (and your assistant, when it decides whether to delegate a step to a
          more capable model) both know the real tradeoffs. `eval` numbers are REAL — measured on
          THIS platform's own agent loop, not a generic leaderboard score; see each card's own
          note for what was and wasn't measured. Set your default model and how far it's allowed
          to escalate on the Effort control in any chat's input bar, or from a business's
          Dashboard tab. */}
      <div className="section-label" style={{ marginTop: 26 }}>
        Model benchmarks
      </div>
      <p style={{ fontSize: 12, color: "var(--text3)", margin: "-6px 0 12px" }}>
        What each model is good at and what it costs — measured on this platform&rsquo;s own agent
        loop where we have real numbers, otherwise an honest estimate from the model&rsquo;s own
        published size. The Effort control on any chat decides how far your agent is allowed to
        reach for a more capable (and pricier) model when it needs help.
      </p>
      <div className="grid-3">
        {(showAllModels ? listModelBenchmarks() : listModelBenchmarks().slice(0, 6)).map((b) => (
          <Card key={b.id} interactive={false}>
            <CardTitle>
              {modelLabel(b.id)}
              {b.id === DEFAULT_WORKING_MODEL && (
                <span style={{ marginLeft: 6, fontSize: 10.5, color: "var(--accent)", fontWeight: 600 }}>
                  DEFAULT
                </span>
              )}
            </CardTitle>
            <CardDesc>{b.strengths[0]}</CardDesc>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
              <Badge color={COST_TIER_BADGE[b.costTier]}>{COST_TIER_LABEL[b.costTier]}</Badge>
              {b.costBasis === "estimated" && <Badge color="blue">Estimated cost</Badge>}
              {b.eval && (
                <Badge color={b.eval.usable.startsWith("0") ? "amber" : "green"}>
                  {b.eval.usable} usable · {b.eval.avgScore.toFixed(2)}/10
                </Badge>
              )}
            </div>
            <p style={{ fontSize: 11.5, color: "var(--text3)", margin: "4px 0 0" }}>
              {b.eval ? b.eval.note : `Best for: ${b.bestFor[0]}`}
            </p>
          </Card>
        ))}
      </div>
      {!showAllModels && listModelBenchmarks().length > 6 && (
        <Button variant="secondary" onClick={() => setShowAllModels(true)} style={{ marginTop: 10 }}>
          Show all {listModelBenchmarks().length} models
        </Button>
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
            Template — tap to select, tap again to deselect
          </div>
          <div className="app-grid">
            <button
              type="button"
              className={`card app-card${selectedTemplates.has(CUSTOM_BUSINESS) ? " connected" : ""}`}
              onClick={() => toggleTemplate(CUSTOM_BUSINESS)}
              style={{ textAlign: "left", cursor: "pointer", font: "inherit", borderStyle: "dashed" }}
            >
              <CardTitle>Custom</CardTitle>
              <div className="app-card-desc card-desc">Build from scratch with the assistant.</div>
            </button>
            {availableTemplates.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`card app-card${selectedTemplates.has(t.id) ? " connected" : ""}`}
                disabled={t.coming_soon}
                onClick={() => toggleTemplate(t.id)}
                style={{ textAlign: "left", cursor: t.coming_soon ? "default" : "pointer", font: "inherit", opacity: t.coming_soon ? 0.55 : 1 }}
              >
                <CardTitle>{t.name}</CardTitle>
                <div className="app-card-desc card-desc">Preconfigured workspaces, agents and setup — ready to run.</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {t.coming_soon && <Badge color="amber">Coming soon</Badge>}
                  {!t.coming_soon && !t.free_tier_eligible && <Badge color="amber">Requires plan upgrade</Badge>}
                </div>
              </button>
            ))}
          </div>
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
