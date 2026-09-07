export async function delegateTask(
  targetRole: string, 
  taskDescription: string, 
  contextFiles: string[], 
  ctx: any
) {
  // 1. Extract the original human caller from the current execution context
  const initiatingUserId = ctx.env.actingUserId;
  const initiatingRoleRank = ctx.env.actingRoleRank;

  if (!initiatingUserId) {
    throw new Error("Delegation failed: Cannot delegate tasks without a traceable human initiator.");
  }

  // 2. Construct the Delegation Payload
  const taskTokenPayload = {
    initiatingUserId,
    initiatingRoleRank,
    targetRole,
    sourceAgentId: ctx.env.agentId,
    projectId: ctx.env.projectId,
    nonce: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 3600 // 1 hour expiration
  };

  // 3. Cryptographically sign the delegation token
  const signedToken = await signTaskToken(taskTokenPayload, ctx.env.PLATFORM_SECRET);

  // 4. Dispatch the sub-task to the target agent DO (via WsHub or Queues)
  // This notifies the target agent without executing it in the current turn.
  if (ctx.env.queue?.send) {
    await ctx.env.queue.send({
      type: "DELEGATE_TURN",
      targetAgentId: targetRole,
      threadId: ctx.env.threadId,
      taskDescription,
      contextFiles,
      delegationToken: signedToken
    });
  }

  return {
    success: true,
    message: `✔ Task securely delegated to @${targetRole}. Turn yielded.`
  };
}

/**
 * Signs the payload using HMAC-SHA256 (WebCrypto API)
 */
export async function signTaskToken(payload: any, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const payloadStr = btoa(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", keyMaterial, encoder.encode(payloadStr));
  
  const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); // URL-safe Base64

  return `${payloadStr}.${sigBase64}`;
}

/**
 * Verifies the delegation token using HMAC-SHA256
 */
export async function verifyTaskToken(token: string, secret: string): Promise<any | null> {
  try {
    const [payloadB64, sigB64] = token.split(".");
    if (!payloadB64 || !sigB64) return null;
    const encoder = new TextEncoder();
    
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signatureBytes = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    
    const isValid = await crypto.subtle.verify("HMAC", keyMaterial, signatureBytes, encoder.encode(payloadB64));
    
    if (!isValid) return null;

    const payload = JSON.parse(atob(payloadB64));
    if (Math.floor(Date.now() / 1000) > payload.exp) return null; // Expired

    return payload;
  } catch {
    return null;
  }
}
