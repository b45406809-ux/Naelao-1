import artifactWorker, { RepositoryDO } from "../../../workers/artifact/src/index.js";

export { RepositoryDO };
export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/__runtime_ready")
      return Response.json({ ok: true });
    return artifactWorker.fetch(request, env as never, ctx);
  },
};
