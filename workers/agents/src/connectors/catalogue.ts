/**
 * Connector catalogue (Naelao-authored, like SpaceTypes — CLAUDE.md #7).
 *
 * A "connector" is how the script-native agent reaches an external creator platform (Whop,
 * Gumroad, Beehiiv, …). It is NOT a hardcoded integration: each entry below is DATA describing
 * how to register the platform as an MCP server (mcp-connector / mcp-hub) and what operations it
 * exposes. The agent then reaches the platform purely through script.run("mcp.call", …). Adding a
 * connector is adding a row here + (optionally) hosting its MCP shim — never a code branch.
 *
 * "Whop first, everything else coming soon": Whop is `available`; the rest of the creator-economy
 * platforms are `coming_soon` placeholders the dashboard renders greyed out. Flipping one on is a
 * one-field change here once its MCP shim is hosted.
 *
 * MODEL A (automation layer): these connectors are READ-mostly — the platform processes payments,
 * the agent reads orders/members and does the labor (fulfil, support, market). They therefore
 * carry NO money-in operations. Money-in stays on Naelao's reserved commerce path (model B). The
 * mcp-connector + mcp-hub reserved guard enforces this even if a connector mis-declares a tool.
 */

export type ConnectorStatus = "available" | "coming_soon";

export type ConnectorCategory =
  | "course_product"
  | "newsletter"
  | "community"
  | "booking"
  | "marketplace"
  | "freelance"
  | "social";

export interface ConnectorOperation {
  /** The MCP tool name the agent calls via script.run("mcp.call", { server, tool, params }). */
  name: string;
  description: string;
  /** read = pulls data; write = posts/sends (never money-in — that's reserved to commerce). */
  kind: "read" | "write";
}

export interface ConnectorAuth {
  /** Matches mcp-hub auth_type. Bearer/api_key resolve a vault credential at call time. */
  type: "bearer" | "api_key" | "none";
  /** The space_credentials NAME the builder's key is stored under (never the key itself). */
  credential_name: string;
}

/** How a connector signs + shapes its inbound webhooks (consumed by the webhook normalizer). */
export interface ConnectorWebhookSpec {
  signature_header: string;
  signature_encoding: "hex" | "base64";
  signature_prefix?: string;
  event_path: string;
  secret_credential_name: string;
}

export interface ConnectorDefinition {
  id: string;
  name: string;
  category: ConnectorCategory;
  status: ConnectorStatus;
  summary: string;
  /** Docs the builder/agent can consult. */
  docs_url?: string;
  auth: ConnectorAuth;
  /** Inbound webhook signing/shape (absent when the platform has no webhooks). */
  webhook?: ConnectorWebhookSpec;
  /**
   * Canonical MCP endpoint for the platform's shim (Naelao-hosted or a hosted gateway like
   * Composio/Pipedream). The connect flow may override per deploy via env. Absent for
   * coming-soon entries.
   */
  mcp_endpoint?: string;
  /** The wrapper surface — the operations the agent expects (also discoverable via mcp.list_tools). */
  operations?: ConnectorOperation[];
}

// ── The catalogue ─────────────────────────────────────────────────────────────

const WHOP: ConnectorDefinition = {
  id: "whop",
  name: "Whop",
  category: "course_product",
  status: "available",
  summary:
    "Communities, memberships, courses and digital products on Whop. The agent reads memberships, " +
    "members, orders and payments, and posts community updates — Whop keeps processing the payments.",
  docs_url: "https://dev.whop.com/api-reference",
  auth: { type: "bearer", credential_name: "WHOP_API_KEY" },
  mcp_endpoint: "https://mcp.naelao.com/connectors/whop",
  webhook: {
    signature_header: "x-whop-signature",
    signature_encoding: "hex",
    event_path: "action",
    secret_credential_name: "WHOP_WEBHOOK_SECRET",
  },
  operations: [
    { name: "list_memberships", description: "List the company's memberships (active/expired).", kind: "read" },
    { name: "get_membership", description: "Get one membership by id (status, plan, member).", kind: "read" },
    { name: "list_members", description: "List members/users who have access.", kind: "read" },
    { name: "list_products", description: "List access passes / products the company sells.", kind: "read" },
    { name: "list_payments", description: "List recent payments/receipts (read-only; Whop processes them).", kind: "read" },
    { name: "list_plans", description: "List pricing plans attached to a product.", kind: "read" },
    { name: "send_message", description: "Send a direct message to a member.", kind: "write" },
    { name: "post_announcement", description: "Post an announcement to a community/feed.", kind: "write" },
  ],
};

