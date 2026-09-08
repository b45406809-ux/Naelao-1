import { GatekeeperToken } from "./types";

export class WriteGuard {
  /**
   * Inspects a SQL query string for destructive patterns.
   * Blocks any query that attempts to modify structure or perform bulk deletes
   * unless the token carries an explicit 'admin' or 'delete' grant.
   */
  static async validateSqlQuery(
    sql: string,
    token: GatekeeperToken
  ): Promise<{ allowed: boolean; reason?: string }> {
    const normalized = sql.toLowerCase().trim();
    
    // 1. Block structural changes (DDL) for all standard tokens
    const destructivePatterns = ["drop table", "alter table", "truncate", "vacuum", "drop database"];
    if (destructivePatterns.some(p => normalized.includes(p))) {
      return { 
        allowed: false, 
        reason: "Structural mutations (DDL) are strictly forbidden via Gatekeeper WriteGuard." 
      };
    }

    // 2. Inspect DELETE operations
    if (normalized.startsWith("delete")) {
      const hasDeleteGrant = token.grants.some(
        g => g.resource === "sqlite_db" && g.operations.includes("delete")
      );
      if (!hasDeleteGrant) {
        return { 
          allowed: false, 
          reason: "Bulk delete operations require an explicit 'delete' capability in the token grants." 
        };
      }
      
      // Ensure WHERE clause is present to prevent unbounded 'DELETE FROM table'
      if (!normalized.includes("where")) {
        return { 
          allowed: false, 
          reason: "Unbounded DELETE operations are forbidden. A WHERE clause is strictly required." 
        };
      }
    }

    // 3. Inspect INSERT / UPDATE operations require write capability
    if (normalized.startsWith("insert") || normalized.startsWith("update") || normalized.startsWith("replace")) {
      const hasWriteGrant = token.grants.some(
        g => g.resource === "sqlite_db" && g.operations.includes("write")
      );
      if (!hasWriteGrant) {
        return {
          allowed: false,
          reason: "Write operations (INSERT/UPDATE/REPLACE) require an explicit 'write' capability."
        };
      }
    }

    return { allowed: true };
  }
}
