export type GadgetTier = 1 | 2 | 3;

export interface GadgetRuntimeConfig {
  engine: "v8_isolate";
  database: "do_facet_sqlite";
  autoMcpV2: boolean;
}

export interface GadgetManifest {
  id: string;              // e.g. "naelao-code-editor-v1"
  slug: string;            // e.g. "editor"
  name: string;
  description: string;
  tier: GadgetTier;
  
  // Viewport Metadata (For Tier 2)
  isViewportProvider: boolean; 
  targetProjectKind?: string; // e.g. "product_dev"
  
  // Runtime Configuration
  runtime: GadgetRuntimeConfig;
}

export type GadgetInstanceStatus = "active" | "hibernating" | "archived";

export interface GadgetInstanceRecord {
  instanceId: string;      // Unique UUID for this specific install
  manifestId: string;      // Pointer to the Gadget template
  slug: string;
  tier: GadgetTier;
  spaceId: string;
  projectId: string | null;   // NULL for Tier 1 (Space-wide / personal)
  ownerUserId: string | null; // PRESENT only for Tier 1 (Privacy)
  configJson: string;         // Instance-specific settings
  status: GadgetInstanceStatus;
  storageUsageBytes: number;
  createdAt: string;
  updatedAt: string;
  doName?: string;
}

export interface InstallGadgetParams {
  manifestId: string;
  slug: string;
  tier: GadgetTier;
  spaceId: string;
  projectId?: string | null;
  ownerUserId?: string | null;
  configJson?: string;
}

export interface ResolveGadgetRosterParams {
  spaceId: string;
  projectId?: string | null;
  userId?: string | null;
}

export interface GadgetRosterItem {
  instance: GadgetInstanceRecord;
  microAppDoName: string;
  microAppDoId: string;
}
