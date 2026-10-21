import { isProvisionMessage, type ProvisionMessage } from "./message-contract.js";
import { PROVISION_LEASE_TTL_SECONDS, ProvisionLeaseBusyError } from "./provisioning-lease.js";

export interface ProvisionQueueMessage {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ProvisionQueueHandlers {
  provision(message: ProvisionMessage): Promise<void>;
  deprovision(message: ProvisionMessage): Promise<void>;
}

/** Validate before side effects, acknowledge poison payloads, and retry transient failures. */
export async function handleProvisionQueueMessage(
  message: ProvisionQueueMessage,
  handlers: ProvisionQueueHandlers,
): Promise<void> {
  if (!isProvisionMessage(message.body)) {
    console.warn("[provisioner] Discarding malformed queue message");
    message.ack();
    return;
  }
  try {
    if (message.body.type === "space_provision") await handlers.provision(message.body);
    else await handlers.deprovision(message.body);
    message.ack();
  } catch (err) {
    if (err instanceof ProvisionLeaseBusyError) {
      message.retry({ delaySeconds: PROVISION_LEASE_TTL_SECONDS });
      return;
    }
    console.error("[provisioner] Error processing message:", err);
    message.retry();
  }
}
