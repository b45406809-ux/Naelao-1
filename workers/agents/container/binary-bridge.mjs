import { createServer } from "node:net";

const HEADER = 22;
const END = 1;
const ERROR = 2;
const STDOUT = 4;

function frame(id, flags, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const out = Buffer.allocUnsafe(HEADER + body.length);
  out.writeUInt32BE(body.length, 0); id.copy(out, 4); out.writeUInt16BE(flags, 20); body.copy(out, HEADER);
  return out;
}

/** Persistent full-duplex IPC listener. Requests are JSON {path, body}; response chunks retain
 * the exact 128-bit correlation id, allowing arbitrarily interleaved concurrent calls. */
export function startBinaryBridge({ port = 8081, httpPort = 8080 } = {}) {
  return createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= HEADER) {
        const length = buffered.readUInt32BE(0);
        if (length > 32 * 1024 * 1024) { socket.destroy(new Error("bridge_frame_too_large")); return; }
        if (buffered.length < HEADER + length) return;
        const id = Buffer.from(buffered.subarray(4, 20));
        const payload = Buffer.from(buffered.subarray(HEADER, HEADER + length));
        buffered = buffered.subarray(HEADER + length);
        void (async () => {
          try {
            const request = JSON.parse(payload.toString("utf8"));
            const response = await fetch(`http://127.0.0.1:${httpPort}${request.path}`, {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request.body ?? {}),
            });
            const responseBody = Buffer.from(await response.arrayBuffer());
            socket.write(frame(id, response.ok ? END : END | ERROR, responseBody));
          } catch (error) {
            socket.write(frame(id, END | ERROR, JSON.stringify({ error: String(error) })));
          }
        })();
      }
    });
  }).listen(port, "0.0.0.0");
}
