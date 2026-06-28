// G-W01..W08: <naelao-chat> — zero-dependency embeddable chat web component.
// Usage: <script src="naelao-chat.js"></script>
//        <naelao-chat space-id="spc_xxx" api-url="https://api.naelao.com"></naelao-chat>
// Target: < 10KB gzipped. No React, no dependencies.

interface NaelaoChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface AgentRunResponse {
  id: string;
  status?: string;
  final_answer?: string;
  error?: string;
}

type RunStatus = "idle" | "loading" | "streaming";

const WIDGET_CSS = `
:host { display: block; font-family: system-ui, sans-serif; }
* { box-sizing: border-box; }

.widget-btn {
  position: fixed; bottom: 20px; right: 20px; z-index: 99998;
  width: 52px; height: 52px; border-radius: 50%;
  background: #4f46e5; color: #fff; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 14px rgba(79,70,229,.4);
  transition: transform .15s, box-shadow .15s;
}
.widget-btn:hover { transform: scale(1.07); box-shadow: 0 6px 18px rgba(79,70,229,.5); }
.widget-btn svg { width: 24px; height: 24px; }

.panel {
  position: fixed; bottom: 84px; right: 20px; z-index: 99999;
  width: 360px; max-width: calc(100vw - 40px);
  height: 520px; max-height: calc(100vh - 120px);
  background: #fff; border-radius: 16px;
  box-shadow: 0 8px 40px rgba(0,0,0,.18);
  display: flex; flex-direction: column; overflow: hidden;
  transition: opacity .2s, transform .2s;
}
.panel[hidden] { display: none; }

.header {
  flex-shrink: 0; padding: 12px 16px;
  background: #4f46e5; color: #fff;
  display: flex; align-items: center; gap: 10px;
}
.header-icon { width: 28px; height: 28px; border-radius: 8px; background: rgba(255,255,255,.2); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.header-icon svg { width:16px; height:16px; }
.header-title { flex:1; font-size:14px; font-weight:600; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.close-btn { background:none; border:none; color:rgba(255,255,255,.8); cursor:pointer; padding:2px; border-radius:4px; display:flex; align-items:center; justify-content:center; }
.close-btn:hover { color:#fff; background:rgba(255,255,255,.15); }
.close-btn svg { width:18px; height:18px; }

.messages { flex:1; overflow-y:auto; padding:12px 14px; display:flex; flex-direction:column; gap:8px; }
.msg-user { align-self: flex-end; max-width: 80%; background:#4f46e5; color:#fff; padding:8px 12px; border-radius:14px 14px 2px 14px; font-size:13px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
.msg-bot { align-self: flex-start; max-width: 80%; display:flex; gap:8px; align-items:flex-end; }
.bot-avatar { width:24px; height:24px; border-radius:50%; background:#e0e7ff; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.bot-avatar svg { width:14px; height:14px; color:#4f46e5; }
.bot-bubble { background:#f3f4f6; color:#111; padding:8px 12px; border-radius:14px 14px 14px 2px; font-size:13px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
.bot-bubble.streaming::after { content:'▌'; animation: blink .7s step-end infinite; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
.typing { display:flex; gap:4px; padding:8px 12px; background:#f3f4f6; border-radius:14px 14px 14px 2px; }
.typing-dot { width:6px; height:6px; border-radius:50%; background:#9ca3af; animation: bounce 1.2s ease-in-out infinite; }
.typing-dot:nth-child(2){animation-delay:.2s;}
.typing-dot:nth-child(3){animation-delay:.4s;}
@keyframes bounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}
.error-msg { align-self:stretch; font-size:12px; color:#dc2626; background:#fef2f2; padding:6px 10px; border-radius:8px; border:1px solid #fecaca; }
.empty { flex:1; display:flex; align-items:center; justify-content:center; color:#9ca3af; font-size:13px; text-align:center; padding:20px; }

.input-area { flex-shrink:0; padding:10px 12px; border-top:1px solid #f3f4f6; display:flex; gap:8px; align-items:flex-end; }
.input-area textarea { flex:1; border:1px solid #e5e7eb; border-radius:10px; padding:8px 12px; font-size:13px; line-height:1.4; resize:none; outline:none; font-family:inherit; background:#f9fafb; min-height:36px; max-height:100px; }
.input-area textarea:focus { border-color:#6366f1; background:#fff; }
.send-btn { width:36px; height:36px; border-radius:10px; background:#4f46e5; border:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:background .15s; }
.send-btn:hover:not(:disabled) { background:#4338ca; }
.send-btn:disabled { opacity:.4; cursor:not-allowed; }
.send-btn svg { width:16px; height:16px; }
.branding { flex-shrink:0; text-align:center; font-size:10px; color:#d1d5db; padding:4px 0 6px; }
`;

