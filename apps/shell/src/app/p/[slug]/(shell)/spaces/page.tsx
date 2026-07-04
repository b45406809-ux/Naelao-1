"use client";

import * as React from "react";
import Link from "next/link";
import { Button, Badge, Card, CardTitle, CardDesc, Modal, FormInput, Toggle, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { getShellManifest, listMyBusinesses, createBusiness, type ShellManifest, type Business } from "@/lib/api";

// Hardcoded to match workers/agents/src/launchpad/spacetype.ts's LAUNCHPAD_TEMPLATES — there is
// no product-scoped, end-user-reachable /templates read route yet (only the builder dashboard's
// GET /templates on the agents worker), so this is a deliberate Phase C simplification rather
// than plumbing a new backend route for a 7-item static catalogue. Revisit if templates ever
// become dynamic per-product (a `catalog` productConfig field, per the phased plan's Phase D).
const LAUNCHPAD_TEMPLATES = [
  { id: "creator-store", name: "Creator Store" },
  { id: "newsletter-business", name: "Newsletter Business" },
  { id: "micro-saas", name: "Micro-SaaS" },
  { id: "service-agency", name: "Service Agency" },
  { id: "coaching-community", name: "Coaching / Community" },
  { id: "whop-seller", name: "Whop Seller" },
  { id: "customer-service", name: "Customer Service Desk" },
];

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
      const next = new Set(prev);
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
      await createBusiness(product.space_id, creds, {
        name: name.trim(),
        spacetype_id: allowed[0] ?? "launchpad",
        template_ids: Array.from(selectedTemplates),
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
  // Phase D: a builder can narrow the offered templates via productConfig.catalog.businessTemplates
  // (shell/manifest's business_templates) — empty/unset means "not configured yet," so fall back
  // to every template the SpaceType ships rather than showing an empty picker.
  const availableTemplates =
    manifest?.business_templates && manifest.business_templates.length > 0
      ? LAUNCHPAD_TEMPLATES.filter((t) => manifest.business_templates.includes(t.id))
      : LAUNCHPAD_TEMPLATES;

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
          {availableTemplates.map((t) => (
            <label key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
              <Toggle on={selectedTemplates.has(t.id)} onChange={() => toggleTemplate(t.id)} label={t.name} />
              {t.name}
            </label>
          ))}
        </form>
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}
