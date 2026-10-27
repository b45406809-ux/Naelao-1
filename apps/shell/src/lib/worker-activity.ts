/** Display the durable worker status without claiming suspended work has completed. */
export function workerActivityLabel(status: string): string {
  switch (status) {
    case "running": return "Working";
    case "done": case "completed": return "Completed";
    case "failed": return "Failed — needs attention";
    case "awaiting_planner_input": return "Waiting for the planner";
    case "awaiting_human_input": return "Waiting for your input or approval";
    case "terminated": return "Stopped";
    default: return status.replaceAll("_", " ");
  }
}