const SVG_BOT = `<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clip-rule="evenodd"/></svg>`;
const SVG_SEND = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>`;
const SVG_CLOSE = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`;

class NaelaoChat extends HTMLElement {
  private shadow: ShadowRoot;
  private spaceId = "";
  private apiUrl = "";
  private sessionId: string | null = null;
  private endUserId: string = "";
  private messages: NaelaoChatMessage[] = [];
  private runStatus: RunStatus = "idle";
  private errorMsg = "";
  private isOpen = false;
  private streamingText = "";

  // DOM refs set during connectedCallback
  private panel!: HTMLElement;
  private msgList!: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
  }

  static get observedAttributes() {
    return ["space-id", "api-url"];
  }

  attributeChangedCallback(name: string, _old: string, val: string) {
    if (name === "space-id") this.spaceId = val;
    if (name === "api-url") this.apiUrl = val;
  }

  connectedCallback() {
    this.spaceId = this.getAttribute("space-id") ?? "";
    this.apiUrl = this.getAttribute("api-url") ?? (window.location.origin);
    this.endUserId = this.loadOrCreateEndUserId();
    this.render();
    void this.initSession();
  }

  private loadOrCreateEndUserId(): string {
    try {
      const key = "naelao_euid";
      const existing = localStorage.getItem(key);
      if (existing) return existing;
      const arr = new Uint8Array(12);
      crypto.getRandomValues(arr);
      const id = "euid_" + Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(key, id);
      return id;
    } catch {
      return "euid_" + Math.random().toString(36).slice(2);
    }
  }

  private async initSession() {
    if (!this.spaceId) return;
    try {
      const res = await this.apiFetch<{ id: string }>(`/v1/spaces/${this.spaceId}/sessions`, {
        method: "POST", body: JSON.stringify({}),
        headers: { "x-naelao-end-user-id": this.endUserId },
      });
      this.sessionId = res.id;
    } catch { /* retry on first message */ }
  }

  private async apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      let msg = `Error ${res.status}`;
      try { const b = await res.json() as { message?: string }; msg = b.message ?? msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return res.json() as Promise<T>;
  }

  private render() {
    this.shadow.innerHTML = `<style>${WIDGET_CSS}</style>
<button class="widget-btn" aria-label="Open chat">${SVG_BOT}</button>
<div class="panel" hidden>
  <div class="header">
    <div class="header-icon">${SVG_BOT}</div>
    <div class="header-title">Chat</div>
    <button class="close-btn" aria-label="Close chat">${SVG_CLOSE}</button>
  </div>
  <div class="messages"></div>
  <div class="input-area">
    <textarea rows="1" placeholder="Type a message…" aria-label="Message"></textarea>
    <button class="send-btn" disabled aria-label="Send">${SVG_SEND}</button>
  </div>
  <div class="branding">Powered by Naelao</div>
</div>`;

    this.panel = this.shadow.querySelector(".panel") as HTMLElement;
    this.msgList = this.shadow.querySelector(".messages") as HTMLElement;
    this.textarea = this.shadow.querySelector("textarea") as HTMLTextAreaElement;
    this.sendBtn = this.shadow.querySelector(".send-btn") as HTMLButtonElement;

    this.shadow.querySelector(".widget-btn")!.addEventListener("click", () => this.togglePanel());
    this.shadow.querySelector(".close-btn")!.addEventListener("click", () => this.closePanel());
    this.sendBtn.addEventListener("click", () => void this.send());
    this.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void this.send(); }
    });
    this.textarea.addEventListener("input", () => {
      this.textarea.style.height = "auto";
      this.textarea.style.height = Math.min(this.textarea.scrollHeight, 100) + "px";
      this.sendBtn.disabled = !this.textarea.value.trim() || this.runStatus !== "idle";
    });

    this.renderMessages();
  }

  private togglePanel() {
    if (this.isOpen) this.closePanel(); else this.openPanel();
  }

  private openPanel() {
    this.isOpen = true;
    this.panel.removeAttribute("hidden");
    this.textarea.focus();
  }

  private closePanel() {
    this.isOpen = false;
    this.panel.setAttribute("hidden", "");
  }

  private renderMessages() {
    if (!this.msgList) return;
    if (this.messages.length === 0 && this.runStatus === "idle") {
      this.msgList.innerHTML = `<div class="empty">Send a message to start the conversation.</div>`;
      return;
    }

    let html = "";
    for (const m of this.messages) {
      if (m.role === "user") {
        html += `<div class="msg-user">${escapeHtml(m.content)}</div>`;
      } else {
        html += `<div class="msg-bot"><div class="bot-avatar">${SVG_BOT}</div><div class="bot-bubble">${escapeHtml(m.content)}</div></div>`;
      }
    }

    if (this.runStatus === "streaming" && this.streamingText) {
      html += `<div class="msg-bot"><div class="bot-avatar">${SVG_BOT}</div><div class="bot-bubble streaming">${escapeHtml(this.streamingText)}</div></div>`;
    } else if (this.runStatus === "loading") {
      html += `<div class="msg-bot"><div class="bot-avatar">${SVG_BOT}</div><div class="typing"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>`;
    }

    if (this.errorMsg) {
      html += `<div class="error-msg">${escapeHtml(this.errorMsg)}</div>`;
    }

    this.msgList.innerHTML = html;
    this.msgList.scrollTop = this.msgList.scrollHeight;
  }

  private async send() {
    const content = this.textarea.value.trim();
    if (!content || this.runStatus !== "idle") return;

    this.errorMsg = "";
    this.textarea.value = "";
    this.textarea.style.height = "auto";
    this.sendBtn.disabled = true;

    this.messages.push({ id: `u_${Date.now()}`, role: "user", content });
    this.runStatus = "loading";
    this.renderMessages();

    try {
      // Ensure session
      if (!this.sessionId) await this.initSession();
      if (!this.sessionId) throw new Error("Could not create session.");

      // Post user message
      await this.apiFetch(`/v1/spaces/${this.spaceId}/sessions/${this.sessionId}/messages`, {
        method: "POST", body: JSON.stringify({ role: "user", content }),
      });

      // Start agent run
      const run = await this.apiFetch<AgentRunResponse>(
        `/v1/spaces/${this.spaceId}/sessions/${this.sessionId}/agent/run`,
        { method: "POST", body: JSON.stringify({ session_id: this.sessionId }) }
      );

      const runId = run.id;

      // Try SSE first
      if (typeof EventSource !== "undefined") {
        await this.streamViaSSE(runId);
      } else {
        await this.pollRun(runId);
      }
    } catch (err) {
      this.runStatus = "idle";
      this.errorMsg = err instanceof Error ? err.message : "Something went wrong.";
      this.renderMessages();
    }
  }

  private streamViaSSE(runId: string): Promise<void> {
    return new Promise((resolve) => {
      const url = `${this.apiUrl}/v1/spaces/${this.spaceId}/sessions/${this.sessionId}/agent/runs/${runId}/stream`;
      const es = new EventSource(url);
      let accumulated = "";
      this.runStatus = "streaming";

      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data) as { type: string; content?: string; message?: string };
          if (data.type === "delta" && data.content) {
            accumulated += data.content;
            this.streamingText = accumulated;
            this.renderMessages();
          } else if (data.type === "done") {
            es.close();
            this.streamingText = "";
            this.runStatus = "idle";
            if (accumulated) {
              this.messages.push({ id: `a_${Date.now()}`, role: "assistant", content: accumulated });
            }
            this.renderMessages();
            resolve();
          } else if (data.type === "error") {
            es.close();
            this.streamingText = "";
            this.runStatus = "idle";
            this.errorMsg = data.message ?? "Agent error.";
            this.renderMessages();
            resolve();
          }
        } catch { /* ignore */ }
      };

      es.onerror = () => {
        es.close();
        this.streamingText = "";
        // If we got content already, commit it; otherwise fall back to poll
        if (accumulated) {
          this.runStatus = "idle";
          this.messages.push({ id: `a_${Date.now()}`, role: "assistant", content: accumulated });
          this.renderMessages();
          resolve();
        } else {
          this.runStatus = "loading";
          void this.pollRun(runId).then(resolve);
        }
      };
    });
  }

  private async pollRun(runId: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      try {
        const run = await this.apiFetch<AgentRunResponse>(
          `/v1/spaces/${this.spaceId}/sessions/${this.sessionId}/agent/runs/${runId}`
        );
        if (run.status === "running") {
          if (run.final_answer) { this.streamingText = run.final_answer; this.renderMessages(); }
          continue;
        }
        this.streamingText = "";
        this.runStatus = "idle";
        if (run.status === "completed" && run.final_answer) {
          this.messages.push({ id: `a_${Date.now()}`, role: "assistant", content: run.final_answer });
        } else {
          this.errorMsg = run.error ?? "Agent error.";
        }
        this.renderMessages();
        return;
      } catch (err) {
        this.runStatus = "idle";
        this.errorMsg = err instanceof Error ? err.message : "Poll error.";
        this.renderMessages();
        return;
      }
    }
    this.runStatus = "idle";
    this.errorMsg = "Agent timed out. Please try again.";
    this.renderMessages();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

if (!customElements.get("naelao-chat")) {
  customElements.define("naelao-chat", NaelaoChat);
}
