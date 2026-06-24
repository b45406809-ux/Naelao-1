interface Env {
  GITHUB_WEBHOOK_SECRET: string;
  LEMON_SQUEEZY_WEBHOOK_SECRET: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifySignature(
  provider: string,
  rawBody: string,
  headers: Headers,
  env: Env
): Promise<boolean> {
  if (provider === 'github') {
    const sig = headers.get('X-Hub-Signature-256') ?? '';
    const expected = 'sha256=' + await hmacHex(env.GITHUB_WEBHOOK_SECRET, rawBody);
    return timingSafeEqual(sig, expected);
  }

  if (provider === 'lemon_squeezy') {
    const sig = headers.get('X-Signature') ?? '';
    const expected = await hmacHex(env.LEMON_SQUEEZY_WEBHOOK_SECRET, rawBody);
    return timingSafeEqual(sig, expected);
  }

  if (provider === 'stripe') {
    const sigHeader = headers.get('Stripe-Signature') ?? '';
    const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
    const ts = parts['t'] ?? '';
    const v1 = parts['v1'] ?? '';
    if (!ts || !v1) return false;
    const age = Math.abs(Date.now() / 1000 - parseInt(ts));
    if (age > 300) return false;
    const secret = env.STRIPE_WEBHOOK_SECRET ?? '';
    if (!secret) return false;
    const expected = await hmacHex(secret, ts + '.' + rawBody);
    return timingSafeEqual(v1, expected);
  }

  return false;
}
