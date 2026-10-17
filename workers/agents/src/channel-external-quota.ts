export async function opaqueExternalSubject(secret: string, parts: readonly string[]): Promise<string> {
  if (!secret) throw new Error("external_quota_hash_key_missing");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(parts.join("\u001f")));
  return Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, "0")).join("");
}

