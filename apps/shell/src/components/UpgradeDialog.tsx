"use client";

export function UpgradeDialog({ errorCode, message, supportContact, onClose }: {
  errorCode: string; message: string; supportContact?: string | null | undefined; onClose: () => void;
}) {
  const quota = errorCode === "quota_exceeded" || errorCode === "infra_quota_exceeded";
  return (
    <div role="dialog" aria-modal="true" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(event) => event.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", maxWidth: 440, width: "100%", padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{quota ? "Usage limit reached" : "Action unavailable"}</h2>
        <p style={{ fontSize: 13, color: "var(--text2)", marginBottom: 12, lineHeight: 1.5 }}>{message}</p>
        {quota && <p style={{ fontSize: 12.5, color: "var(--text3)", marginBottom: 12 }}>Check the Naelao subscription and usage settings, or wait for the next quota reset.</p>}
        {supportContact && <p style={{ fontSize: 12, color: "var(--text3)" }}>Need help? <a href={supportContact} style={{ color: "var(--accent)" }}>Contact support</a></p>}
        <div style={{ marginTop: 16, textAlign: "right" }}><button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
