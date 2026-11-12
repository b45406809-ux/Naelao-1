export interface AgentPortEventSubscriptionIdentity {
  subscriptionId: string;
  agentId: string;
  accountId: string | null;
  serviceId: string;
}

export interface AgentPortSubscriptionState extends AgentPortEventSubscriptionIdentity {
  status: string;
}

/** A queued reference is usable only while every immutable subscription identity still matches. */
export function isCurrentAgentPortSubscription(
  event: AgentPortEventSubscriptionIdentity,
  current: AgentPortSubscriptionState | null | undefined,
): boolean {
  return !!current && current.status === "active" && current.subscriptionId === event.subscriptionId
    && current.agentId === event.agentId && current.accountId === event.accountId && current.serviceId === event.serviceId;
}

/** AgentPort IDs are never interpreted as NaelaoAgentDO runtime IDs. */
export function providerEventRuntimeAgentId(): "naelao-agent" {
  return "naelao-agent";
}
