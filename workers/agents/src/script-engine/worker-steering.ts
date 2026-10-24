import { readBoundedRequestText, verifyInternalToken } from "@naelao/http";
export interface SteeringScope {
  tenantId: string;
  spaceId: string;
  projectId?: string;
  actorId: string;
  workerId: string;
}
export interface SteeringCommand {
  commandId: string;
  action: "instruct" | "pause" | "resume";
  instruction?: string;
}
export interface SteeringStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<unknown>;
}
export function parseSteering(value: unknown): SteeringCommand {
  const a = value as SteeringCommand;
  if (
    !a ||
    typeof a !== "object" ||
    typeof a.commandId !== "string" ||
    !/^[-a-zA-Z0-9._:]{1,160}$/.test(a.commandId) ||
    !["instruct", "pause", "resume"].includes(a.action) ||
    (a.action === "instruct" &&
      (typeof a.instruction !== "string" ||
        !a.instruction.trim() ||
        a.instruction.length > 4000))
  )
    throw new Error("invalid_worker_steering");
  return {
    commandId: a.commandId,
    action: a.action,
    ...(a.action === "instruct" ? { instruction: a.instruction!.trim() } : {}),
  };
}
/** A bounded mailbox in the existing worker DO, not worker-to-worker communication. */
export async function receiveSteering(
  request: Request,
  secret: string,
  storage: SteeringStorage
): Promise<Response> {
  const tenant = request.headers.get("x-naelao-tenant-id") ?? "";
  if (
    !tenant ||
    !(await verifyInternalToken(
      request.headers.get("x-naelao-internal-token") ?? undefined,
      tenant,
      secret
    ))
  )
    return Response.json({ error_code: "forbidden" }, { status: 403 });
  const body = JSON.parse(
    await readBoundedRequestText(request, 8192)
  ) as SteeringScope & SteeringCommand;
  const scope = await storage.get<SteeringScope>("worker:scope");
  if (
    !scope ||
    tenant !== scope.tenantId ||
    body.spaceId !== scope.spaceId ||
    (body.projectId ?? null) !== (scope.projectId ?? null) ||
    body.actorId !== scope.actorId ||
    body.workerId !== scope.workerId
  )
    return Response.json(
      { error_code: "worker_scope_mismatch" },
      { status: 403 }
    );
  const command = parseSteering(body),
    key = "worker:steer:" + command.commandId;
  const existing = await storage.get<{
    command: SteeringCommand;
    status: string;
  }>(key);
  if (existing) {
    if (JSON.stringify(existing.command) !== JSON.stringify(command))
      return Response.json(
        { error_code: "steering_key_conflict" },
        { status: 409 }
      );
    return Response.json({
      command_id: command.commandId,
      status: existing.status,
    });
  }
  const queue =
    (await storage.get<SteeringCommand[]>("worker:steer:queue")) ?? [];
  if (queue.length >= 16)
    return Response.json(
      { error_code: "steering_queue_full" },
      { status: 429 }
    );
  await storage.put(key, { command, status: "requested" });
  await storage.put("worker:steer:queue", [...queue, command]);
  return Response.json({ command_id: command.commandId, status: "requested" });
}
export async function drainSteering(
  storage: SteeringStorage
): Promise<string[]> {
  const queue =
    (await storage.get<SteeringCommand[]>("worker:steer:queue")) ?? [];
  // Callers serialize with DO storage transactions so commands cannot be lost while draining.
  await storage.put("worker:steer:queue", []);
  const instructions: string[] = [];
  for (const command of queue) {
    if (command.action === "pause") await storage.put("worker:paused", true);
    else if (command.action === "resume")
      await storage.put("worker:paused", false);
    else instructions.push(command.instruction!);
    await storage.put("worker:steer:" + command.commandId, {
      command,
      status: "applied",
    });
  }
  return instructions;
}
