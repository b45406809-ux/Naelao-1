"use client";

import * as React from "react";
import { Button, FormInput, FormSelect } from "@naelao/ui";
import {
  assistantMailApi,
  assistantMailAttachment,
  listProjects,
  type AssistantMailAttachment,
  type AssistantMailMessage,
  type ManagedServiceDashboard,
  type Project,
  type SessionCredentials,
} from "@/lib/api";
import { normalizeManagedServiceAttachment } from "@/lib/managed-service-attachments";
import {
  activeAgentMailAccounts,
  agentMailInboxMessages,
  agentMailPageCursor,
  assistantInboxMessages,
  sortUnifiedInboxMessages,
  type UnifiedInboxMessage,
  type UnifiedInboxSource,
} from "@/lib/unified-inbox";

type ProviderRecord = Record<string, unknown>;
type SourcePage = {
  data: AssistantMailMessage[];
  next_cursor: string | null;
};
type ProviderPage = { result?: unknown };
type MessageDetail = {
  key: string;
  body: string;
  providerMessage: unknown;
  assistantAttachments: AssistantMailAttachment[];
  agentMailAttachments: ProviderRecord[];
};

function asRecord(value: unknown): ProviderRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ProviderRecord)
    : null;
}

function nestedMessage(value: unknown): ProviderRecord {
  const record = asRecord(value) ?? {};
  for (const key of ["message", "data", "result"]) {
    const nested = asRecord(record[key]);
    if (nested) return nestedMessage(nested);
  }
  return record;
}

function providerAttachments(value: unknown): ProviderRecord[] {
  const message = nestedMessage(value);
  return Array.isArray(message.attachments)
    ? message.attachments
        .map(asRecord)
        .filter((item): item is ProviderRecord => item !== null)
    : [];
}

function providerText(record: ProviderRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number")
      return String(value);
  }
  return "";
}

