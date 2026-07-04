export default function IndexPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 8,
        textAlign: "center",
        padding: 24,
      }}
    >
      <h1 style={{ fontFamily: "'Instrument Serif',serif", fontSize: 28 }}>Naelao</h1>
      <p style={{ color: "var(--text2)" }}>Visit your product at /p/&lt;your-product-slug&gt;.</p>
    </div>
  );
}
