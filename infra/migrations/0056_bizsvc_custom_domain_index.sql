-- Security audit follow-up: CORS_ALLOWLIST was one static platform-wide env var, which can't
-- scale to arbitrary per-builder custom domains (or even the platform's own {slug}.naelao.com
-- product subdomains, which were never added to it at all). The router now resolves an
-- unrecognized Origin dynamically against spaces.product_slug and this table's custom_domain
-- column (see workers/router/src/index.ts's isOriginAllowed) — this index is what keeps that
-- lookup a real index scan instead of a full table scan once there are many businesses running
-- custom domains ("millions of builders").
CREATE INDEX IF NOT EXISTS idx_bizsvc_custom_domain ON business_services(custom_domain) WHERE custom_domain IS NOT NULL;
