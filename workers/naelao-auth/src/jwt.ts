export interface JWTPayload {
  sub: string;
  spaceId: string;
  rootSpaceId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  builderId: string;
  exp: number;
  iat?: number;
  impersonatedBy?: string;
  scope?: string[];
}

function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + '='.repeat(padding));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signJWT(
  payload: object,
  secret: string,
  expiresInSeconds = 3600
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const encodedHeader = base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = base64urlEncode(new TextEncoder().encode(JSON.stringify(fullPayload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const encodedSig = base64urlEncode(new Uint8Array(sig));

  return `${signingInput}.${encodedSig}`;
}

export async function verifyJWT(token: string, secret: string): Promise<JWTPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('jwt_invalid');

  const [encodedHeader, encodedPayload, encodedSig] = parts as [string, string, string];
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importHmacKey(secret);
  const sigBytes = base64urlDecode(encodedSig);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    new TextEncoder().encode(signingInput)
  );

  if (!valid) throw new Error('jwt_invalid');

  const payload = JSON.parse(
    new TextDecoder().decode(base64urlDecode(encodedPayload))
  ) as JWTPayload;

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('jwt_expired');
  }

  return payload;
}

export async function signInternalToken(
  claims: object,
  secret: string,
  ttlSeconds = 300
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, exp: now + ttlSeconds };
  const encodedPayload = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));

  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload));
  const hexSig = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');

  return `${encodedPayload}.${hexSig}`;
}

export async function verifyInternalToken(
  token: string,
  secret: string
): Promise<Record<string, unknown>> {
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx === -1) throw new Error('internal_token_invalid');

  const encodedPayload = token.slice(0, dotIdx);
  const hexSig = token.slice(dotIdx + 1);

  const key = await importHmacKey(secret);
  const expectedSig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(encodedPayload)
  );
  const expectedHex = [...new Uint8Array(expectedSig)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  if (hexSig.length !== expectedHex.length) throw new Error('internal_token_invalid');
  let diff = 0;
  for (let i = 0; i < hexSig.length; i++) {
    diff |= (hexSig.charCodeAt(i) ?? 0) ^ (expectedHex.charCodeAt(i) ?? 0);
  }
  if (diff !== 0) throw new Error('internal_token_invalid');

  const payload = JSON.parse(
    new TextDecoder().decode(base64urlDecode(encodedPayload))
  ) as Record<string, unknown>;

  const exp = payload['exp'];
  if (typeof exp !== 'number' || exp < Math.floor(Date.now() / 1000)) {
    throw new Error('internal_token_expired');
  }

  return payload;
}
