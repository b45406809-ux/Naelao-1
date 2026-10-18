"use client";

import * as React from "react";
import { Button } from "@naelao/ui";
import {
  getBusinessWallet, listWorkspaceFiles, readWorkspaceFile,
  type Project, type BusinessWallet, type WorkspaceFile, type WorkspaceFileContent,
} from "@/lib/api";
import { FileViewer } from "@/components/FileViewer";
import { CanvasContainer } from "@/components/CanvasContainer";

type Creds = { sessionToken: string; endUserId: string };

function money(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100);
}

// F-40: WalletLedgerPanel — the natively-built panel for kind='wallet'. Looks like a bank-account
// ledger (balance + lifetime cuts + transactions), NOT a generic registry-driven component.
function WalletLedgerPanel({ spaceId, creds }: { spaceId: string; creds: Creds }) {
  const [wallet, setWallet] = React.useState<BusinessWallet | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    getBusinessWallet(spaceId, creds).then(setWallet).catch(() => setWallet(null)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);
  if (loading) return <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading wallet…</p>;
  if (!wallet) return <p style={{ color: "var(--text3)", fontSize: 13 }}>Wallet unavailable.</p>;
  return (
    <div className="settings-block">
      <div className="settings-row">
        <div>
          <div className="settings-row-label">Available to grow the business</div>
          <div className="settings-row-sub">Your AI only spends money this business has earned.</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="settings-row-label">{money(wallet.available_balance_cents, wallet.currency)}</div>
          <div className="settings-row-sub">{wallet.currency}</div>
        </div>
      </div>
      <div className="settings-row">
        <div>
          <div className="settings-row-label">Lifetime earned</div>
          <div className="settings-row-sub">{wallet.lifetime.order_count} settled order(s)</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="settings-row-label">{money(wallet.lifetime.gross_cents)} gross</div>
          <div className="settings-row-sub">
            {money(wallet.lifetime.naelao_cut_cents)} Naelao cut
            {wallet.lifetime.builder_cut_cents > 0 ? ` · ${money(wallet.lifetime.builder_cut_cents)} builder cut` : ""}
          </div>
        </div>
      </div>
      {wallet.transactions.slice(0, 10).map((t) => (
        <div className="settings-row" key={t.id}>
          <div>
            <div className="settings-row-label">{t.reason.replace(/_/g, " ")}</div>
            <div className="settings-row-sub">{new Date(t.created_at).toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="settings-row-label">{t.delta_cents >= 0 ? "+" : ""}{money(t.delta_cents)}</div>
            <div className="settings-row-sub">bal {money(t.balance_after_cents)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// F-39 UI: read-only workspace file viewer — lists a project's R2 artifacts; clicking an .html file
// previews it in a sandboxed iframe, other text shows inline.
function WorkspaceFilesPanel({ spaceId, projectId, creds }: { spaceId: string; projectId: string; creds: Creds }) {
  const [files, setFiles] = React.useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState<WorkspaceFileContent | null>(null);
  React.useEffect(() => {
    listWorkspaceFiles(spaceId, projectId, creds).then(setFiles).catch(() => setFiles([])).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, projectId]);

  async function openFile(path: string) {
    try { setOpen(await readWorkspaceFile(spaceId, projectId, path, creds)); }
    catch { setOpen({ path, content: "(could not read file)" }); }
  }

  if (loading) return <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading files…</p>;
  if (files.length === 0) return <p style={{ color: "var(--text3)", fontSize: 13 }}>No files in this project's workspace yet — your agent's generated artifacts appear here.</p>;
  return (
    <>
      <div className="settings-block">
        {files.map((f) => (
          <div className="settings-row" key={f.path}>
            <div>
              <div className="settings-row-label">{f.path}</div>
              <div className="settings-row-sub">{(f.size / 1024).toFixed(1)} KB · {new Date(f.uploaded).toLocaleDateString()}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => openFile(f.path)}>View</Button>
          </div>
        ))}
      </div>
      {open && (
        <div className="settings-block" style={{ marginTop: 12, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>{open.path}</strong>
            <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Close</Button>
          </div>
          {/* Step 4: multi-format viewer (PDF, images, Word/Excel, text/html/markdown/csv). */}
          <FileViewer file={open} />
        </div>
      )}
    </>
  );
}

/**
 * F-40: the mount point for specialized built-in workspaces —
 * each kind's panel is its own purpose-built component. A kind with no panel yet renders nothing
 * (the shared project shell alone), which is the expected incremental-build path. The Files viewer
 * (F-39) is shown for every kind since every project has a workspace.
 */
export function ProjectKindPanel({ project, spaceId, creds }: { project: Project; spaceId: string; creds: Creds }) {
  const canvasKind = ["product_dev", "doc_studio", "finance_grid", "quant_desk", "voice_agent", "model_studio", "growth_engine", "app_studio"].includes(project.kind ?? "");
  return (
    <>
      {canvasKind && <CanvasContainer project={project} spaceId={spaceId} creds={creds} />}
      {project.kind === "wallet" && (
        <>
          <div className="section-label">Wallet</div>
          <WalletLedgerPanel spaceId={spaceId} creds={creds} />
        </>
      )}
      {/* Additional kind panels (storefront, crm, ...) mount here one at a time — see F-40. */}

      {!canvasKind && <><div className="section-label" style={{ marginTop: 24 }}>Files</div><WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} /></>}
    </>
  );
}
