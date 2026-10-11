import { describe, expect, it, vi } from "vitest";
import { LocalTunnelDO } from "./LocalTunnelDO.js";

describe("LocalTunnelDO correlation and multiplexing", () => {
  it("rejects non-TLS remote tunnel upgrades", async () => {
    const tunnel = new LocalTunnelDO({ getWebSockets: () => [], acceptWebSocket: vi.fn() } as never, { PLATFORM_SECRET: "test-secret" });
    const response = await tunnel.fetch(new Request("http://agents.example.test/connect?space=s&user=u", {
      headers: { Upgrade: "websocket" },
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ message: "Local tunnel connections require TLS" });
  });

  it("fails closed when an air-gapped completion has no local runner", async () => {
    const tunnel = new LocalTunnelDO({ getWebSockets: () => [], acceptWebSocket: vi.fn() } as never, { PLATFORM_SECRET: "test-secret" });
    const response = await tunnel.fetch(new Request("https://tunnel/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "llama3", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error_code: "air_gapped_runner_offline" });
  });
  it("prevents concurrent correlation IDs from crossing", async () => {
    const outbox = [];
    const mockWs = {
      send: (data) => outbox.push(data),
      close: vi.fn(),
    };

    const mockCtx = {
      getWebSockets: () => [mockWs],
      acceptWebSocket: vi.fn(),
    };

    const tunnel = new LocalTunnelDO(mockCtx, {
      PLATFORM_SECRET: "test-secret",
    });

    const p1 = tunnel.fetch(
      new Request("https://tunnel/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "exec", params: { cmd: "task1" } }),
      })
    );

    const p2 = tunnel.fetch(
      new Request("https://tunnel/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "exec", params: { cmd: "task2" } }),
      })
    );

    await vi.waitFor(() => expect(outbox.length).toBe(2));
    const msg1 = JSON.parse(outbox[0]);
    const msg2 = JSON.parse(outbox[1]);

    expect(msg1.request_id).not.toBe(msg2.request_id);
    expect(msg1.params.cmd).toBe("task1");
    expect(msg2.params.cmd).toBe("task2");

    tunnel.webSocketMessage(
      mockWs,
      JSON.stringify({
        type: "response",
        request_id: msg2.request_id,
        ok: true,
        result: { output: "result-2" },
      })
    );
    tunnel.webSocketMessage(
      mockWs,
      JSON.stringify({
        type: "response",
        request_id: msg1.request_id,
        ok: true,
        result: { output: "result-1" },
      })
    );

    const [res1, res2] = await Promise.all([p1, p2]);
    const body1 = await res1.json();
    const body2 = await res2.json();

    expect(body1.result.output).toBe("result-1");
    expect(body2.result.output).toBe("result-2");
  });
});
