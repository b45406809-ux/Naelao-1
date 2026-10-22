import { isPrivateNetworkAddress, resolveHostnameIps } from "./ssrf.js";

export interface PinnedSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<{ remoteAddress?: string }>;
  close(): Promise<void>;
  startTls(options: { expectedServerHostname: string }): PinnedSocket;
}

export type SocketConnector = (
  address: { hostname: string; port: number },
  options: { secureTransport: "off"; allowHalfOpen: false }
) => PinnedSocket;

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

function ipv4(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function ipv6(host: string): boolean {
  return host.includes(":");
}

function normalIp(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  const reader = new Response(body).body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Pinned request body exceeds limit");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

class SocketBuffer {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private length = 0;
  private ended = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async fill(minBytes: number): Promise<void> {
    while (!this.ended && this.length < minBytes) {
      const part = await this.reader.read();
      if (part.done) { this.ended = true; break; }
      if (part.value.byteLength) { this.chunks.push(part.value); this.length += part.value.byteLength; }
    }
  }

  async readExact(size: number): Promise<Uint8Array> {
    await this.fill(size);
    if (this.length < size) throw new Error("Pinned response ended early");
    return this.take(size);
  }

  async readUntil(delimiter: Uint8Array, maxBytes: number): Promise<Uint8Array> {
    while (true) {
      const data = this.peek();
      const index = findBytes(data, delimiter);
      if (index >= 0) {
        if (index + delimiter.byteLength > maxBytes) throw new Error("Pinned response headers exceed limit");
        return this.take(index + delimiter.byteLength).slice(0, index);
      }
      if (data.byteLength > maxBytes) throw new Error("Pinned response headers exceed limit");
      if (this.ended) throw new Error("Pinned response ended before headers completed");
      await this.fill(this.length + 1);
    }
  }

  async readLine(maxBytes: number): Promise<Uint8Array> {
    const line = await this.readUntil(new Uint8Array([13, 10]), maxBytes);
    return line;
  }

  async readToEnd(maxBytes: number): Promise<Uint8Array> {
    while (!this.ended) {
      if (this.length > maxBytes) throw new Error("Pinned response body exceeds limit");
      await this.fill(this.length + 1);
    }
    if (this.length > maxBytes) throw new Error("Pinned response body exceeds limit");
    return this.take(this.length);
  }

  async readBounded(size: number, maxBytes: number): Promise<Uint8Array> {
    if (size > maxBytes) throw new Error("Pinned response body exceeds limit");
    return this.readExact(size);
  }

  async readChunked(maxBytes: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const sizeLine = new TextDecoder().decode(await this.readLine(1024));
      const sizeToken = sizeLine.split(";", 1)[0]?.trim() ?? "";
      if (!/^[0-9a-fA-F]{1,16}$/.test(sizeToken)) throw new Error("Invalid chunk size");
      const size = Number.parseInt(sizeToken, 16);
      if (!Number.isSafeInteger(size) || size < 0 || total + size > maxBytes) throw new Error("Pinned response body exceeds limit");
      if (size === 0) {
        // Trailers are bounded and discarded. Empty trailer section is just CRLF.
        let trailerBytes = 0;
        while (true) {
          const line = await this.readLine(MAX_HEADER_BYTES - trailerBytes);
          trailerBytes += line.byteLength + 2;
          if (trailerBytes > MAX_HEADER_BYTES) throw new Error("Pinned response trailers exceed limit");
          if (line.byteLength === 0) break;
        }
        break;
      }
      const chunk = await this.readExact(size);
      const crlf = await this.readExact(2);
      if (crlf[0] !== 13 || crlf[1] !== 10) throw new Error("Invalid chunk framing");
      chunks.push(chunk);
      total += size;
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }

  async cancel(): Promise<void> { await this.reader.cancel().catch(() => undefined); }

  private peek(): Uint8Array {
    if (!this.chunks.length) return new Uint8Array();
    if (this.chunks.length === 1) return this.chunks[0]!;
    const result = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    this.chunks = [result];
    return result;
  }

  private take(size: number): Uint8Array {
    const result = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const first = this.chunks[0]!;
      const count = Math.min(size - offset, first.byteLength);
      result.set(first.subarray(0, count), offset);
      offset += count;
      if (count === first.byteLength) this.chunks.shift();
      else this.chunks[0] = first.subarray(count);
    }
    this.length -= size;
    return result;
  }
}

function findBytes(data: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= data.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) if (data[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

async function readHeaders(buffer: SocketBuffer): Promise<{ status: number; statusText: string; headers: Headers }> {
  for (let informational = 0; informational < 4; informational++) {
    const raw = new TextDecoder().decode(await buffer.readUntil(new Uint8Array([13, 10, 13, 10]), MAX_HEADER_BYTES));
    const lines = raw.split("\r\n");
    const statusMatch = /^HTTP\/1\.[01] (\d{3})(?:\s(.*))?$/.exec(lines.shift() ?? "");
    if (!statusMatch) throw new Error("Invalid pinned response status line");
    const status = Number(statusMatch[1]);
    const headers = new Headers();
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon <= 0) throw new Error("Invalid pinned response header");
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      headers.append(name, value);
    }
    if (status === 101) throw new Error("Protocol upgrades are not supported by pinned fetch");
    if (status < 100 || status >= 200) return { status, statusText: statusMatch[2] ?? "", headers };
  }
  throw new Error("Too many informational responses");
}

/**
 * Fetch over a socket connected to a DNS answer that has already passed the shared private-IP
 * checks. It deliberately implements a bounded HTTP/1.1 subset and never follows redirects.
 */
export async function fetchPinned(
  input: RequestInfo | URL,
  init: RequestInit,
  connector: SocketConnector,
  options: { fetchDns?: typeof fetch; maxResponseBytes?: number; timeoutMs?: number } = {}
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error("Pinned fetch requires a credential-free HTTP(S) URL");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if ((url.protocol === "https:" && port !== 443) || (url.protocol === "http:" && port !== 80)) throw new Error("Pinned fetch only supports ports 80 and 443");
  let addresses: string[];
  if (ipv4(url.hostname) || ipv6(url.hostname)) addresses = [normalIp(url.hostname)];
  else addresses = await resolveHostnameIps(url.hostname, options.fetchDns ?? fetch);
  if (!addresses.length || addresses.some(isPrivateNetworkAddress)) throw new Error("Pinned fetch destination resolved to an unsafe address");

  const method = request.method.toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) throw new Error("Invalid pinned request method");
  const body = method === "GET" || method === "HEAD" ? new Uint8Array() : await bodyBytes(request.body);
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set("host", host);
  headers.set("connection", "close");
  headers.set("accept-encoding", "identity");
  if (body.byteLength) headers.set("content-length", String(body.byteLength));
  const head = `${method} ${url.pathname || "/"}${url.search} HTTP/1.1\r\n${[...headers].map(([name, value]) => {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[\r\n]/.test(value)) throw new Error("Invalid pinned request header");
    return `${name}: ${value}`;
  }).join("\r\n")}\r\n\r\n`;
  if (head.length > MAX_HEADER_BYTES) throw new Error("Pinned request headers exceed limit");
  const headBytes = new TextEncoder().encode(head);
  const payload = new Uint8Array(headBytes.byteLength + body.byteLength);
  payload.set(headBytes);
  payload.set(body, headBytes.byteLength);

  let socket: PinnedSocket | undefined;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
  const closeOnAbort = () => { void socket?.close().catch(() => undefined); };
  if (signal.aborted) throw signal.reason ?? new Error("Pinned fetch aborted");
  signal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    let lastError: unknown;
    for (const address of addresses) {
      try {
        const rawSocket = connector({ hostname: address, port }, { secureTransport: "off", allowHalfOpen: false });
        socket = rawSocket;
        const opened = await rawSocket.opened;
        if (opened.remoteAddress && normalIp(opened.remoteAddress) !== normalIp(address)) throw new Error("Pinned socket connected to an unexpected address");
        if (url.protocol === "https:") {
          socket = rawSocket.startTls({ expectedServerHostname: url.hostname });
          await socket.opened;
        }
        const writer = socket.writable.getWriter();
        try { await writer.write(payload); } finally { writer.releaseLock(); }
        const buffer = new SocketBuffer(socket.readable);
        const { status, statusText, headers: responseHeaders } = await readHeaders(buffer);
        let responseBody: Uint8Array<ArrayBufferLike> = new Uint8Array();
        if (method !== "HEAD" && status !== 204 && status !== 205 && status !== 304) {
          const transferEncodingHeader = responseHeaders.get("transfer-encoding")?.toLowerCase();
          const transferEncoding = transferEncodingHeader?.split(",").map((part) => part.trim());
          const contentLengthRaw = responseHeaders.get("content-length");
          if (transferEncodingHeader && contentLengthRaw !== null) throw new Error("Ambiguous pinned response framing");
          const contentEncoding = responseHeaders.get("content-encoding")?.trim().toLowerCase();
          if (contentEncoding && contentEncoding !== "identity") throw new Error("Pinned fetch does not support encoded response bodies");
          if (transferEncoding?.length) {
            if (transferEncoding.length !== 1 || transferEncoding[0] !== "chunked") throw new Error("Unsupported pinned response transfer encoding");
            responseBody = await buffer.readChunked(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
            responseHeaders.delete("transfer-encoding");
            responseHeaders.delete("content-length");
          } else if (contentLengthRaw !== null) {
            if (!/^\d{1,16}$/.test(contentLengthRaw)) throw new Error("Invalid pinned response Content-Length");
            responseBody = await buffer.readBounded(Number(contentLengthRaw), options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
          } else {
            responseBody = await buffer.readToEnd(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
          }
        }
        await buffer.cancel();
        await socket.close().catch(() => undefined);
        return new Response(method === "HEAD" || status === 204 || status === 205 || status === 304 ? null : responseBody, { status, statusText, headers: responseHeaders });
      } catch (error) {
        lastError = error;
        await socket?.close().catch(() => undefined);
        socket = undefined;
        if (signal.aborted) throw signal.reason ?? error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Pinned fetch failed");
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    await socket?.close().catch(() => undefined);
  }
}
