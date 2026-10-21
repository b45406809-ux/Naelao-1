export function activeTenantDb(status = "active", resellerStatus = "active"): D1Database {
  return {
    prepare: () => ({ bind: () => ({ first: async () => ({ status, reseller_status: resellerStatus }) }) }),
  } as unknown as D1Database;
}
