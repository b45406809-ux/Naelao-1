This chunk focuses on the **gRPC/Binary Socket Transport Layer** for Tier 6 containers. In production Cloudflare environments, standard HTTP/JSON serialization for heavy native binaries, large AST dumps, or continuous terminal streaming introduces unacceptable latency and memory overhead. Using `connect(socket)` with binary protobuf/gRPC allows for near-instant, zero-copy data transfer between your agent's Durable Object (the "Brain") and the Container Sandbox (the "Hands").

---

### File: `specs/phase-2/chunk-09-container-grpc-socket-transport.md`

```markdown
---
chunk_id: "phase-2-chunk-09"
phase: 2
include_files:
  - workers/agents/src/do/ToolSandboxDO.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/script-engine/execution-ladder.ts
repomix_include:
  - "workers/agents/src/do/ToolSandboxDO.ts"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "workers/agents/src/script-engine/execution-ladder.ts"
expected_outputs:
  - workers/agents/src/do/ToolSandboxDO.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/script-engine/execution-ladder.ts
---

# Phase 2 — Chunk 09: Container gRPC Socket Transport & Multiplexing

## 1. Mental Model & Architectural Vision

When the agent requires Tier 6 (Container) execution, it must not communicate via REST API over HTTP/1.1 (the default), which requires high-overhead JSON serialization, per-request header parsing, and connection handshake latency.

Instead, we use **Cloudflare `connect(socket)`**: a full-duplex, persistent binary pipe. 
* **The Agent (DO Instance):** Acts as the gRPC/Protobuf client.
* **The Container (`ToolSandboxDO`):** Acts as the binary gRPC server.
* **Efficiency:** IPC (Inter-Process Communication) latency drops from 50–200ms (HTTP) to **<5ms** (binary socket). Streaming data (terminal buffers, AST streams, binary build artifacts) passes through with zero memory-copy overhead.

---

## 2. Implementation Requirements

### A. Implement Multiplexed gRPC Transport (`ToolSandboxDO.ts`)
Update `ToolSandboxDO` to handle the binary socket connection:

```typescript
// workers/agents/src/do/ToolSandboxDO.ts
import { Socket } from "cloudflare:sockets";

export class ToolSandboxDO extends DurableObject {
  private socket: Socket | null = null;

  // Establish persistent binary transport on the first request
  private async getTransport() {
    if (this.socket) return this.socket;
    
    // Connect to the internal container socket (bound to container's internal gRPC interface)
    this.socket = await connect({ hostname: "container.internal", port: 50051 });
    return this.socket;
  }

  async fetch(request: Request): Promise<Response> {
    const transport = await this.getTransport();
    const data = await request.arrayBuffer();

    // Write binary payload directly to the persistent socket
    await transport.write(new Uint8Array(data));

    // Read binary response
    const responseData = await transport.read(); 
    return new Response(responseData, { headers: { "content-type": "application/octet-stream" } });
  }
}
```

### B. Update Agent Dispatcher (`NaelaoAgentDO.ts`)
Ensure the `NaelaoAgentDO` resolves the correct DO instance and uses binary framing:

```typescript
// workers/agents/src/do/NaelaoAgentDO.ts
async executeContainerCommand(command: string, cwd: string, env: Record<string, string>) {
  const sandboxDO = this.env.TOOL_SANDBOX.get(
    this.env.TOOL_SANDBOX.idFromName(`${this.ctx.id.toString()}:sandbox`)
  );

  const payload = { command, cwd, env };
  const buffer = encodeProtobuf(payload); // Binary serialization

  const response = await sandboxDO.fetch("http://internal/exec-grpc", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: buffer
  });

  return decodeProtobuf(await response.arrayBuffer());
}
```

### C. Update Execution Ladder (`execution-ladder.ts`)
Register the container-specific binary transport logic:

```typescript
// workers/agents/src/script-engine/execution-ladder.ts
export async function dispatchToContainer(
  cmd: string, 
  ctx: AvosRuntimeContext
) {
  // Routes to ToolSandboxDO using gRPC-optimized transport
  const result = await ctx.do.toolSandbox.executeCrossLayerBinary(
    cmd, 
    ctx.sessionState.cwd, 
    ctx.sessionState.envVars
  );
  
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    backend: "grpc_container_transport"
  };
}
```

---

## 3. Production Hardening Rules

1. **Deadlock Prevention:** Every binary read from the socket must have a strict `ReadTimeout` (e.g., 5s). If the container process stalls (or enters an infinite compilation loop), the socket must reset, not hang the agent DO.
2. **Binary Framing:** Since `socket.read()` returns raw buffers, implement a simple length-prefix header (4-byte integer) on all messages so the Agent DO knows how many bytes to read for a single response frame.
3. **ArtifactFS Synchronization:** Before every `write` request to the container, the DO must ensure the FUSE-mounted `/workspace` is synced with the latest Git HEAD to prevent the container from compiling stale code.
4. **No Binary Secrets:** The binary payloads sent to the container must strictly contain code or CLI flags. Never pass decrypted OAuth tokens or secrets in the gRPC body. Use `Outbound Workers` for secret injection at the network egress layer.
```
