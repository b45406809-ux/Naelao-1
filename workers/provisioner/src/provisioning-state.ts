/** Only new and retryable failed spaces may enter the provisioning saga. */
export function mayStartProvisioning(status: unknown): status is "provisioning" | "error" {
  return status === "provisioning" || status === "error";
}
