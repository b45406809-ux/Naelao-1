import { describe, expect, it, vi } from "vitest";
import { fetchPinned, type PinnedSocket, type SocketConnector } from "./pinned-fetch.js";

const dnsFetch: typeof fetch = vi.fn(async (input) => {
  const url = new URL(String(input));
  return Response.json({ Status: 0, Answer: [{ data: url.searchParams.get("type") === "A" ? "93.184.216.34" : "2001:4860:4860::8888" }] });
}) as typeof fetch;

function fakeConnector(responseText: string, opts: { remoteAddress?: string; responseChunkBytes?: number } = {}) {
  const calls: Array<{ address: { hostname: string; port: number }; tlsHost?: string; request: string }> = [];
  const connector: SocketConnector = (address) => {
    const call = { address, request: "" } as (typeof calls)[number];
    calls.push(call);
    const response = new TextEncoder().encode(responseText);
    const socket: PinnedSocket = {
      readable: new ReadableStream<Uint8Array>({ start(controller) {
        const chunkSize = opts.responseChunkBytes ?? response.byteLength;
        for (let offset = 0; offset < response.byteLength; offset += chunkSize) controller.enqueue(response.subarray(offset, offset + chunkSize));
        controller.close();
      } }),
      writable: new WritableStream<Uint8Array>({ write(chunk) { call.request += new TextDecoder().decode(chunk); } }),
      opened: Promise.resolve({ remoteAddress: opts.remoteAddress ?? address.hostname }),
      async close() {},
      startTls({ expectedServerHostname }) { call.tlsHost = expectedServerHostname; return socket; },
    };
    return socket;
  };
  return { connector, calls };
}

describe("fetchPinned", () => {
  it("dials the verified IP and keeps the hostname in the HTTP Host header", async () => {
    const { connector, calls } = fakeConnector("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    const response = await fetchPinned("https://safe.example/path?q=1", {}, connector, { fetchDns: dnsFetch });
    expect(calls[0]?.address).toEqual({ hostname: "93.184.216.34", port: 443 });
    expect(calls[0]?.tlsHost).toBe("safe.example");
    expect(calls[0]?.request).toContain("GET /path?q=1 HTTP/1.1\r\n");
    expect(calls[0]?.request).toContain("host: safe.example");
    expect(await response.text()).toBe("ok");
  });

  it("rejects any private DNS answer before opening a socket", async () => {
    const unsafeDns = vi.fn(async (input) => {
      const url = new URL(String(input));
      return Response.json({ Status: 0, Answer: [{ data: url.searchParams.get("type") === "A" ? "93.184.216.34" : "fd00::1" }] });
    }) as typeof fetch;
    const connector = vi.fn() as unknown as SocketConnector;
    await expect(fetchPinned("https://rebind.example/", {}, connector, { fetchDns: unsafeDns })).rejects.toThrow("unsafe address");
    expect(connector).not.toHaveBeenCalled();
  });

  it("refuses a socket that reports a different peer address", async () => {
    const { connector } = fakeConnector("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", { remoteAddress: "10.0.0.8" });
    await expect(fetchPinned("https://safe.example/", {}, connector, { fetchDns: dnsFetch })).rejects.toThrow("unexpected address");
  });

  it("decodes chunked responses and never follows redirects itself", async () => {
    const chunked = fakeConnector("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n");
    const body = await fetchPinned("http://93.184.216.34/", {}, chunked.connector);
    expect(await body.text()).toBe("ok");
    expect(body.headers.has("transfer-encoding")).toBe(false);

    const redirect = fakeConnector("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/\r\nContent-Length: 0\r\n\r\n");
    const response = await fetchPinned("http://93.184.216.34/", {}, redirect.connector);
    expect(response.status).toBe(302);
    expect(redirect.calls).toHaveLength(1);
  });

  it("handles headers and chunk framing split at every byte boundary", async () => {
    const wire = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;kind=text\r\nok\r\n0\r\nX-Trace: bounded\r\n\r\n";
    const split = fakeConnector(wire, { responseChunkBytes: 1 });
    const response = await fetchPinned("http://93.184.216.34/", {}, split.connector);
    expect(await response.text()).toBe("ok");
    expect(response.headers.has("transfer-encoding")).toBe(false);
  });

  it("survives repeated concurrent responses with varied socket chunk sizes", async () => {
    const sizes = [1, 2, 3, 7, 16, 31, 64];
    const results = await Promise.all(Array.from({ length: 128 }, async (_, index) => {
      const payload = `response-${index}`;
      const wire = `HTTP/1.1 200 OK\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`;
      const { connector } = fakeConnector(wire, { responseChunkBytes: sizes[index % sizes.length]! });
      const response = await fetchPinned(`http://93.184.216.34/${index}`, {}, connector);
      return response.text();
    }));
    expect(results).toEqual(Array.from({ length: 128 }, (_, index) => `response-${index}`));
  });

  it("bounds response bodies and rejects malformed chunk framing", async () => {
    const oversized = fakeConnector("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n123456");
    await expect(fetchPinned("http://93.184.216.34/", {}, oversized.connector, { maxResponseBytes: 5 })).rejects.toThrow("exceeds limit");

    const malformed = fakeConnector("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nokXX0\r\n\r\n");
    await expect(fetchPinned("http://93.184.216.34/", {}, malformed.connector)).rejects.toThrow("chunk framing");
  });

  it.each([
    ["ambiguous transfer and content length", "Transfer-Encoding: chunked\r\nContent-Length: 2\r\n"],
    ["unsupported transfer coding", "Transfer-Encoding: gzip, chunked\r\n"],
    ["encoded response", "Content-Encoding: gzip\r\nContent-Length: 2\r\n"],
  ])("fails closed on %s", async (_name, headers) => {
    const { connector } = fakeConnector(`HTTP/1.1 200 OK\r\n${headers}\r\n2\r\nok\r\n0\r\n\r\n`);
    await expect(fetchPinned("http://93.184.216.34/", {}, connector)).rejects.toThrow();
  });

  it("caps request bodies before writing them to the socket", async () => {
    const { connector, calls } = fakeConnector("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    await expect(fetchPinned("http://93.184.216.34/", { method: "POST", body: "x".repeat(8 * 1024 * 1024 + 1) }, connector)).rejects.toThrow("request body exceeds limit");
    expect(calls).toHaveLength(0);
  });

  it("caps streamed request bodies at the configured hard ceiling", async () => {
    const { connector, calls } = fakeConnector("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    const overLimit = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const request = new Request("http://93.184.216.34/", { method: "POST", body: overLimit, duplex: "half" } as RequestInit);
    await expect(fetchPinned(request, {}, connector)).rejects.toThrow("request body exceeds limit");
    expect(calls).toHaveLength(0);
  });

  it("does not open a socket after cancellation", async () => {
    const { connector, calls } = fakeConnector("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(fetchPinned("http://93.184.216.34/", { signal: controller.signal }, connector)).rejects.toThrow("cancelled");
    expect(calls).toHaveLength(0);
  });
});
