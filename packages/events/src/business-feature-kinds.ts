export const BUSINESS_FEATURE_KINDS = [
  "general",
  "product_dev",
  "legal_ops",
  "finance_ledger",
  "customer_support",
  "research_synth",
] as const;

export type BusinessFeatureKind = typeof BUSINESS_FEATURE_KINDS[number];
