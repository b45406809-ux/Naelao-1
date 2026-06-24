function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function deriveSpaceKey(masterKeyHex: string, spaceId: string): Promise<CryptoKey> {
  const masterKeyBytes = hexToBytes(masterKeyHex);
  const masterKey = await crypto.subtle.importKey('raw', masterKeyBytes, 'HKDF', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(spaceId),
      info: new TextEncoder().encode('mcp-credentials-v1'),
    },
    masterKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptCredential(
  value: string,
  masterKeyHex: string,
  spaceId: string
): Promise<string> {
  const key = await deriveSpaceKey(masterKeyHex, spaceId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(value)
  );

  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return 'v1:' + bytesToBase64(combined);
}

export async function decryptCredential(
  encrypted: string,
  masterKeyHex: string,
  spaceId: string
): Promise<string> {
  try {
    if (!encrypted.startsWith('v1:')) throw new Error('invalid_format');
    const combined = base64ToBytes(encrypted.slice(3));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const key = await deriveSpaceKey(masterKeyHex, spaceId);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('credential_decrypt_failed');
  }
}
