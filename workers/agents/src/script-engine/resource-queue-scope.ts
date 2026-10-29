/** Resource locks follow the storage scope of the runtime they protect. */
export function resourceQueuePartition(projectId: string | undefined, resourceKey: string): string {
  return resourceKey === "worker.execution" || resourceKey.startsWith("runtime.space.") || resourceKey.startsWith("runtime.user.")
    ? "_"
    : projectId ?? "_";
}
