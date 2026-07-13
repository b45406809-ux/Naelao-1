"use client";

export const runtime = "edge";

import * as React from "react";
import Link from "next/link";
import { Button, Badge, Card, CardTitle, CardDesc, Modal, FormInput, Toggle, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { getShellManifest, listMyBusinesses, createBusiness, type ShellManifest, type Business } from "@/lib/api";

// Phase F (§A1.17): a sentinel selection meaning "no template — the assistant helps build this
// business from scratch," distinct from an empty Set (which used to mean the same thing but
// wasn't a labeled choice). Never sent to the backend as a template id.
const CUSTOM_BUSINESS = "__custom__";

export default function SpacesPage() {
  const product = useProduct();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const [manifest, setManifest] = React.useState<ShellManifest | null>(null);
  const [businesses, setBusinesses] = React.useState<Business[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [selectedTemplates, setSelectedTemplates] = React.useState<Set<string>>(new Set());
  const [creating, setCreating] = React.useState(false);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      const [m, b] = await Promise.all([getShellManifest(product.space_id, creds), listMyBusinesses(product.space_id, creds)]);
      setManifest(m);
      setBusinesses(b);
    } catch {
      show("Couldn't load spaces");
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

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!creds || !name.trim()) return;
    setCreating(true);
    try {
      const allowed = manifest?.allowed_child_space_types ?? ["launchpad"];
      const templateIds = Array.from(selectedTemplates).filter((id) => id !== CUSTOM_BUSINESS);
      await createBusiness(product.space_id, creds, {
        name: name.trim(),
        spacetype_id: allowed[0] ?? "launchpad",
        template_ids: templateIds,
      });
      setModalOpen(false);
      setName("");
      setSelectedTemplates(new Set());
      show("Business created — provisioning may take a moment");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to create business");
    } finally {
      setCreating(false);
    }
  }

  const canCreate = manifest?.membership_model === "tenant" || manifest?.membership_model === "hybrid";
  // Phase F: render from the real, coming_soon-aware catalog (shell/manifest's template_catalog,
  // already intersected server-side with the builder's business_templates narrowing) instead of a
  // hardcoded duplicate of LAUNCHPAD_TEMPLATES.
  const availableTemplates = manifest?.template_catalog ?? [];

  return (
    <div className="page-view">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="page-title">Spaces</div>
          <div className="page-subtitle">{product.product_name} and the businesses you belong to.</div>
        </div>
        {canCreate && <Button onClick={() => setModalOpen(true)}>Create Business</Button>}
      </div>

      <div className="section-label">Product</div>
      <Card interactive={false}>
        <CardTitle>{manifest?.space_name ?? product.product_name}</CardTitle>
        <CardDesc>The shared product root.</CardDesc>
      </Card>

      <div className="section-label" style={{ marginTop: 20 }}>
        Your businesses
      </div>
      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : businesses.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          {canCreate ? "You haven't created a business yet." : "This product doesn't support customer-created businesses."}
        </p>
      ) : (
        <div className="grid-3">
          {businesses.map((b) => (
            <Link key={b.id} href={`/p/${product.slug}/spaces/${b.id}`} style={{ textDecoration: "none" }}>
              <Card>
                <CardTitle>{b.name}</CardTitle>
                <CardDesc>Role: {b.role}</CardDesc>
                <Badge color={b.space_status === "active" ? "green" : "amber"}>{b.space_status}</Badge>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Create a Business"
        footer={
          <>
            <Button variant="secondary" type="button" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <FormInput placeholder="Business name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          <div className="section-label" style={{ marginTop: 8 }}>
            Templates (optional — pick one or more)
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
              </label>
            )
          )}
          {selectedTemplates.has(CUSTOM_BUSINESS) && (
            <p style={{ fontSize: 12, color: "var(--text3)" }}>The assistant will help you design and set up this business.</p>
          )}
        </form>
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}
