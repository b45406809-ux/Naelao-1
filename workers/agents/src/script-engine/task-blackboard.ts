import { verifyDelegationContract, type DelegationContract } from "./delegation-contract.js";

/** Messages are untrusted task data. */
export type TaskMessageKind = "finding" | "artifact" | "question" | "blocker" | "risk" | "completion" | "verification";
export interface TaskMessage {
  id: string;
  sender: string;
  recipients: string[];
  kind: TaskMessageKind;
  text: string;
  createdAt: number;
}

const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const kinds = new Set<TaskMessageKind>(["finding", "artifact", "question", "blocker", "risk", "completion", "verification"]);

/** The caller must supply the sender from its verified delegation, never from message content. */
export function createTaskMessage(input: { id: unknown; recipients: unknown; kind: unknown; text: unknown }, sender: string, members: ReadonlySet<string>, now: number): TaskMessage {
  if (!identifier(sender) || !members.has(sender)) throw new Error("task_blackboard_sender_denied");
  if (!identifier(input.id) || !Array.isArray(input.recipients) || input.recipients.length < 1 || input.recipients.length > 12
      || input.recipients.some(recipient => !identifier(recipient) || !members.has(recipient))
      || new Set(input.recipients).size !== input.recipients.length) throw new Error("task_blackboard_recipients_invalid");
  if (typeof input.kind !== "string" || !kinds.has(input.kind as TaskMessageKind)) throw new Error("task_blackboard_kind_invalid");
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 4000 || !Number.isSafeInteger(now) || now < 0) throw new Error("task_blackboard_message_invalid");
  return { id: input.id, sender, recipients: [...input.recipients] as string[], kind: input.kind as TaskMessageKind, text: input.text, createdAt: now };
}

/** Apply after authenticating task membership; no implicit all-worker broadcast. */
export function visibleTaskMessages(messages: readonly TaskMessage[], actor: string, members: ReadonlySet<string>): TaskMessage[] {
  if (!identifier(actor) || !members.has(actor)) throw new Error("task_blackboard_reader_denied");
  return messages.filter(message => message.sender === actor || message.recipients.includes(actor)).map(message => ({ ...message, recipients: [...message.recipients] }));
}

/**
 * Called only after the host verifies the signed delegation contract. The scope must come
 * from the durable goal journal, not from a worker request. Edges are directed: a sender
 * may address only recipients explicitly granted by the host's task plan.
 */
export function authorizeTaskMessaging(
  identity: { tenantId: string; spaceId: string; projectId?: string; rootRunId: string; parentDoId: string; workerId: string },
  scope: { tenantId: string; spaceId: string; projectId?: string; rootRunId: string; parentDoId: string; members: ReadonlySet<string>; recipientGrants: ReadonlyMap<string, ReadonlySet<string>> },
  recipients: readonly string[],
): void {
  if (!identity.tenantId || !identity.spaceId || !identity.rootRunId || !identity.parentDoId
      || identity.tenantId !== scope.tenantId || identity.spaceId !== scope.spaceId
      || (identity.projectId ?? null) !== (scope.projectId ?? null)
      || identity.rootRunId !== scope.rootRunId || identity.parentDoId !== scope.parentDoId
      || !scope.members.has(identity.workerId)) throw new Error("task_blackboard_scope_denied");
  const grants = scope.recipientGrants.get(identity.workerId);
  if (!recipients.length || recipients.some(recipient => !scope.members.has(recipient) || !grants?.has(recipient)))
    throw new Error("task_blackboard_recipient_denied");
}

export interface TaskBlackboardScope {
  tenantId: string; spaceId: string; projectId?: string; rootRunId: string; parentDoId: string;
  members: ReadonlySet<string>; recipientGrants: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The host must bind this store instance to one durable goal, not a caller-supplied key. */
export interface TaskMessageStore {
  transact<T>(operation: (messages: TaskMessage[]) => { messages: TaskMessage[]; result: T }): Promise<T>;
}

async function authenticateTaskWorker(contract: DelegationContract, token: string, secret: string, scope: TaskBlackboardScope): Promise<void> {
  await verifyDelegationContract(contract, token, secret);
  if (!contract.tenantId || !contract.spaceId || !contract.rootRunId || !contract.parentDoId
      || contract.tenantId !== scope.tenantId || contract.spaceId !== scope.spaceId
      || (contract.projectId ?? null) !== (scope.projectId ?? null) || contract.rootRunId !== scope.rootRunId
      || contract.parentDoId !== scope.parentDoId || !scope.members.has(contract.workerId)) throw new Error("task_blackboard_scope_denied");
}

export async function appendAuthenticatedTaskMessage(params: {
  contract: DelegationContract; token: string; secret: string; scope: TaskBlackboardScope; store: TaskMessageStore;
  input: { id: unknown; recipients: unknown; kind: unknown; text: unknown }; now: number;
}): Promise<TaskMessage> {
  const { contract, scope, input } = params;
  await authenticateTaskWorker(contract, params.token, params.secret, scope);
  const message = createTaskMessage(input, contract.workerId, scope.members, params.now);
  authorizeTaskMessaging(contract, scope, message.recipients);
  return params.store.transact(messages => {
    const existing = messages.find(item => item.id === message.id);
    if (existing) {
      if (existing.sender !== message.sender || existing.kind !== message.kind || existing.text !== message.text
          || JSON.stringify(existing.recipients) !== JSON.stringify(message.recipients)) throw new Error("task_blackboard_id_conflict");
      return { messages, result: existing };
    }
    if (messages.length >= 500) throw new Error("task_blackboard_capacity_exceeded");
    return { messages: [...messages, message], result: message };
  });
}

export async function readAuthenticatedTaskMessages(params: {
  contract: DelegationContract; token: string; secret: string; scope: TaskBlackboardScope; store: TaskMessageStore;
}): Promise<TaskMessage[]> {
  await authenticateTaskWorker(params.contract, params.token, params.secret, params.scope);
  return params.store.transact(messages => ({ messages, result: visibleTaskMessages(messages, params.contract.workerId, params.scope.members) }));
}
