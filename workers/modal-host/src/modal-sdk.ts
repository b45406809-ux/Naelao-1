import { ModalClient } from "modal";
import type { ModalHostProvider, ModalHostReceipt, ModalHostSpec } from "./host.js";

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundError";
}

async function currentState(sandbox: { poll(): Promise<number | null> }): Promise<"running" | "stopped"> {
  return await sandbox.poll() === null ? "running" : "stopped";
}

/** Uses only the documented Sandbox API; Modal credentials stay in this Node process. */
export function createModalSdkProvider(client: ModalClient, appName: string): ModalHostProvider {
  return {
    async findByName(name): Promise<ModalHostReceipt | null> {
      try {
        const sandbox = await client.sandboxes.fromName(appName, name, { includeTerminated: true });
        return { id: sandbox.sandboxId, state: await currentState(sandbox) };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async create(name: string, spec: ModalHostSpec): Promise<ModalHostReceipt> {
      const app = await client.apps.fromName(appName);
      const image = client.images.fromRegistry(spec.image);
      const sandbox = await client.sandboxes.create(app, image, {
        name,
        cpu: spec.cpu,
        memoryMiB: spec.memoryMb,
        timeoutMs: spec.timeoutSeconds * 1000,
        regions: [spec.region],
        blockNetwork: true,
        gpu: spec.gpu,
        runtime: "gvisor",
      });
      return { id: sandbox.sandboxId, state: await currentState(sandbox) };
    },
    async inspect(id) {
      try {
        const sandbox = await client.sandboxes.fromId(id);
        return { state: await currentState(sandbox) };
      } catch (error) {
        if (isNotFound(error)) return { state: "stopped" };
        throw error;
      }
    },
    async terminate(id) {
      const sandbox = await client.sandboxes.fromId(id);
      await sandbox.terminate();
    },
  };
}

export function createModalClientFromEnv(env: NodeJS.ProcessEnv): ModalClient {
  const tokenId = env.MODAL_TOKEN_ID?.trim() ?? "";
  const tokenSecret = env.MODAL_TOKEN_SECRET?.trim() ?? "";
  if (!tokenId || !tokenSecret) throw new Error("modal_provider_credentials_unavailable");
  return new ModalClient({ tokenId, tokenSecret, logLevel: "error" });
}
