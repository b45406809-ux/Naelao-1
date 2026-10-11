"use client";

export default function ProductLoadError({ reset }: { error: Error; reset: () => void }) {
  return <main className="page-view" style={{ maxWidth: 600, margin: "64px auto" }}>
    <h1>Couldn't load your workspace</h1>
    <p>The server isn't responding right now. Your workspace may still be available—try loading it again.</p>
    <button className="btn btn-primary" onClick={reset}>Try again</button>
  </main>;
}
