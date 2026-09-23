"use client";

export function SecurityBoundaryCard({
  code,
}: { code: "destructive_mutation_denied" | "egress_dlp_blocked" }) {
  const mutation = code === "destructive_mutation_denied";
  return (
    <section
      role="alert"
      aria-live="polite"
      style={{
        width: "100%",
        border: "1px solid #f59e0b",
        borderRadius: 12,
        padding: "12px 14px",
        background: "rgba(245,158,11,.08)",
        color: "var(--text1)",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        🛡️{" "}
        {mutation
          ? "WriteGuard blocked this action"
          : "Outbound DLP blocked this message"}
      </div>
      <div style={{ color: "var(--text3)", fontSize: 13, lineHeight: 1.45 }}>
        {mutation
          ? "A destructive command needs a fresh, resource-scoped approval. Nothing was changed."
          : "Protected data was detected before the connector request left Naelao. Nothing was sent."}
      </div>
    </section>
  );
}
