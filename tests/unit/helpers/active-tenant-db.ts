export function activeTenantDb(status = "active"): D1Database {
  return {
    prepare: () => ({ bind: () => ({ first: async () => ({ status }) }) }),
  } as unknown as D1Database;
}
