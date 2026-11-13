import type {
  AssistantMailMessage,
  ManagedServiceDashboard,
} from "@/lib/api";

export type UnifiedInboxSource = "assistant" | "agentmail";

export type UnifiedInboxMessage = {
  key: string;
  source: UnifiedInboxSource;
  scopeId: string;
  messageId: string;
  subject: string;
  sender: string;
  recipient: string;
  createdAt: string;
  summary: string;
  raw: Record<string, unknown>;
};

type ProviderRecord = Record<string, unknown>;

function asRecord(value: unknown): ProviderRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ProviderRecord)
    : null;
}

function text(record: ProviderRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number")
      return String(value);
  }
  return "";
}

function nestedMessage(record: ProviderRecord): ProviderRecord {
  for (const key of ["message", "data", "result"]) {
    const nested = asRecord(record[key]);
    if (nested) return nestedMessage(nested);
  }
  return record;
}

function providerMessages(value: unknown): ProviderRecord[] {
  const root = asRecord(value);
  if (!root) return [];
  for (const key of ["messages", "items", "results"]) {
    const list = root[key];
    if (Array.isArray(list))
      return list
        .map(asRecord)
        .filter((item): item is ProviderRecord => item !== null);
  }
  const data = asRecord(root.data);
  return data ? providerMessages(data) : [];
}

export function assistantInboxMessages(
  messages: AssistantMailMessage[],
  mailboxId: string
): UnifiedInboxMessage[] {
  return messages
    .filter((message) => typeof message.id === "string" && message.id.length > 0)
    .map((message) => ({
      key: `assistant:${encodeURIComponent(mailboxId)}:${encodeURIComponent(message.id)}`,
      source: "assistant",
      scopeId: mailboxId,
      messageId: message.id,
      subject: message.subject || "(no subject)",
      sender: message.sender || "",
      recipient: message.recipient || "",
      createdAt: message.created_at || "",
      summary: message.status || message.direction || "",
      raw: message as unknown as ProviderRecord,
    }));
}

export function agentMailInboxMessages(
  value: unknown,
  connectionId: string
): UnifiedInboxMessage[] {
  return providerMessages(value).flatMap((item) => {
    const message = nestedMessage(item);
    const messageId = text(message, "message_id", "messageId", "id");
    if (!messageId) return [];
    return [
      {
        key: `agentmail:${encodeURIComponent(connectionId)}:${encodeURIComponent(messageId)}`,
        source: "agentmail",
        scopeId: connectionId,
        messageId,
        subject: text(message, "subject", "preview", "snippet") || "(no subject)",
        sender: text(message, "from", "sender", "from_address"),
        recipient: text(message, "to", "recipient", "to_address"),
        createdAt: text(message, "created_at", "timestamp", "received_at"),
        summary: text(message, "status", "snippet", "preview"),
        raw: message,
      },
    ];
  });
}

export function agentMailPageCursor(value: unknown): string | null {
  const root = asRecord(value);
  if (!root) return null;
  const cursor = text(root, "next_page_token", "nextPageToken", "next_cursor");
  return cursor || null;
}

export function activeAgentMailAccounts(
  dashboard: ManagedServiceDashboard | null
): ManagedServiceDashboard["accounts"] {
  return (
    dashboard?.accounts.filter(
      (account) => account.provider === "agentmail" && account.status === "active"
    ) ?? []
  );
}

export function sortUnifiedInboxMessages(
  messages: UnifiedInboxMessage[]
): UnifiedInboxMessage[] {
  return [...messages].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime))
      return rightTime - leftTime;
    if (Number.isFinite(leftTime)) return -1;
    if (Number.isFinite(rightTime)) return 1;
    return left.key.localeCompare(right.key);
  });
}
