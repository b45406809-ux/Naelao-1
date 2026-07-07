"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { deleteMe } from "@/lib/api";

export default function SettingsPage() {
  const product = useProduct();
  const router = useRouter();
  const { session, signOut } = useProductAuth();
  const [confirming, setConfirming] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleDelete() {
    if (!session) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteMe(product.space_id, { sessionToken: session.session_token, endUserId: session.end_user_id });
      signOut();
      router.replace(`/p/${product.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete account");
      setDeleting(false);
    }
  }

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Settings</div>
        <div className="page-subtitle">Members, billing, and credentials land in a later phase.</div>
      </div>
      <div className="settings-block">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Signed in as</div>
            <div className="settings-row-sub">{session?.end_user_id}</div>
          </div>
          <button className="btn btn-secondary" type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      <div className="settings-block" style={{ marginTop: 24, borderColor: "#dc2626" }}>
        <div className="settings-row" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
          <div>
            <div className="settings-row-label">Delete account</div>
            <div className="settings-row-sub">
              Permanently erases your sessions, saved conversations, and preferences. This cannot
              be undone.
            </div>
          </div>
          {!confirming ? (
            <button
              className="btn btn-secondary"
              type="button"
              style={{ color: "#dc2626", borderColor: "#dc2626" }}
              onClick={() => setConfirming(true)}
            >
              Delete my account
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", maxWidth: 320 }}>
              <label style={{ fontSize: 12.5, color: "var(--text2)" }}>
                Type DELETE to confirm
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                style={{
                  padding: "8px 10px",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  fontSize: 13,
                }}
              />
              {error && <div style={{ color: "#dc2626", fontSize: 12.5 }}>{error}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={confirmText !== "DELETE" || deleting}
                  style={{ color: "#dc2626", borderColor: "#dc2626" }}
                  onClick={() => void handleDelete()}
                >
                  {deleting ? "Deleting…" : "Confirm delete"}
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => { setConfirming(false); setConfirmText(""); setError(null); }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
