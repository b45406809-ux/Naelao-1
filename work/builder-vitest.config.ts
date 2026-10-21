import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
const alias = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({ resolve: { alias: {
  "@naelao/billing-core": alias("../packages/billing-core/src/index.ts"),
  "@naelao/security": alias("../packages/security/src/index.ts"),
  "@naelao/auth": alias("../packages/auth/src/index.ts"),
  "@naelao/crypto": alias("../packages/crypto/src/index.ts"),
  "@naelao/db": alias("../packages/db/src/index.ts"),
  "@naelao/events": alias("../packages/events/src/index.ts"),
  "@naelao/types": alias("../packages/types/src/index.ts"),
  "@naelao/agent-sdk": alias("../packages/agent-sdk/src/index.ts"),
  "@naelao/http": alias("../packages/http/src/index.ts"),
  "cloudflare:workers": alias("../tests/stubs/cloudflare-workers.ts"),
} }, test: { environment: "node", include: ["tests/unit/builder-dashboard-api.test.ts"] } });
