/**
 * AVOS Security Gatekeeper
 * Enforces 3-Tier Connector Scoping and Credential Access Isolation.
 */

export type ConnectorScope = 'space' | 'project' | 'user';
export type ThreadKind = 'public_channel' | 'project_room' | 'direct_message' | 'private_scratchpad';

export interface SecurityContext {
  spaceId: string;
  projectId?: string;
  actingUserId?: string;
  threadKind: ThreadKind;
}

export interface CredentialClaim {
  id: string;
  spaceId: string;
  name: string;
  scope: ConnectorScope;
  projectId?: string | null;
  userId?: string | null;
  value: string;
}

export class Gatekeeper {
  /**
   * Validates if the given security context is permitted to access a credential
   * with the specified ownership scope.
   */
  static isCredentialAccessAllowed(
    context: SecurityContext,
    credential: Pick<CredentialClaim, 'spaceId' | 'scope' | 'projectId' | 'userId'>
  ): boolean {
    // 1. Space isolation: Must strictly belong to the same space
    if (context.spaceId !== credential.spaceId) {
      return false;
    }

    // 2. Scope-specific authorization checks
    switch (credential.scope) {
      case 'user': {
        // User-Personal credentials require:
        // a) Execution must be in a private scratchpad or authorized direct context
        // b) The acting user must strictly match the credential owner
        if (context.threadKind !== 'private_scratchpad' && context.threadKind !== 'direct_message') {
          return false;
        }
        if (!context.actingUserId || !credential.userId) {
          return false;
        }
        return context.actingUserId === credential.userId;
      }

      case 'project': {
        // Project-Bound credentials require matching project ID
        if (!context.projectId || !credential.projectId) {
          return false;
        }
        return context.projectId === credential.projectId;
      }

      case 'space': {
        // Space-Shared credentials are valid for any authorized caller in this space
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * Asserts access and throws a deterministic SecurityError if unauthorized.
   */
  static assertCredentialAccess(
    context: SecurityContext,
    credential: Pick<CredentialClaim, 'spaceId' | 'scope' | 'projectId' | 'userId'>
  ): void {
    if (!this.isCredentialAccessAllowed(context, credential)) {
      throw new Error(
        `[Gatekeeper] Access Denied: Caller (user=${context.actingUserId ?? 'anon'}, project=${context.projectId ?? 'none'}, threadKind=${context.threadKind}) ` +
        `is not authorized to access ${credential.scope}-scoped credential in space ${context.spaceId}.`
      );
    }
  }

  /**
   * Prevents user identity impersonation or cross-user credential theft in MCP hub calls.
   */
  static validateToolExecutionCaller(
    invokerUserId: string | undefined,
    targetUserId: string | undefined
  ): boolean {
    if (!targetUserId) return true; // Target is space/project bound
    if (!invokerUserId) return false; // Unauthenticated caller requesting personal tool
    return invokerUserId === targetUserId;
  }
}