/** Coming-soon placeholders — UI greys these out. Authored as data so flipping one on is trivial. */
function comingSoon(
  id: string,
  name: string,
  category: ConnectorCategory,
  summary: string,
  credential_name: string,
  docs_url?: string
): ConnectorDefinition {
  return { id, name, category, status: "coming_soon", summary, auth: { type: "bearer", credential_name }, ...(docs_url ? { docs_url } : {}) };
}

export const CONNECTOR_CATALOGUE: ConnectorDefinition[] = [
  WHOP,
  // Course / product platforms
  comingSoon("gumroad", "Gumroad", "course_product", "Digital downloads, courses and memberships on Gumroad.", "GUMROAD_API_KEY", "https://gumroad.com/api"),
  comingSoon("stan-store", "Stan Store", "course_product", "Link-in-bio storefront, courses and bookings.", "STAN_API_KEY"),
  comingSoon("teachable", "Teachable", "course_product", "Online courses and coaching.", "TEACHABLE_API_KEY"),
  comingSoon("thinkific", "Thinkific", "course_product", "Courses, communities and memberships.", "THINKIFIC_API_KEY"),
  comingSoon("kajabi", "Kajabi", "course_product", "Courses, podcasts, newsletters and coaching.", "KAJABI_API_KEY"),
  comingSoon("podia", "Podia", "course_product", "Courses, digital downloads and webinars.", "PODIA_API_KEY"),
  comingSoon("payhip", "Payhip", "course_product", "Courses, ebooks, software and memberships.", "PAYHIP_API_KEY"),
  // Communities
  comingSoon("skool", "Skool", "community", "Communities + courses combined (no public API — needs browser tier).", "SKOOL_API_KEY"),
  comingSoon("circle", "Circle", "community", "Paid communities and member spaces.", "CIRCLE_API_KEY"),
  comingSoon("maven", "Maven", "community", "Cohort-based courses.", "MAVEN_API_KEY"),
  // Newsletter
  comingSoon("beehiiv", "Beehiiv", "newsletter", "Newsletters, boosts and ad network.", "BEEHIIV_API_KEY", "https://developers.beehiiv.com"),
  comingSoon("substack", "Substack", "newsletter", "Paid newsletters and podcasts (no official API — needs browser tier).", "SUBSTACK_API_KEY"),
  comingSoon("ghost", "Ghost", "newsletter", "Memberships and newsletters.", "GHOST_ADMIN_API_KEY", "https://ghost.org/docs/admin-api"),
  comingSoon("patreon", "Patreon", "newsletter", "Memberships and exclusive content.", "PATREON_API_KEY"),
  // Booking
  comingSoon("calcom", "Cal.com", "booking", "Open-source paid bookings and scheduling.", "CALCOM_API_KEY", "https://cal.com/docs/api-reference"),
  comingSoon("calendly", "Calendly", "booking", "Paid bookings and scheduling.", "CALENDLY_API_KEY"),
  // Marketplace
  comingSoon("etsy", "Etsy", "marketplace", "Digital downloads, templates and printables.", "ETSY_API_KEY", "https://developers.etsy.com"),
];

// ── Helpers ─────────────────────────────────────────────────────────────────

const BY_ID = new Map(CONNECTOR_CATALOGUE.map((c) => [c.id, c]));

export function getConnector(id: string): ConnectorDefinition | null {
  return BY_ID.get(id) ?? null;
}

export function availableConnectors(): ConnectorDefinition[] {
  return CONNECTOR_CATALOGUE.filter((c) => c.status === "available");
}

export function isConnectorAvailable(id: string): boolean {
  return getConnector(id)?.status === "available";
}

/** Validate at module load: ids unique, available connectors are fully specified, no money-in ops. */
const MONEY_IN_OP = /(checkout|charge|payout|refund|withdraw|collect[_-]?payment|create[_-]?payment)/i;
export function validateConnectorCatalogue(cat: ConnectorDefinition[] = CONNECTOR_CATALOGUE): void {
  const seen = new Set<string>();
  for (const c of cat) {
    if (seen.has(c.id)) throw new Error(`Connector catalogue: duplicate id '${c.id}'`);
    seen.add(c.id);
    if (c.status === "available") {
      if (!c.mcp_endpoint) throw new Error(`Connector '${c.id}' is available but has no mcp_endpoint`);
      if (!c.operations || c.operations.length === 0) throw new Error(`Connector '${c.id}' is available but declares no operations`);
      for (const op of c.operations) {
        if (MONEY_IN_OP.test(op.name)) {
          throw new Error(`Connector '${c.id}' op '${op.name}' looks like money-in — reserved to the commerce script`);
        }
      }
    }
  }
}

validateConnectorCatalogue();
