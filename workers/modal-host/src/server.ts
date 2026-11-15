import { createServer } from "node:http";
import { createModalHostHandler, type ModalHostConfig, type ModalHostProvider } from "./host.js";
import { createModalClientFromEnv, createModalSdkProvider } from "./modal-sdk.js";

const MAX_HTTP_BODY_BYTES = 16 * 1024;

function booleanEnv(value: string | undefined): boolean { return value === "true"; }
function listEnv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
function integerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function readModalHostConfig(env: NodeJS.ProcessEnv): ModalHostConfig & { appName: string } {
  const image = env.MODAL_SANDBOX_IMAGE?.trim() ?? "";
  const appName = env.MODAL_SANDBOX_APP?.trim() ?? "";
  const platformSecret = env.PLATFORM_SECRET?.trim() ?? "";
  const config: ModalHostConfig & { appName: string } = {
    enabled: booleanEnv(env.MODAL_HOST_ENABLED),
    betaAccepted: booleanEnv(env.MODAL_BETA_ACCEPTED),
    privateGrpcAccepted: booleanEnv(env.MODAL_PRIVATE_GRPC_API_ACCEPTED),
    platformSecret,
    image,
    appName,
    allowedRegions: listEnv(env.MODAL_ALLOWED_REGIONS),
    allowedGpus: listEnv(env.MODAL_ALLOWED_GPUS),
    maxCpu: Number(env.MODAL_MAX_CPU ?? 0),
    maxMemoryMb: integerEnv(env.MODAL_MAX_MEMORY_MB, 0),
    maxTimeoutSeconds: integerEnv(env.MODAL_MAX_TIMEOUT_SECONDS, 0),
  };
  if (config.enabled && config.betaAccepted && config.privateGrpcAccepted) {
    if (!platformSecret || !appName || !/^([a-z0-9][a-z0-9./:_-]*)@sha256:[a-f0-9]{64}$/.test(image)
      || !config.allowedRegions.length || !config.maxCpu || !config.maxMemoryMb || !config.maxTimeoutSeconds)
      throw new Error("modal_host_configuration_invalid");
    if (!Number.isFinite(config.maxCpu) || config.maxCpu < 0.125 || config.maxCpu > 128
      || config.maxMemoryMb < 128 || config.maxMemoryMb > 1_048_576 || config.maxTimeoutSeconds > 3600
      || !config.allowedGpus.length || config.allowedRegions.some((region) => !/^[a-z0-9][a-z0-9-]{0,31}$/.test(region))
      || config.allowedGpus.some((gpu) => !/^[A-Za-z0-9._:-]{1,64}$/.test(gpu)))
      throw new Error("modal_host_configuration_invalid");
    if (!env.MODAL_TOKEN_ID?.trim() || !env.MODAL_TOKEN_SECRET?.trim()) throw new Error("modal_provider_credentials_unavailable");
  }
  return config;
}

export function createModalHostServer(env: NodeJS.ProcessEnv, providerOverride?: ModalHostProvider) {
  const config = readModalHostConfig(env);
  const provider = providerOverride ?? (config.enabled && config.betaAccepted && config.privateGrpcAccepted
    ? createModalSdkProvider(createModalClientFromEnv(env), config.appName)
    : unavailableProvider);
  const handler = createModalHostHandler(config, provider);
  return createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of incoming) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > MAX_HTTP_BODY_BYTES) {
          outgoing.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
          outgoing.end(JSON.stringify({ error_code: "request_too_large" }));
          return;
        }
        chunks.push(bytes);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(", "));
      }
      const method = incoming.method ?? "GET";
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(`http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, {
        method, headers, ...(body ? { body } : {}),
      });
      const response = await handler(request);
      const responseHeaders = Object.fromEntries(response.headers.entries());
      const responseBody = Buffer.from(await response.arrayBuffer());
      outgoing.writeHead(response.status, responseHeaders);
      outgoing.end(responseBody);
    } catch {
      outgoing.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      outgoing.end(JSON.stringify({ error_code: "modal_host_internal_error" }));
    }
  });
}

const unavailableProvider: ModalHostProvider = {
  async findByName() { throw new Error("modal_host_rollout_disabled"); },
  async create() { throw new Error("modal_host_rollout_disabled"); },
  async inspect() { throw new Error("modal_host_rollout_disabled"); },
  async terminate() { throw new Error("modal_host_rollout_disabled"); },
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = integerEnv(process.env.PORT, 8787);
  const host = process.env.HOST ?? "0.0.0.0";
  createModalHostServer(process.env).listen(port, host, () => {
    process.stdout.write(`modal-host listening on ${host}:${port}\n`);
  });
}
