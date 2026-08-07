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
  // Whether the businesses list actually loaded. Critical distinction: a FAILED load used to
  // render identically to "you genuinely have no businesses" — the two calls were awaited with
  // Promise.all, so one failing threw both away, leaving the page confidently telling someone who
  // owns businesses that they own none, with a 2.8s toast as the only clue. Telling a user their
  // work is gone is much worse than telling them a page didn't load.
  const [businessesFailed, setBusinessesFailed] = React.useState(false);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    // allSettled, not all: the manifest drives the template catalogue and the businesses call
    // drives the list above it. They fail independently and one must never take out the other.
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

  // Quick-nav tree on the left (per the launchpad mockup's Spaces page) — real businesses only,
  // never the SpaceType-picker grid the mockup's page also had (explicitly out of scope: builders
  // configure a Product's SpaceType once at creation, not something an end user picks per-space —
  // see CLAUDE.md item 7). It's a shortcut alongside the card grid below, not a replacement for
  // it: the grid is still what you'd use to actually start something new.
  const showTree = !loading && !businessesFailed && businesses.length > 0;

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
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {showTree && (
        <div
          style={{
            width: 200,
            flexShrink: 0,
            borderRight: "1px solid var(--border)",
            overflowY: "auto",
            padding: "14px 10px",
          }}
        >
          <div style={{ fontSize: "10.5px", fontWeight: 500, color: "var(--text3)", letterSpacing: "0.07em", textTransform: "uppercase", padding: "2px 6px 8px" }}>
            Your businesses
          </div>
          {businesses.map((b) => (
            <Link
              key={b.id}
              href={b.onboarding_status != null && b.onboarding_status !== "complete" ? `/p/${product.slug}/spaces/${b.id}/onboarding` : `/p/${product.slug}/spaces/${b.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 8,
                fontSize: 12.5,
                color: "var(--text2)",
                textDecoration: "none",
              }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  background: b.space_status === "active" ? "var(--accent)" : "var(--text3)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  fontSize: 8,
                  color: "#fff",
                  fontWeight: 600,
                }}
              >
                {b.name.slice(0, 2).toUpperCase()}
              </div>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
            </Link>
          ))}
        </div>
      )}
      <div className="page-view" style={{ flex: 1, overflowY: "auto" }}>
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

      <div className="section-label">
        Your businesses{!loading && !businessesFailed && businesses.length > 0 ? ` (${businesses.length})` : ""}
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
      ) : (
        <div className="grid-3">
          {businesses.map((b) => {
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
    </div>
  );
}
