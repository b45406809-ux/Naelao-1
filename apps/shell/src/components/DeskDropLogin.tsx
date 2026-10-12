"use client";
import * as React from "react";
import { QrCode } from "@naelao/ui";

export function DeskDropLogin({ productId }: { productId: string }) {
  const [challenge, setChallenge] = React.useState<{ command: string; links: Array<{ channel: string; url: string }> } | null>(null);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState(0);
  const api = "/api/naelao";
  React.useEffect(() => { setChallenge(null); setReady(false); setError(""); }, [productId]);
  React.useEffect(() => {
    if (!challenge || ready) return;
    let cancelled = false; const controller = new AbortController();
    const interval = setInterval(() => {
      if (Date.now() >= expiresAt) { setChallenge(null); setError("This code expired. Generate a new one."); return; }
      void fetch(`${api}/v1/desk-drop/status`, { credentials: "include", signal: controller.signal })
        .then(async res => res.ok ? await res.json() as { ready: boolean } : { ready: false })
        .then(result => { if (!cancelled && result.ready) setReady(true); }).catch(() => {});
    }, 2000);
    return () => { cancelled = true; controller.abort(); clearInterval(interval); };
  }, [api, challenge, expiresAt, ready]);
  async function start() {
    setError(""); setReady(false);
    try {
      const res = await fetch(`${api}/v1/desk-drop/challenge`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId }) });
      if (!res.ok) throw new Error("Desktop sign-in is unavailable. Try again shortly.");
      setChallenge(await res.json()); setExpiresAt(Date.now() + 90_000);
    } catch (err) { setError((err as Error).message); }
  }
  return <div style={{ marginTop: 16 }}>
    {!challenge ? <button type="button" onClick={() => void start()}>Sign in from your connected phone</button>
      : ready ? <form method="POST" action={`${api}/v1/desk-drop/redeem`}><button>Open canvas</button></form>
      : <div><p>Approve this browser from your verified owner or admin chat within 90 seconds.</p>
        {challenge.links.map(link => <div key={link.channel}><QrCode value={link.url} label={`Open ${link.channel} to approve desktop access`} size={160} /><a href={link.url}>{link.channel}</a></div>)}
        <p>Send this to your connected Naelao chat: <code>{challenge.command}</code></p>
      </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
