import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { OwnerVoiceTicket } from "./voice-ticket.js";
export interface VoiceTurnJournal {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<unknown>;
}
type Pending = {
  state: "dispatching" | "running" | "done";
  text: string;
  runId?: string;
  approvalId?: string;
  reply?: string;
  at: number;
};
/** One planner task at a time per voice session. Transport cancellation never retries a
 * possibly committed tool action. Unknown dispatch outcomes are held for app reconciliation. */
export class DurableVoiceTurns {
  private busy = false;
  private followup: DurableVoiceTurns | undefined;
  completionReady = false;
  private auxiliary() {
    if (!this.followup) {
      const journal = this.journal,
        worker = this.worker;
      this.followup = new DurableVoiceTurns(
        {
          get: <T>(key: string) => journal.get<T>("followup:" + key),
          put: <T>(key: string, value: T) =>
            journal.put("followup:" + key, value),
        },
        {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request =
              input instanceof Request ? input : new Request(input, init);
            if (
              request.method === "POST" &&
              new URL(request.url).pathname.endsWith("/run")
            ) {
              const headers = new Headers(request.headers);
              headers.set("x-naelao-voice-followup", "1");
              return worker.fetch(new Request(request, { headers }));
            }
            return worker.fetch(request);
          },
        } as Fetcher,
        this.secret,
        this.spacesWorker,
        false
      );
    }
    return this.followup;
  }
  constructor(
    private journal: VoiceTurnJournal,
    private worker: Fetcher,
    private secret: string,
    private spacesWorker?: Fetcher,
    private allowFollowup = true
  ) {}
  async ownsTask(id: string): Promise<boolean> {
    if ((await this.journal.get<Pending>("voice:pending"))?.runId === id)
      return true;
    return this.allowFollowup && (await this.auxiliary().ownsTask(id));
  }
  async pending(): Promise<boolean> {
    return (
      (await this.journal.get<Pending>("voice:pending"))?.state === "running" ||
      (this.allowFollowup && (await this.auxiliary().pending()))
    );
  }
  async resume(
    ticket: OwnerVoiceTicket,
    signal?: AbortSignal
  ): Promise<string> {
    this.completionReady = false;
    const pending = await this.journal.get<Pending>("voice:pending");
    if (pending?.state === "running") {
      const reply = await this.turn(ticket, pending.text, signal, true);
      this.completionReady =
        (await this.journal.get<Pending>("voice:pending"))?.state === "done";
      return reply;
    }
    if (this.allowFollowup) {
      const reply = await this.auxiliary().resume(ticket, signal);
      this.completionReady = this.auxiliary().completionReady;
      return reply;
    }
    return "";
  }
  async turn(
    ticket: OwnerVoiceTicket,
    transcript: string,
    signal?: AbortSignal,
    resumeOnly = false
  ): Promise<string> {
    const text = transcript.trim();
    if (!text || text.length > 2000)
      throw new Error("voice_transcript_invalid");
    const current = await this.journal.get<Pending>("voice:pending");
    const progress =
      /^(?:is it ready\??|status\??|any update\??|what(?:'s| is) the status\??|how is it going\??)$/i.test(
        text
      );
    if (
      this.allowFollowup &&
      !resumeOnly &&
      current?.state === "running" &&
      text !== current.text &&
      !progress
    )
      return this.auxiliary().turn(
        ticket,
        `Background task ${current.runId} continues. Answer this authenticated follow-up or steer its existing workers; do not restart that task.\n\n${text}`,
        signal
      );
    if (this.busy) return "Your previous request is still being processed.";
    this.busy = true;
    try {
      let pending = await this.journal.get<Pending>("voice:pending");
      if (resumeOnly && pending?.state !== "running") return "";
      if (pending?.state === "dispatching")
        return "I could not confirm whether that request started. Check this task in Naelao before retrying it.";
      if (
        pending?.state === "done" &&
        pending.text === text &&
        Date.now() - pending.at < 10000
      )
        return pending.reply!;
      const base = `http://agents-worker/spaces/${encodeURIComponent(ticket.spaceId)}/sessions/${encodeURIComponent(ticket.sessionId)}/agent`;
      const headers = {
        "content-type": "application/json",
        "x-naelao-tenant-id": ticket.tenantId,
        "x-naelao-user-id": ticket.userId,
        "x-naelao-role": ticket.callerRole,
        "x-naelao-internal-token": await mintInternalToken(
          this.secret,
          ticket.tenantId
        ),
      };
      if (!pending || pending.state === "done") {
        if (signal?.aborted) throw new Error("voice_turn_cancelled");
        pending = { state: "dispatching", text, at: Date.now() };
        await this.journal.put("voice:pending", pending);
        if (this.spacesWorker) {
          const saved = await this.spacesWorker.fetch(
            new Request(
              `http://spaces/spaces/${encodeURIComponent(ticket.spaceId)}/sessions/${encodeURIComponent(ticket.sessionId)}/messages`,
              {
                method: "POST",
                headers,
                signal: AbortSignal.timeout(10000),
                body: JSON.stringify({
                  role: "user",
                  content: text,
                  client_message_id: "voice-" + crypto.randomUUID(),
                }),
              }
            )
          );
          if (!saved.ok) throw new Error("voice_transcript_save_unconfirmed");
        }
        // Deliberately do not abort dispatch when the caller interrupts: it may have committed.
        const launched = await this.worker.fetch(
          new Request(base + "/run", {
            method: "POST",
            headers: {
              ...headers,
              prefer: "respond-async",
              "x-naelao-durable-voice": "1",
            },
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({
              goal: text,
              ...(ticket.projectId ? { project_id: ticket.projectId } : {}),
            }),
          })
        );
        if (!launched.ok)
          throw new Error(`voice_dispatch_held_${launched.status}`);
        const result = await readBoundedResponseJson<{ run_id?: string }>(
          launched,
          16384
        );
        if (!result.run_id || !/^[-A-Za-z0-9._:]{1,160}$/.test(result.run_id))
          throw new Error("voice_dispatch_receipt_unknown");
        pending = { ...pending, state: "running", runId: result.run_id };
        await this.journal.put("voice:pending", pending);
      }
      // Bound each spoken turn. Slow work continues in the existing durable task while the
      // caller can ask for progress/reconnect to the same voice session.
      for (let n = 0; n < 12; n++) {
        if (signal?.aborted) throw new Error("voice_turn_cancelled");
        let run: {
          status?: string;
          final_answer?: string;
          pending_approval?: unknown;
          pending_question?: unknown;
        };
        if (pending.approvalId) {
          const response = await this.worker.fetch(
            new Request(
              base.replace(/\/agent$/, "/approvals/") +
                encodeURIComponent(pending.approvalId),
              {
                headers,
                signal: signal
                  ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
                  : AbortSignal.timeout(5000),
              }
            )
          );
          if (!response.ok)
            throw new Error("voice_approval_status_unavailable");
          const approval = await readBoundedResponseJson<{
            status?: string;
            resumed_run?: typeof run;
          }>(response, 262144);
          if (["rejected", "timeout"].includes(approval.status ?? "")) {
            const reply =
              "That action was not authorized. The task’s saved progress is available in Naelao.";
            await this.journal.put("voice:pending", {
              ...pending,
              state: "done",
              reply,
              at: Date.now(),
            });
            return reply;
          }
          if (!approval.resumed_run)
            return "The task is waiting for authorized input or its saved continuation. You can keep talking while it waits.";
          run = approval.resumed_run;
        } else {
          const response = await this.worker.fetch(
            new Request(base + "/runs/" + encodeURIComponent(pending.runId!), {
              headers,
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
                : AbortSignal.timeout(5000),
            })
          );
          if (!response.ok)
            throw new Error(`voice_task_status_unavailable_${response.status}`);
          run = await readBoundedResponseJson<typeof run>(response, 262144);
        }
        if (
          run.pending_approval ||
          run.pending_question ||
          run.status === "awaiting_approval"
        ) {
          const approval = (run.pending_approval ?? run.pending_question) as
            | { approval_id?: string }
            | undefined;
          if (approval?.approval_id) {
            pending = { ...pending, approvalId: approval.approval_id };
            await this.journal.put("voice:pending", pending);
          }
          return "I need your input or approval. Use the authenticated approval card in Naelao or your verified messaging channel; I can keep this call open.";
        }
        if (run.status === "completed" || run.status === "failed") {
          const reply =
            run.status === "completed"
              ? run.final_answer?.trim().slice(0, 4000) ||
                "The task completed. Its result is saved in Naelao."
              : "The task stopped with an error. Check its saved progress in Naelao before retrying.";
          await this.journal.put("voice:pending", {
            ...pending,
            state: "done",
            reply,
            at: Date.now(),
          });
          return reply;
        }
        if (n < 11) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return "I’m still working on your request. Your progress is saved; ask me for an update shortly or return to the task in Naelao.";
    } finally {
      this.busy = false;
    }
  }
}
