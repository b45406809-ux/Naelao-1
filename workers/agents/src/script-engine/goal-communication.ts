import type { TaskCommunicationEdge } from "@naelao/agent-sdk";
import { validateGoalDag, type GoalTask } from "./prebuilt/goal-planner.js";

export interface StoredGoalCommunicationEdge { senderId: string; recipientId: string }

/** Revalidate advisory model output at the host boundary before creating any grant. */
export function applyGoalCommunicationEdges(tasks: GoalTask[], proposed: readonly TaskCommunicationEdge[]): StoredGoalCommunicationEdge[] {
  validateGoalDag(tasks);
  if (!Array.isArray(proposed) || proposed.length > 132) throw new Error("goal_communication_proposals_invalid");
  const positions = new Map(tasks.map((task, index) => [task.id, index]));
  const peerOutgoing = new Map<string, number>();
  const totalOutgoing = new Map<string, number>();
  for (const task of tasks) totalOutgoing.set(task.id, tasks.filter(candidate => candidate.dependencies?.includes(task.id)).length);
  const accepted: StoredGoalCommunicationEdge[] = [];
  const seen = new Set<string>();
  const hasDependencyPath = (from: string, to: string, visited = new Set<string>()): boolean => {
    if (from === to) return true;
    if (visited.has(to)) return false;
    visited.add(to);
    return (tasks.find(task => task.id === to)?.dependencies ?? []).some(parent => hasDependencyPath(from, parent, visited));
  };
  for (const edge of proposed) {
    if (!edge || typeof edge.senderId !== "string" || typeof edge.recipientId !== "string"
      || !Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1
      || !["openrouter", "deterministic"].includes(edge.provider)
      || (edge.model !== undefined && (typeof edge.model !== "string" || edge.model.length > 160))) throw new Error("goal_communication_proposals_invalid");
    const from = positions.get(edge.senderId), to = positions.get(edge.recipientId);
    if (from === undefined || to === undefined || from >= to || edge.confidence < 0.8 || hasDependencyPath(edge.senderId, edge.recipientId)) continue;
    const key = `${edge.senderId}\0${edge.recipientId}`;
    if (seen.has(key)) continue;
    if (accepted.length >= 24 || (peerOutgoing.get(edge.senderId) ?? 0) >= 8 || (totalOutgoing.get(edge.senderId) ?? 0) >= 12) continue;
    seen.add(key);
    peerOutgoing.set(edge.senderId, (peerOutgoing.get(edge.senderId) ?? 0) + 1);
    totalOutgoing.set(edge.senderId, (totalOutgoing.get(edge.senderId) ?? 0) + 1);
    accepted.push({ senderId: edge.senderId, recipientId: edge.recipientId });
  }
  for (const task of tasks) task.communication_recipients = [];
  for (const edge of accepted) {
    const sender = tasks.find(task => task.id === edge.senderId)!;
    sender.communication_recipients!.push(edge.recipientId);
  }
  validateGoalDag(tasks);
  return accepted;
}
