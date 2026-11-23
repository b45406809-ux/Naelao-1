/** Display the durable worker status without claiming suspended work has completed. */
export function workerActivityLabel(status: string): string {
  switch (status) {
    case "running": return "Working";
    case "done": case "completed": return "Completed";
    case "failed": return "Failed — needs attention";
    case "awaiting_planner_input": return "Waiting for the planner";
    case "awaiting_human_input": return "Waiting for your input or approval";
    case "cancelling": return "Stopping";
    case "cancelled": return "Stopped";
    case "terminated": return "Stopped";
    default: return status.replaceAll("_", " ");
  }
}

export function goalCancellationLabel(status: string): string {
  switch (status) {
    case "not_dispatched": return "Stopped before dispatch";
    case "requested": return "Stop requested";
    case "acknowledged": return "Worker stopped";
    case "already_complete": return "Worker completed before the stop";
    case "late_result": return "Late result received";
    case "uncertain": return "Stop outcome uncertain";
    default: return status.replaceAll("_", " ");
  }
}
