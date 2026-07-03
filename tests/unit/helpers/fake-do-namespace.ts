import { createDOSqlStorage } from "./sqlite-do-shim.js";

/**
 * A stateful fake DurableObjectNamespace: idFromName(name).get() always returns the SAME
 * instance for the same name (backed by createDOSqlStorage's in-memory SQLite), matching real
 * Cloudflare DO addressing semantics. Lets a Hono worker under test exercise a REAL DO class end
 * to end (create -> list -> verify round trips) instead of a hand-rolled stub response.
 */
export function makeStatefulDoNamespace<T extends { fetch(req: Request): Promise<Response> }>(
  DOClass: new (ctx: unknown, env: unknown) => T
): DurableObjectNamespace {
  const instances = new Map<string, T>();
  function getOrCreate(name: string): T {
    let inst = instances.get(name);
    if (!inst) {
      const ctx = { storage: { sql: createDOSqlStorage() } };
      inst = new DOClass(ctx as never, {} as never);
      instances.set(name, inst);
    }
    return inst;
  }
  return {
    idFromName(name: string) {
      return { toString: () => name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const inst = getOrCreate(id.toString());
      return { fetch: (req: Request) => inst.fetch(req) } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}
