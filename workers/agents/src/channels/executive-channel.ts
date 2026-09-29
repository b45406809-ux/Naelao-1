export const EXECUTIVE_STOP_WORDS = new Set(["STOP", "PANIC", "HALT"]);
export const EMERGENCY_STOP_CONFIRMATION = "All autonomous operations halted.";

export interface ExecutiveInbound {
  spaceId: string;
  tenantId: string;
  channel: "whatsapp" | "telegram";
  senderId: string;
  text: string;
}

export interface ExecutiveChannelServices {
  verify(
    input: Pick<
      ExecutiveInbound,
      "spaceId" | "tenantId" | "channel" | "senderId"
    >
  ): Promise<boolean>;
  freeze(input: Pick<ExecutiveInbound, "spaceId" | "tenantId">): Promise<void>;
  /** RiskGuard fan-out aborts pending orders and liquidates open positions. */
  abortPendingOrders?(input: Pick<ExecutiveInbound, "spaceId" | "tenantId">): Promise<void>;
  routeToRootAssistant(input: ExecutiveInbound): Promise<void>;
  send(
    input: Pick<ExecutiveInbound, "channel" | "senderId"> & { text: string }
  ): Promise<void>;
}

/** Returns false for public callers so the quarantined customer path can handle them. */
export async function handleExecutiveInbound(
  input: ExecutiveInbound,
  services: ExecutiveChannelServices
): Promise<{ handled: boolean; emergencyStopped: boolean; freezeMs?: number }> {
  if (!(await services.verify(input)))
    return { handled: false, emergencyStopped: false };
  const command = input.text.trim().toUpperCase();
  if (EXECUTIVE_STOP_WORDS.has(command)) {
    const started = performance.now();
    await Promise.all([services.freeze(input), services.abortPendingOrders?.(input)]);
    const freezeMs = performance.now() - started;
    if (freezeMs >= 500) throw new Error(`emergency_freeze_deadline_exceeded:${Math.round(freezeMs)}ms`);
    await services.send({
      channel: input.channel,
      senderId: input.senderId,
      text: EMERGENCY_STOP_CONFIRMATION,
    });
    return { handled: true, emergencyStopped: true, freezeMs };
  }
  await services.routeToRootAssistant(input);
  return { handled: true, emergencyStopped: false };
}
