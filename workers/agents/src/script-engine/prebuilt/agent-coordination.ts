export async function delegateTask(
  targetRole: string, 
  taskDescription: string, 
  contextFiles: string[], 
  ctx: any
) {
  // 1. Extract current hop count (default to 0 if originating directly from user)
  const currentHop = ctx.env?.hopCount || 0;
  const MAX_HOPS = 2;

  // 2. Pre-flight Circuit Breaker
  if (currentHop >= MAX_HOPS) {
    return {
      success: false,
      error_code: "MAX_DELEGATION_DEPTH_REACHED",
      message: `Circuit Breaker activated: You are at delegation depth ${currentHop}. You cannot delegate this task any further. You MUST either complete the task yourself using available tools, or use 'give_up' / 'answer' to explicitly request human intervention.`
    };
  }

  // 3. Extract the original human caller from the current execution context
  const initiatingUserId = ctx.env?.actingUserId || ctx.env?.userId;
  const initiatingRoleRank = ctx.env?.actingRoleRank;

  if (!initiatingUserId) {
    throw new Error("Delegation failed: Cannot delegate tasks without a traceable human initiator.");
  }

  // 4. Construct the Delegation Payload
  const taskTokenPayload = {
    initiatingUserId,
    initiatingRoleRank,
    targetRole,
    sourceAgentId: ctx.env?.agentId,
    projectId: ctx.env?.projectId,
    nonce: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiration
    hopCount: currentHop + 1
  };

  // 5. Cryptographically sign the delegation token
  const signedToken = await signTaskToken(taskTokenPayload, ctx.env?.PLATFORM_SECRET || "");

  const nextHopCount = currentHop + 1;
  const outboundHeaders = {
    ...(typeof ctx.env?.internalHeaders === "function" ? ctx.env.internalHeaders() : {}),
    "x-avos-hop-count": String(nextHopCount),
    "x-naelao-user-id": ctx.env?.userId || initiatingUserId, // Cryptographic delegation chaining
  };

  // 6. Dispatch the sub-task to the target agent DO (via WsHub or Queues)
  // This notifies the target agent without executing it in the current turn.
  if (ctx.env?.queue?.send) {
    await ctx.env.queue.send({
      type: "DELEGATE_TURN",
      targetAgentId: targetRole,
      threadId: ctx.env.threadId,
      taskDescription,
      contextFiles,
      delegationToken: signedToken,
      hopCount: nextHopCount,
      outboundHeaders
    });
  }

  return {
    success: true,
    hop_level: nextHopCount,
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
