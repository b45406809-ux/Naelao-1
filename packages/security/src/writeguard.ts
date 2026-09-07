export interface WriteGuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Validates a SQL query string to prevent unauthorized destructive operations.
 * Requires a valid Gatekeeper token for DROP, ALTER, or unbounded DELETEs.
 */
export function isSafeSqlMutation(sql: string, hasGatekeeperToken: boolean): WriteGuardResult {
  if (!sql) return { allowed: false, reason: "Empty SQL statement." };

  const normalized = sql.toUpperCase().replace(/\s+/g, " ").trim();
  
  const isDestructive = 
    normalized.includes("DROP TABLE") || 
    normalized.includes("DROP INDEX") || 
    normalized.includes("ALTER TABLE") ||
    normalized.includes("TRUNCATE TABLE") ||
    // Catch unbounded deletes (DELETE FROM table without a WHERE clause)
    (normalized.includes("DELETE FROM") && !normalized.includes("WHERE"));

  if (isDestructive && !hasGatekeeperToken) {
    return { 
      allowed: false, 
      reason: "Destructive SQL operations require a valid Gatekeeper capability token." 
    };
  }

  return { allowed: true };
}