export function UnifiedInboxSearchPanel({
  spaceId,
  session,
}: {
  spaceId: string;
  session: SessionCredentials;
}) {
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [accounts, setAccounts] = React.useState<ManagedServiceDashboard["accounts"]>([]);
  const [projectId, setProjectId] = React.useState("");
  const [connectionId, setConnectionId] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [submittedQuery, setSubmittedQuery] = React.useState("");
  const [searched, setSearched] = React.useState(false);
  const [assistantMessages, setAssistantMessages] = React.useState<UnifiedInboxMessage[]>([]);
  const [agentMailMessages, setAgentMailMessages] = React.useState<UnifiedInboxMessage[]>([]);
  const [assistantCursor, setAssistantCursor] = React.useState<string | null>(null);
  const [agentMailCursor, setAgentMailCursor] = React.useState<string | null>(null);
  const [assistantError, setAssistantError] = React.useState("");
  const [agentMailError, setAgentMailError] = React.useState("");
  const [setupError, setSetupError] = React.useState("");
  const [assistantBusy, setAssistantBusy] = React.useState(false);
  const [agentMailBusy, setAgentMailBusy] = React.useState(false);
  const [detailBusy, setDetailBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<UnifiedInboxMessage | null>(null);
  const [detail, setDetail] = React.useState<MessageDetail | null>(null);
  const [detailError, setDetailError] = React.useState("");
  const [attachmentBusy, setAttachmentBusy] = React.useState("");
  const [agentAttachment, setAgentAttachment] = React.useState<unknown>(null);
  const epoch = React.useRef(0);

  const activeAccounts = React.useMemo(
    () => activeAgentMailAccounts({ accounts } as ManagedServiceDashboard),
    [accounts]
  );
  const selectedAccount = activeAccounts.find(
    (account) => account.id === connectionId
  );
  const mailboxId = projectId ? `project:${projectId}` : `space:${spaceId}`;

  React.useEffect(() => {
    let live = true;
    setSetupError("");
    setProjects([]);
    setAccounts([]);
    setProjectId("");
    setConnectionId("");
    clearResults();
    Promise.allSettled([
      listProjects(spaceId, session),
      assistantMailApi<ManagedServiceDashboard>(spaceId, session, {
        action: "managed-service-dashboard",
      }),
    ])
      .then(([projectResult, dashboardResult]) => {
        if (!live) return;
        if (projectResult.status === "fulfilled")
          setProjects(projectResult.value);
        if (dashboardResult.status === "fulfilled") {
          setAccounts(dashboardResult.value.accounts);
        } else {
          const failure = dashboardResult.reason;
          setSetupError(
            failure instanceof Error
              ? failure.message
              : "AgentMail connections are unavailable"
          );
        }
      });
    return () => {
      live = false;
      epoch.current++;
    };
  }, [spaceId, session]);

  function clearResults() {
    epoch.current++;
    setSubmittedQuery("");
    setSearched(false);
    setAssistantMessages([]);
    setAgentMailMessages([]);
    setAssistantCursor(null);
    setAgentMailCursor(null);
    setAssistantError("");
    setAgentMailError("");
    setAssistantBusy(false);
    setAgentMailBusy(false);
    setDetailBusy(false);
    setAttachmentBusy("");
    setSelected(null);
    setDetail(null);
    setDetailError("");
    setAgentAttachment(null);
  }

  function changeProject(nextProjectId: string) {
    clearResults();
    setProjectId(nextProjectId);
  }

  function changeConnection(nextConnectionId: string) {
    clearResults();
    setConnectionId(nextConnectionId);
  }

  async function callAgentMail(
    account: ManagedServiceDashboard["accounts"][number],
    operation: string,
    args: Record<string, unknown>
  ) {
    const response = await assistantMailApi<ProviderPage>(
      spaceId,
      session,
      {
        action: "agentmail-operation",
        ...(account.projectId ? { projectId: account.projectId } : {}),
        connection_id: account.id,
        operation,
        args,
      },
      true
    );
    return response.result;
  }

  async function search(event?: React.FormEvent) {
    event?.preventDefault();
    if (!selectedAccount) return;
    const requestEpoch = ++epoch.current;
    const searchText = query.trim();
    setSearched(true);
    setSubmittedQuery(searchText);
    setAssistantMessages([]);
    setAgentMailMessages([]);
    setAssistantCursor(null);
    setAgentMailCursor(null);
    setAssistantError("");
    setAgentMailError("");
    setSelected(null);
    setDetail(null);
    setDetailError("");
    setAssistantBusy(true);
    setAgentMailBusy(true);

    const assistantRequest = assistantMailApi<SourcePage>(spaceId, session, {
      action: "messages",
      ...(projectId ? { projectId } : {}),
      query: searchText,
    });
    const agentMailRequest = callAgentMail(
      selectedAccount,
      searchText ? "agentmail.search" : "agentmail.inbox",
      { limit: 20, ...(searchText ? { query: searchText } : {}) }
    );
    const [assistantResult, agentMailResult] = await Promise.allSettled([
      assistantRequest,
      agentMailRequest,
    ]);

    if (requestEpoch !== epoch.current) return;
    if (assistantResult.status === "fulfilled") {
      setAssistantMessages(
        assistantInboxMessages(assistantResult.value.data, mailboxId)
      );
      setAssistantCursor(assistantResult.value.next_cursor);
    } else {
      setAssistantError(
        assistantResult.reason instanceof Error
          ? assistantResult.reason.message
          : "Assistant inbox search failed"
      );
    }
    if (agentMailResult.status === "fulfilled") {
      setAgentMailMessages(
        agentMailInboxMessages(agentMailResult.value, selectedAccount.id)
      );
      setAgentMailCursor(agentMailPageCursor(agentMailResult.value));
    } else {
      setAgentMailError(
        agentMailResult.reason instanceof Error
          ? agentMailResult.reason.message
          : "AgentMail search failed"
      );
    }
    setAssistantBusy(false);
    setAgentMailBusy(false);
  }

  async function loadMore(source: UnifiedInboxSource) {
    if (!selectedAccount) return;
    const cursor = source === "assistant" ? assistantCursor : agentMailCursor;
    if (!cursor) return;
    const requestEpoch = epoch.current;
    if (source === "assistant") {
      if (assistantBusy) return;
      setAssistantBusy(true);
      setAssistantError("");
      try {
        const page = await assistantMailApi<SourcePage>(spaceId, session, {
          action: "messages",
          ...(projectId ? { projectId } : {}),
          query: submittedQuery,
          cursor,
        });
        if (requestEpoch !== epoch.current) return;
        setAssistantMessages((current) => {
          const known = new Set(current.map((message) => message.key));
          return [
            ...current,
            ...assistantInboxMessages(page.data, mailboxId).filter(
              (message) => !known.has(message.key)
            ),
          ];
        });
        setAssistantCursor(page.next_cursor);
      } catch (failure) {
        if (requestEpoch === epoch.current)
          setAssistantError(
            failure instanceof Error
              ? failure.message
              : "Assistant inbox page failed"
          );
      } finally {
        if (requestEpoch === epoch.current) setAssistantBusy(false);
      }
      return;
    }

    if (agentMailBusy) return;
    setAgentMailBusy(true);
    setAgentMailError("");
    try {
      const page = await callAgentMail(
        selectedAccount,
        submittedQuery ? "agentmail.search" : "agentmail.inbox",
        {
          limit: 20,
          ...(submittedQuery ? { query: submittedQuery } : {}),
          page_token: cursor,
        }
      );
      if (requestEpoch !== epoch.current) return;
      setAgentMailMessages((current) => {
        const known = new Set(current.map((message) => message.key));
        return [
          ...current,
          ...agentMailInboxMessages(page, selectedAccount.id).filter(
            (message) => !known.has(message.key)
          ),
        ];
      });
      setAgentMailCursor(agentMailPageCursor(page));
    } catch (failure) {
      if (requestEpoch === epoch.current)
        setAgentMailError(
          failure instanceof Error
            ? failure.message
            : "AgentMail inbox page failed"
        );
    } finally {
      if (requestEpoch === epoch.current) setAgentMailBusy(false);
    }
  }

  async function readMessage(message: UnifiedInboxMessage) {
    const requestEpoch = epoch.current;
    setSelected(message);
    setDetail(null);
    setDetailError("");
    setAgentAttachment(null);
    setDetailBusy(true);
    try {
      if (message.source === "assistant") {
        const response = await assistantMailApi<{
          body?: { text?: string; attachments?: AssistantMailAttachment[] };
        }>(spaceId, session, {
          action: "message",
          ...(projectId ? { projectId } : {}),
          id: message.messageId,
        });
        if (requestEpoch !== epoch.current) return;
        setDetail({
          key: message.key,
          body: response.body?.text ?? "",
          providerMessage: null,
          assistantAttachments: Array.isArray(response.body?.attachments)
            ? response.body.attachments
            : [],
          agentMailAttachments: [],
        });
      } else {
        if (!selectedAccount || selectedAccount.id !== message.scopeId)
          throw new Error("Select the active AgentMail connection again");
        const response = await callAgentMail(selectedAccount, "agentmail.read", {
          messageId: message.messageId,
        });
        if (requestEpoch !== epoch.current) return;
        const messageRecord = nestedMessage(response);
        setDetail({
          key: message.key,
          body: "",
          providerMessage: messageRecord,
          assistantAttachments: [],
          agentMailAttachments: providerAttachments(messageRecord),
        });
      }
    } catch (failure) {
      if (requestEpoch === epoch.current)
        setDetailError(
          failure instanceof Error ? failure.message : "Message is unavailable"
        );
    } finally {
      if (requestEpoch === epoch.current) setDetailBusy(false);
    }
  }

  async function downloadAssistantAttachment(attachment: AssistantMailAttachment) {
    if (!selected || selected.source !== "assistant") return;
    const attachmentEpoch = epoch.current;
    setAttachmentBusy(attachment.id);
    setDetailError("");
    try {
      const blob = await assistantMailAttachment(spaceId, session, {
        messageId: selected.messageId,
        attachmentId: attachment.id,
        ...(projectId ? { projectId } : {}),
      });
      if (attachmentEpoch !== epoch.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setDetailError(
        failure instanceof Error ? failure.message : "Attachment is unavailable"
      );
    } finally {
      setAttachmentBusy("");
    }
  }

  async function retrieveAgentMailAttachment(
    attachment: ProviderRecord,
    index: number
  ) {
    if (!selected || selected.source !== "agentmail" || !selectedAccount) return;
    const attachmentId = providerText(
      attachment,
      "attachment_id",
      "attachmentId",
      "id"
    );
    if (!attachmentId) return;
    const attachmentEpoch = epoch.current;
    setAttachmentBusy(attachmentId);
    setDetailError("");
    try {
      const result = await callAgentMail(
        selectedAccount,
        "agentmail.attachment",
        { messageId: selected.messageId, attachmentId }
      );
      if (attachmentEpoch !== epoch.current) return;
      setAgentAttachment({ key: `${selected.key}:${attachmentId}:${index}`, result });
    } catch (failure) {
      setDetailError(
        failure instanceof Error ? failure.message : "Attachment is unavailable"
      );
    } finally {
      setAttachmentBusy("");
    }
  }

  const results = sortUnifiedInboxMessages([
    ...assistantMessages,
    ...agentMailMessages,
  ]);
  const normalizedAgentAttachment = normalizeManagedServiceAttachment(
    asRecord(agentAttachment)?.result
  );

  return (
    <section className="settings-section">
      <h3>Search both inboxes</h3>
      <p className="settings-row-sub">
        Results are combined in this page only. Each source keeps its own page
        cursor, and opening a message or attachment uses that source&apos;s existing
        authorized API.
      </p>
      {setupError && <p role="status">{setupError}</p>}
      <div style={{ display: "grid", gap: 8, maxWidth: 620 }}>
        <FormSelect
          aria-label="Assistant mailbox"
          value={projectId}
          onChange={(event) => changeProject(event.target.value)}
        >
          <option value="">Space assistant</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name} assistant
            </option>
          ))}
        </FormSelect>
        <FormSelect
          aria-label="Active AgentMail connection"
          value={connectionId}
          onChange={(event) => changeConnection(event.target.value)}
        >
          <option value="">Select an active AgentMail connection</option>
          {activeAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.projectId ? `Project ${account.projectId}` : "Space inbox"}
              {` · ${account.connectionMode} · ${account.id.slice(-8)}`}
            </option>
          ))}
        </FormSelect>
        <form
          style={{ display: "flex", gap: 8 }}
          onSubmit={(event) => void search(event)}
        >
          <FormInput
            aria-label="Search both inboxes"
            placeholder="Search messages, or leave empty to list recent mail"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            size="sm"
            type="submit"
            disabled={!selectedAccount || assistantBusy || agentMailBusy}
          >
            {assistantBusy || agentMailBusy ? "Searching…" : "Search"}
          </Button>
        </form>
      </div>
      {!activeAccounts.length && !setupError && (
        <p className="settings-row-sub">
          No active AgentMail connection is available to select.
        </p>
      )}
      <div style={{ display: "grid", gap: 4, marginTop: 12 }}>
        {results.map((message) => (
          <button
            key={message.key}
            type="button"
            onClick={() => void readMessage(message)}
            disabled={detailBusy}
            style={{ textAlign: "left", padding: 8 }}
          >
            <span className="settings-row-label">
              {message.source === "assistant" ? "Assistant" : "AgentMail"}
              {" · "}
              {message.subject}
            </span>
            <span className="settings-row-sub" style={{ display: "block" }}>
              {message.sender || "Unknown sender"}
              {message.createdAt ? ` · ${message.createdAt}` : ""}
            </span>
          </button>
        ))}
        {assistantError && <p role="status">Assistant inbox: {assistantError}</p>}
        {agentMailError && <p role="status">AgentMail: {agentMailError}</p>}
        {!results.length && searched && !assistantBusy && !agentMailBusy && !assistantError && !agentMailError && (
          <p className="settings-row-sub">No matching messages.</p>
        )}
        {!results.length && !searched && !assistantBusy && !agentMailBusy && !assistantError && !agentMailError && (
          <p className="settings-row-sub">Choose an AgentMail connection, then search to load recent messages.</p>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {assistantCursor && (
          <Button
            size="sm"
            disabled={assistantBusy}
            onClick={() => void loadMore("assistant")}
          >
            {assistantBusy ? "Loading Assistant…" : "More Assistant results"}
          </Button>
        )}
        {agentMailCursor && (
          <Button
            size="sm"
            disabled={agentMailBusy}
            onClick={() => void loadMore("agentmail")}
          >
            {agentMailBusy ? "Loading AgentMail…" : "More AgentMail results"}
          </Button>
        )}
      </div>
      {selected && (
        <div className="settings-block" style={{ marginTop: 12 }}>
          <div className="settings-row-label">
            {selected.source === "assistant" ? "Assistant message" : "AgentMail message"}
            {" · "}
            {selected.subject}
          </div>
          {detailBusy && <p className="settings-row-sub">Loading message…</p>}
          {detailError && <p role="status">{detailError}</p>}
          {detail?.key === selected.key && selected.source === "assistant" && (
            <>
              <pre style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {detail.body}
              </pre>
              {detail.assistantAttachments.map((attachment) => (
                <div key={attachment.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span>{attachment.filename}</span>
                  <Button
                    size="sm"
                    disabled={attachmentBusy === attachment.id}
                    onClick={() => void downloadAssistantAttachment(attachment)}
                  >
                    {attachmentBusy === attachment.id ? "Retrieving…" : "Download"}
                  </Button>
                </div>
              ))}
            </>
          )}
          {detail?.key === selected.key && selected.source === "agentmail" && (
            <>
              <pre style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {JSON.stringify(detail.providerMessage, null, 2).slice(0, 12000)}
              </pre>
              {detail.agentMailAttachments.map((attachment, index) => {
                const id = providerText(attachment, "attachment_id", "attachmentId", "id");
                return (
                  <div key={`${id || "attachment"}-${index}`} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span>{providerText(attachment, "filename", "name") || `Attachment ${index + 1}`}</span>
                    <Button
                      size="sm"
                      disabled={!id || attachmentBusy === id}
                      onClick={() => void retrieveAgentMailAttachment(attachment, index)}
                    >
                      {attachmentBusy === id ? "Retrieving…" : "Get link"}
                    </Button>
                  </div>
                );
              })}
              {normalizedAgentAttachment && (
                <div className="settings-block" style={{ marginTop: 8 }}>
                  <div className="settings-row-label">{normalizedAgentAttachment.filename}</div>
                  <p className="settings-row-sub">
                    {normalizedAgentAttachment.contentType ?? "Unknown content type"}
                    {normalizedAgentAttachment.sizeBytes === null
                      ? " · Unknown size"
                      : ` · ${(normalizedAgentAttachment.sizeBytes / 1024).toFixed(1)} KiB`}
                  </p>
                  {normalizedAgentAttachment.tooLarge ? (
                    <p className="settings-row-sub">This attachment exceeds the 20 MiB download limit.</p>
                  ) : normalizedAgentAttachment.expired ? (
                    <p className="settings-row-sub">This signed link expired. Retrieve the attachment again for a fresh link.</p>
                  ) : normalizedAgentAttachment.downloadUrl ? (
                    <a href={normalizedAgentAttachment.downloadUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
                      Open attachment
                    </a>
                  ) : (
                    <p className="settings-row-sub">A safe current download link is unavailable.</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
