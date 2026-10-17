"use client";

// Step 20: the Plugins directory — a browsable catalogue of the native business-infrastructure
// "plugins" (Wallet, CRM, Business Email, Storefront, Analytics, …) a business can install, in the
// spirit of Claude's own plugin marketplace. Distinct from the inline "Plugins" grid in the New
// Project dialog (which only shows what you could ADD): this page also shows what's already
// installed and which come by DEFAULT with a business, so an operator can see their whole plugin
// surface in one place and reach it later without opening a create-project modal.
//
// A "plugin" here IS a project of a Business Feature kind — same mechanism, not a parallel system
// (CLAUDE.md ground rule #4). Installing one creates that kind of project; opening one navigates
// to its project (whose shell mounts the kind's native panel).

import * as React from "react";
import Link from "next/link";
import { Button, Card, CardTitle, CardDesc, Badge, Modal, FormInput, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  listProjects,
  createProject,
  getFeatureKinds,
  ApiError,
  type Project,
  type FeatureKind,
} from "@/lib/api";

// The two base project shapes, never "plugins" — mirrors STRUCTURAL_PROJECT_KINDS in
// @naelao/events. Anything else with a kind set is a feature-kind plugin.
const STRUCTURAL_KINDS = new Set(["", "workspace"]);

interface InstalledPlugin {
  kind: string;
  /** The installed project itself — the card links here. */
  project: Project;
  /** The registry label when the caller could also create this kind; else the project name. */
  label: string;
  description?: string | undefined;
}

export default function PluginsPage() {
  const product = useProduct();
  const { activeSpaceId } = useActiveSpace();
  const { session } = useProductAuth();
  const { toast, show } = useToast();

  const [projects, setProjects] = React.useState<Project[]>([]);
  const [featureKinds, setFeatureKinds] = React.useState<FeatureKind[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadFailed, setLoadFailed] = React.useState(false);

  // Install dialog: pick a plugin, then name the project it creates.
  const [picked, setPicked] = React.useState<FeatureKind | null>(null);
  const [name, setName] = React.useState("");
  const [installing, setInstalling] = React.useState(false);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    // allSettled: the project list and the installable-kinds list fail independently — one must
    // never blank the whole directory. getFeatureKinds is empty for a viewer/member who can't
    // create any kind; that's correct (they still SEE what's installed, just can't add more).
    const [p, k] = await Promise.allSettled([
      listProjects(activeSpaceId, creds),
      getFeatureKinds(activeSpaceId, creds),
    ]);
    if (p.status === "fulfilled") {
      setProjects(p.value);
      setLoadFailed(false);
    } else if (p.reason instanceof ApiError && [401, 403].includes(p.reason.status)) {
      // The product shell is reachable before the user belongs to a business. Show the empty
      // catalogue state instead of reporting a misleading network/loading failure.
      setProjects([]);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
    if (k.status === "fulfilled") setFeatureKinds(k.value);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Installed = every active project whose kind is a real feature kind (not a base shape). Uses the
  // project list, which is visible to every role, so an operator sees their whole plugin surface
  // regardless of whether they could ADD more.
  const kindByName = React.useMemo(
    () => new Map(featureKinds.map((k) => [k.kind, k])),
    [featureKinds],
  );
  const installed: InstalledPlugin[] = projects
    .filter((p) => p.status !== "archived" && p.kind && !STRUCTURAL_KINDS.has(p.kind))
    .map((p) => {
      const reg = kindByName.get(p.kind!);
      return { kind: p.kind!, project: p, label: reg?.label ?? p.name, description: reg?.description };
    });
  const installedKinds = new Set(installed.map((i) => i.kind));

  // Available = role-filtered installable kinds not already present as an active singleton. A
  // non-singleton kind stays available even when one exists (you can add another).
  const available = featureKinds.filter(
    (k) => !(k.singleton && installedKinds.has(k.kind)),
  );

  function openInstall(k: FeatureKind) {
    setPicked(k);
    setName(k.label);
  }

  async function handleInstall(e: React.FormEvent) {
    e.preventDefault();
    if (!creds || !picked || !name.trim()) return;
    setInstalling(true);
    try {
      await createProject(activeSpaceId, creds, name.trim(), picked.description, picked.kind);
      setPicked(null);
      show(`"${name.trim()}" installed.`);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to install plugin");
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Plugins</div>
        <div className="page-subtitle">
          Native business infrastructure — a wallet, a CRM, a shared inbox — installed as projects
          your agents work inside. Some come with your business by default; add more any time.
        </div>
      </div>

      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : loadFailed ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
          <span style={{ color: "#dc2626" }} role="alert">
            Couldn&rsquo;t load your plugins — this is a loading problem, nothing is lost.
          </span>
          <Button variant="secondary" onClick={() => void refresh()}>Retry</Button>
        </div>
      ) : (
        <>
          <div className="section-label">Installed{installed.length > 0 ? ` (${installed.length})` : ""}</div>
          {installed.length === 0 ? (
            <p style={{ color: "var(--text3)", fontSize: 13 }}>
              Nothing installed yet — add one from the catalogue below.
            </p>
          ) : (
            <div className="grid-3">
              {installed.map((i) => (
                <Link
                  key={i.project.id}
                  href={`/p/${product.slug}/projects/${i.project.id}`}
                  style={{ textDecoration: "none" }}
                >
                  <Card interactive>
                    <div className="app-card-header">
                      <div className="app-card-initial">{i.label.slice(0, 1)}</div>
                      <CardTitle>{i.project.name}</CardTitle>
                    </div>
                    {i.description && <CardDesc>{i.description}</CardDesc>}
                    <Badge color="green">Installed</Badge>
                  </Card>
                </Link>
              ))}
            </div>
          )}

          {available.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop: 26 }}>Add a plugin</div>
              <div className="grid-3">
                {available.map((k) => (
                  <Card key={k.kind} interactive onClick={() => openInstall(k)} style={{ cursor: "pointer" }}>
                    <div className="app-card-header">
                      <div className="app-card-initial">{k.label.slice(0, 1)}</div>
                      <CardTitle>{k.label}</CardTitle>
                    </div>
                    <CardDesc>{k.description}</CardDesc>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {/* autoProvisionable kinds are the ones a business template installs by
                          default — surface that so an operator knows which come free with a
                          business vs. which they're adding by hand. */}
                      {k.autoProvisionable && <Badge color="blue">Default</Badge>}
                      {installedKinds.has(k.kind) && !k.singleton && <Badge color="green">Installed</Badge>}
                    </div>
                  </Card>
                ))}
              </div>
            </>
          )}

          {available.length === 0 && installed.length > 0 && (
            <p style={{ color: "var(--text3)", fontSize: 13, marginTop: 20 }}>
              Every plugin available to you is already installed.
            </p>
          )}
        </>
      )}

      <Modal
        open={picked !== null}
        onClose={() => setPicked(null)}
        title={picked ? `Install ${picked.label}` : "Install plugin"}
        footer={
          <>
            <Button variant="secondary" type="button" onClick={() => setPicked(null)}>Cancel</Button>
            <Button onClick={handleInstall} disabled={installing || !name.trim()}>
              {installing ? "Installing…" : "Install"}
            </Button>
          </>
        }
      >
        <form onSubmit={handleInstall} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {picked && <p style={{ fontSize: 13, color: "var(--text3)", margin: 0 }}>{picked.description}</p>}
          <FormInput
            placeholder="Name it"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </form>
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}
