import spacesWorker, { SpaceDO } from "../../../workers/spaces/src/index.js";

export { SpaceDO };

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/__runtime_ready")
      return Response.json({ ok: true });
    return spacesWorker.fetch(request, env as never, ctx);
  },
};
