export type CredentialScope = "SPACE_SHARED" | "PROJECT_BOUND" | "USER_PERSONAL";

export interface VaultCredential {
  id: string;
  spaceId: string;
  name: string; // The logical alias, e.g. "STRIPE_SECRET_KEY"
  scope: CredentialScope;
  ownerUserId?: string; // Required if scope === "USER_PERSONAL"
  boundProjectId?: string; // Required if scope === "PROJECT_BOUND"
  encryptedValue: string; // AES-256-GCM encrypted
  createdAt: string;
  updatedAt: string;
}

export interface RunResolutionContext {
  actingUserId?: string;
  projectId?: string;
  isSystemCron?: boolean;
}
