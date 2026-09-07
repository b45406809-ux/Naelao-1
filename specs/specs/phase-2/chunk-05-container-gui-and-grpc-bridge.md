Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 2 — Chunk 05**: `specs/phase-2/chunk-05-container-gui-and-grpc-bridge.md`.

---

```markdown
---
chunk_id: "phase-2-chunk-05"
phase: 2
include_files:
  - workers/agents/Dockerfile.toolsandbox
  - workers/agents/src/do/ToolSandboxDO.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
repomix_include:
  - "workers/agents/Dockerfile.toolsandbox"
  - "workers/agents/src/do/ToolSandboxDO.ts"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
expected_outputs:
  - workers/agents/Dockerfile.toolsandbox
  - workers/agents/src/do/ToolSandboxDO.ts
---

# Phase 2 — Chunk 05: Visual Desktop GUI (Computer Use) & gRPC Bridge

## 1. Executive Summary & Architectural Vision

To support advanced desktop application automation (**"Computer Use" / OSWorld parity**), Tier 6 Linux Containers (`ToolSandboxDO`) must support full graphical user interfaces (GUIs). 

AVOS achieves this by embedding a **Virtual Display Engine (Xvfb + Fluxbox + noVNC)** inside the container sandbox. The agent interacts with desktop applications using input primitives (`mouse_click`, `type_text`, `press_hotkey`), while a live noVNC WebSocket stream on port `8081` streams the visual screen directly to the user's `VirtualDesktopCanvas` in `apps/shell`.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TIER 6: VISUAL LINUX DESKTOP SANDBOX (ToolSandboxDO / Ubuntu Container)     │
├─────────────────────────────────────────────────────────────────────────────┤
│ • Virtual Display Server: Xvfb `:99` (1280x800 resolution)                   │
│ • Window Manager: Fluxbox + x11vnc + noVNC WebSocket Server (Port 8081)    │
│ • GUI Input Primitives: `xdotool` (mouse clicks, keystrokes, dragging)      │
│ • Live Video Stream: Streamed directly to client UI via WebSockets/noVNC    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Container Environment (`workers/agents/Dockerfile.toolsandbox`)

The container image must include headless X11 display servers and input control utilities:

```dockerfile
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js, Python, build tools, Xvfb, Fluxbox, VNC, and input simulation (xdotool)
RUN apt-get update && apt-get install -y \
    curl \
    git \
    python3 \
    python3-pip \
    build-essential \
    xvfb \
    fluxbox \
    x11vnc \
    novnc \
    websockify \
    xdotool \
    scrot \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

# Setup workspace directory
WORKDIR /workspace

# Expose container gRPC / API control port and noVNC visual stream port
EXPOSE 8080
EXPOSE 8081

# Default startup script initializing Xvfb virtual display `:99` and window manager
COPY entrypoint.sh /entrypoint.sh
chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

---

## 3. Container Entrypoint Script (`workers/agents/entrypoint.sh`)

Create the entrypoint script executed when the Tier 6 container boots up:

```bash
#!/bin/bash

# Start Xvfb virtual display server on screen 99 (1280x800x24)
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99

# Start Fluxbox window manager
fluxbox &

# Start x11vnc bridged over noVNC on port 8081
websockify --web=/usr/share/novnc/ 8081 localhost:5900 &
x11vnc -display :99 -forever -shared -nopw &

# Keep container alive by executing sandbox control server daemon
node /app/container/server.mjs
```

---

## 4. Technical Specifications & File Implementation Contracts

### A. `workers/agents/src/do/ToolSandboxDO.ts`

Implement the Durable Object controller managing multiplexed communication with the Tier 6 container via persistent gRPC / HTTP sockets:

```typescript
import { DurableObject } from "cloudflare:workers";

export interface GuiActionPayload {
  type: "click" | "type" | "hotkey" | "screenshot" | "scroll";
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  text?: string;
  keys?: string[];
  direction?: "up" | "down";
}

export class ToolSandboxDO extends DurableObject {
  private containerWsUrl: string = "http://localhost:8080";

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/exec-grpc") {
      const body = await request.json() as {
        command: string;
        cwd: string;
        envVars: Record<string, string>;
        branch: string;
      };

      const result = await this.forwardToContainer("/exec", body);
      return Response.json(result);
    }

    if (url.pathname === "/gui-action") {
      const action = await request.json() as GuiActionPayload;
      const result = await this.executeGuiCommand(action);
      return Response.json(result);
    }

    return new Response("Not Found", { status: 404 });
  }

  private async forwardToContainer(endpoint: string, payload: any) {
    try {
      const response = await fetch(`${this.containerWsUrl}${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      return await response.json();
    } catch (err: any) {
      return {
        stdout: "",
        stderr: `Container communication error: ${err.message}`,
        exitCode: 1
      };
    }
  }

  private async executeGuiCommand(action: GuiActionPayload) {
    let command = "";

    switch (action.type) {
      case "click":
        const btnNum = action.button === "right" ? 3 : 1;
        command = `DISPLAY=:99 xdotool mousemove ${action.x || 0} ${action.y || 0} click ${btnNum}`;
        break;
      case "type":
        // Escape double quotes for shell safety
        const escapedText = (action.text || "").replace(/"/g, '\\"');
        command = `DISPLAY=:99 xdotool type "${escapedText}"`;
        break;
      case "hotkey":
        const keyCombo = (action.keys || []).join("+");
        command = `DISPLAY=:99 xdotool key ${keyCombo}`;
        break;
      case "screenshot":
        const scrotRes = await this.forwardToContainer("/exec", {
          command: "DISPLAY=:99 scrot -z /tmp/screenshot.png && base64 /tmp/screenshot.png"
        });
        return {
          success: true,
          screenshotBase64: scrotRes.stdout.trim()
        };
      default:
        throw new Error(`Unsupported GUI action: ${action.type}`);
    }

    return await this.forwardToContainer("/exec", { command, cwd: "/workspace" });
  }
}
```

---

### B. `workers/agents/src/do/NaelaoAgentDO.ts`

Ensure `NaelaoAgentDO` can invoke GUI actions when an agent calls the `Browser` tool with `action: "screenshot"` or `"click"`:

```typescript
export async function dispatchGuiActionToSandbox(
  sandboxStub: DurableObjectStub,
  action: GuiActionPayload
) {
  const response = await sandboxStub.fetch("http://internal/gui-action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action)
  });
  return await response.json();
}
```

---

## 5. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Update `workers/agents/Dockerfile.toolsandbox`:
   - Append Xvfb, Fluxbox, noVNC, websockify, and xdotool installation statements.
   - Expose port `8081` for noVNC streaming.
2. Update `workers/agents/src/do/ToolSandboxDO.ts`:
   - Implement `ToolSandboxDO` handling `/exec-grpc` and `/gui-action` endpoints.
   - Map `xdotool` coordinate clicks, text typing, keyboard hotkeys, and `scrot` screenshot capturing.
3. Validate syntax using `node --check` and ensure clean TypeScript compilation.
```
