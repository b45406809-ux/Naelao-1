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
  | "social"
  | "voice"
  | "support"
  | "content_gen"
  | "crm"
  | "ads"
  | "email"
  | "productivity";

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

/**
 * OAuth2 + PKCE "Sign in with X" support — a real-account redirect flow (Whop's Developer
 * Dashboard OAuth app model), distinct from the manual-API-key-paste path `auth` above already
 * supports. Self-serve, no invite needed (unlike Whop's separate Platforms/connected-accounts
 * API used by the business-wallet rail). Client id/secret are env-var NAMES, never values —
 * resolved from Workers Secrets at request time by the routes that use this config.
 */
export interface ConnectorOAuthSpec {
  authorize_url: string;
  token_url: string;
  scopes: string[];
  client_id_env: string;
  client_secret_env: string;
  /** The credential name the resolved {access_token, refresh_token, expires_at} JSON blob is
   *  vaulted under — mcp-hub's buildAuthHeaders recognizes this shape via auth_type "oauth2". */
  credential_name: string;
  /** Optional OpenID Connect userinfo endpoint (requires an `openid` scope above). When present,
   *  the callback resolves the connecting account's stable `sub` and uses it to detect the same
   *  real-world account being connected to more than one business under this tenant — a soft,
   *  best-effort warning (never a hard block: a builder may legitimately share one account across
   *  related businesses), since a BYO "Connect with X" account has no platform-enforced isolation
   *  the way the Whop sub-merchant wallet rail (business-wallet.ts) does. */
  userinfo_url?: string;
}

/**
 * Composio "click Install" hosted-connect support (composio.ts). Naelao holds ONE platform
 * Composio API key (mcp-hub's COMPOSIO_API_KEY, universal-tools doctrine — CLAUDE.md item 42);
 * a connector marked with this field never needs the builder to paste an API key at all — they
 * click Connect, authenticate on Composio's own hosted page for the real app (Twitter, HubSpot,
 * Google Ads, …), and mcp-hub reaches it afterward via the resulting connected-account reference.
 * `auth_config_id_env` is an env var NAME (never a value in code) holding the Composio "Auth
 * Config" id pre-created once in the Composio dashboard for this app; when unset the connect
 * flow degrades honestly (`provider_not_configured`), never silently falling back to manual key
 * entry.
 */
export interface ConnectorComposioSpec {
  /** Composio's toolkit/app slug (informational — the real routing is via auth_config_id). */
  toolkit_slug: string;
  auth_config_id_env: string;
}

/**
 * Pipedream Connect hosted-connect support (pipedream.ts) — the second hosted "click Install"
 * provider behind the SAME /provider-connect/* routes and shell UI as Composio. Naelao holds ONE
 * platform Pipedream OAuth client (PIPEDREAM_CLIENT_ID/CLIENT_SECRET, universal-tools doctrine);
 * unlike Composio, Pipedream needs no pre-created per-app "Auth Config" for managed auth — the
 * connector only needs to name the app's Pipedream slug. Mutually exclusive with `composio` in
 * practice (not enforced) — a connector picks whichever hosted provider actually lists the app.
 */
export interface ConnectorPipedreamSpec {
  /** Pipedream's app slug (e.g. "notion", "airtable") — passed as the Connect Link's `?app=`. */
  app_slug: string;
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
  /** Present when this connector ALSO supports a "Connect with X" OAuth redirect, as an
   *  alternative to pasting `auth.credential_name`'s API key by hand. */
  oauth?: ConnectorOAuthSpec;
  /** Present when this connector is reached via Composio's hosted click-to-install flow instead
   *  of a bespoke OAuth app or a manual API key. Mutually exclusive with `oauth` in practice
   *  (not enforced) — a connector picks whichever mechanism its real platform actually supports. */
  composio?: ConnectorComposioSpec;
  /** Present when this connector is reached via Pipedream's hosted click-to-install flow. See
   *  ConnectorPipedreamSpec's header. */
  pipedream?: ConnectorPipedreamSpec;
  /**
   * Canonical MCP endpoint for the platform's shim (Naelao-hosted, or the platform's own hosted
   * MCP server e.g. Higgsfield's). Absent for coming-soon entries AND for composio/pipedream-
   * routed connectors (the provider resolves the endpoint — mirrors mcp-hub's own registration
   * rule that `url` is optional for provider-routed connectors).
   */
  mcp_endpoint?: string;
  /** The wrapper surface — the operations the agent expects (also discoverable via mcp.list_tools).
   *  For a composio/pipedream-routed connector these are illustrative (the provider exposes the
   *  live tool list per app; the agent discovers the real names via mcp.list_tools after
   *  connecting), not a contract enforced against the provider. */
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
  // "Sign in with Whop" — a real OAuth2+PKCE app registered once in Whop's Developer Dashboard
  // (self-serve, no invite — a completely separate mechanism from the invite-gated Platforms/
  // connected-accounts API the business-wallet rail uses). Exact endpoint paths per Whop's
  // published OAuth guide; verify against the live Whop Developer Dashboard when registering the
  // app, since this wasn't exercised against a real Whop OAuth app in this pass.
  oauth: {
    authorize_url: "https://api.whop.com/oauth/authorize",
    token_url: "https://api.whop.com/oauth/token",
    // `openid` is required for the userinfo lookup below (same-account-multiple-businesses
    // detection); `profile` isn't needed since only the stable `sub` is used, not the name/avatar.
    // checkout_configuration:create/plan:create/access_pass:create+update/
    // checkout_configuration:basic:read (added for the end-user billing pivot) let the connected
    // business's OWN Whop company create plans + checkout links for its own end-user
    // subscriptions/credit-packs (workers/billing/src/whop-oauth-billing.ts) — a genuinely new
    // money-in capability beyond the original read-only connect, so an ALREADY-connected business
    // must re-consent once for the widened scope (OAuth doesn't retroactively grant new scopes to
    // an existing token).
    scopes: [
      "openid", "read_memberships", "read_payments",
      "checkout_configuration:create", "checkout_configuration:basic:read",
      "plan:create", "access_pass:create", "access_pass:update",
    ],
    client_id_env: "WHOP_OAUTH_CLIENT_ID",
    client_secret_env: "WHOP_OAUTH_CLIENT_SECRET",
    credential_name: "WHOP_OAUTH_TOKENS",
    userinfo_url: "https://api.whop.com/oauth/userinfo",
  },
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

const GUMROAD: ConnectorDefinition = {
  id: "gumroad",
  name: "Gumroad",
  category: "course_product",
  status: "available",
  summary:
    "Digital downloads, courses and memberships on Gumroad. The agent reads products, sales and " +
    "subscribers and follows up with buyers — Gumroad keeps processing the payments.",
  docs_url: "https://app.gumroad.com/api",
  auth: { type: "bearer", credential_name: "GUMROAD_ACCESS_TOKEN" },
  mcp_endpoint: "https://mcp.naelao.com/connectors/gumroad",
  // Gumroad's "Ping" webhook isn't HMAC-signed, so it doesn't fit the signature normalizer;
  // the agent polls sales on a cron instead (no `webhook` spec here, by design).
  operations: [
    { name: "list_products", description: "List the seller's products.", kind: "read" },
    { name: "get_product", description: "Get one product by id.", kind: "read" },
    { name: "list_sales", description: "List recent sales (read-only; Gumroad processes them).", kind: "read" },
    { name: "list_subscribers", description: "List subscribers for a product.", kind: "read" },
  ],
};

/**
 * Higgsfield — image/video generation (G-3). Unlike the social connectors below, Higgsfield
 * ships its OWN hosted MCP server (mcp.higgsfield.ai/mcp, launched 2026-04-30) that the builder's
 * OWN Higgsfield account key unlocks directly — no Composio mediation needed, so this fits the
 * existing "direct" bearer-auth pattern (same shape as Whop/Gumroad) rather than the new
 * `composio` field. 30+ models reachable through it (Kling, Veo, Sora, Seedream, …); exact tool
 * names are discoverable via mcp.list_tools on first connect (not hand-verified against a live
 * key in this pass — see composio.ts's header for the same "confirm once real access exists"
 * precedent applied here to Higgsfield's own API instead).
 */
const HIGGSFIELD: ConnectorDefinition = {
  id: "higgsfield",
  name: "Higgsfield",
  category: "content_gen",
  status: "available",
  summary:
    "AI image and video generation — 30+ models (Kling, Veo, Sora, Seedream and more) through one " +
    "hosted MCP server. Generate product shots, social video, and talking-head clips for the business.",
  docs_url: "https://higgsfield.ai/mcp",
  auth: { type: "bearer", credential_name: "HIGGSFIELD_API_KEY" },
  mcp_endpoint: "https://mcp.higgsfield.ai/mcp",
  operations: [
    { name: "generate_image", description: "Generate an image from a text prompt (choose a model).", kind: "write" },
    { name: "generate_video", description: "Generate a short video from a text prompt or image.", kind: "write" },
    { name: "list_models", description: "List the image/video models available on this account's plan.", kind: "read" },
  ],
};

/** Composio-routed social connectors (G-1) — the builder clicks Connect, authenticates on the
 *  real platform via Composio's own hosted page, done. No API key ever entered by hand. */
function composioSocial(
  id: string,
  name: string,
  toolkit_slug: string,
  auth_config_id_env: string,
  summary: string,
  operations: ConnectorOperation[]
): ConnectorDefinition {
  return {
    id,
    name,
    category: "social",
    status: "available",
    summary,
    auth: { type: "none", credential_name: "" },
    composio: { toolkit_slug, auth_config_id_env },
    operations,
  };
}

const POST_OP: ConnectorOperation = { name: "create_post", description: "Publish a post/tweet/update.", kind: "write" };
const SCHEDULE_OP: ConnectorOperation = { name: "schedule_post", description: "Schedule a post for later.", kind: "write" };
const ANALYTICS_OP: ConnectorOperation = { name: "get_analytics", description: "Read post/account performance metrics.", kind: "read" };

const TWITTER: ConnectorDefinition = composioSocial(
  "twitter", "X (Twitter)", "twitter", "COMPOSIO_TWITTER_AUTH_CONFIG_ID",
  "Post and schedule to X/Twitter, read engagement metrics — connected via Composio's hosted auth.",
  [POST_OP, SCHEDULE_OP, ANALYTICS_OP, { name: "list_mentions", description: "List recent mentions/replies.", kind: "read" }]
);
const LINKEDIN: ConnectorDefinition = composioSocial(
  "linkedin", "LinkedIn", "linkedin", "COMPOSIO_LINKEDIN_AUTH_CONFIG_ID",
  "Post company/personal updates and read engagement on LinkedIn — connected via Composio's hosted auth.",
  [POST_OP, ANALYTICS_OP]
);
const INSTAGRAM: ConnectorDefinition = composioSocial(
  "instagram", "Instagram", "instagram", "COMPOSIO_INSTAGRAM_AUTH_CONFIG_ID",
  "Publish posts, carousels and stories, read insights — connected via Composio's hosted auth.",
  [POST_OP, SCHEDULE_OP, ANALYTICS_OP]
);
const TIKTOK: ConnectorDefinition = composioSocial(
  "tiktok", "TikTok", "tiktok", "COMPOSIO_TIKTOK_AUTH_CONFIG_ID",
  "Publish videos, schedule uploads, read analytics and comments — connected via Composio's hosted auth.",
  [POST_OP, SCHEDULE_OP, ANALYTICS_OP, { name: "list_comments", description: "List comments on a video.", kind: "read" }]
);

/**
 * Notion — the first Pipedream-routed connector (the composioSocial helper above is Composio-
 * specific; Notion is reached through Pipedream's managed auth instead, proving the second
 * hosted-provider mechanism end-to-end). No API key ever entered by hand — click Connect,
 * authenticate on Notion's own consent page via Pipedream's hosted Connect Link, done.
 */
const NOTION: ConnectorDefinition = {
  id: "notion",
  name: "Notion",
  category: "productivity",
  status: "available",
  summary:
    "Read and write Notion pages and databases — connected via Pipedream's hosted auth. Useful for " +
    "a knowledge base, content calendar, or internal docs the assistant keeps up to date.",
  auth: { type: "none", credential_name: "" },
  pipedream: { app_slug: "notion" },
  operations: [
    { name: "list_databases", description: "List databases the connected account can access.", kind: "read" },
    { name: "query_database", description: "Query rows/pages in a database.", kind: "read" },
    { name: "create_page", description: "Create a new page in a database.", kind: "write" },
    { name: "update_page", description: "Update an existing page's properties or content.", kind: "write" },
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

/** Coming-soon Composio-routed placeholder — no builder credential at all once flipped on, just
 *  an `auth_config_id_env` to provision. Kept `coming_soon` until that Auth Config exists. */
function comingSoonComposio(
  id: string,
  name: string,
  category: ConnectorCategory,
  toolkit_slug: string,
  auth_config_id_env: string,
  summary: string
): ConnectorDefinition {
  return {
    id, name, category, status: "coming_soon", summary,
    auth: { type: "none", credential_name: "" },
    composio: { toolkit_slug, auth_config_id_env },
  };
}

export const CONNECTOR_CATALOGUE: ConnectorDefinition[] = [
  WHOP,
  GUMROAD,
  HIGGSFIELD,
  TWITTER,
  LINKEDIN,
  INSTAGRAM,
  TIKTOK,
  NOTION,
  // CRM / ads / advanced email — Composio-routed, data-only until an Auth Config is provisioned.
  comingSoonComposio("hubspot", "HubSpot", "crm", "hubspot", "COMPOSIO_HUBSPOT_AUTH_CONFIG_ID", "CRM/lead pipeline — deals, contacts, pipeline stages."),
  comingSoonComposio("google-ads", "Google Ads", "ads", "googleads", "COMPOSIO_GOOGLE_ADS_AUTH_CONFIG_ID", "Campaign performance, budgets, ad group management."),
  comingSoonComposio("meta-ads", "Meta Ads", "ads", "facebook_ads", "COMPOSIO_META_ADS_AUTH_CONFIG_ID", "Meta (Facebook/Instagram) ad campaign management."),
  comingSoonComposio("agentmail", "AgentMail", "email", "agent_mail", "COMPOSIO_AGENTMAIL_AUTH_CONFIG_ID", "Dedicated agent-managed inbox — beyond the built-in business-email default."),
  // Course / product platforms
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
  // Voice / telephony — a voice agent is the same engine reached over a voice channel connector.
  comingSoon("vapi", "Vapi", "voice", "Voice agents over the phone — inbound/outbound calls, transcripts, actions.", "VAPI_API_KEY", "https://docs.vapi.ai"),
  comingSoon("twilio", "Twilio", "voice", "Programmable voice + SMS — telephony for voice agents and notifications.", "TWILIO_AUTH_TOKEN"),
  comingSoon("elevenlabs", "ElevenLabs", "voice", "Realtime voice (TTS/voice agents) for natural-sounding phone + in-app voice.", "ELEVENLABS_API_KEY"),
  // Support / helpdesk — customer-service connectors the support agent drives.
  comingSoon("zendesk", "Zendesk", "support", "Helpdesk tickets — read, reply, and resolve from the support agent.", "ZENDESK_API_TOKEN"),
  comingSoon("intercom", "Intercom", "support", "Customer messaging + inbox the support agent operates.", "INTERCOM_ACCESS_TOKEN"),
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

/**
 * Available connectors that have NO webhook spec — these can't push events, so a cron poller
 * wakes the agent to pull new activity (e.g. Gumroad's Ping isn't HMAC-signed → poll sales).
 * Connectors WITH a webhook (e.g. Whop) are driven by the normalizer instead, not polled.
 */
export function pollableConnectorIds(): string[] {
  return availableConnectors().filter((c) => !c.webhook).map((c) => c.id);
}

/** Validate at module load: ids unique, available connectors are fully specified, no money-in ops. */
const MONEY_IN_OP = /(checkout|charge|payout|refund|withdraw|collect[_-]?payment|create[_-]?payment)/i;
export function validateConnectorCatalogue(cat: ConnectorDefinition[] = CONNECTOR_CATALOGUE): void {
  const seen = new Set<string>();
  for (const c of cat) {
    if (seen.has(c.id)) throw new Error(`Connector catalogue: duplicate id '${c.id}'`);
    seen.add(c.id);
    if (c.status === "available") {
      // Composio/Pipedream-routed connectors have no mcp_endpoint of their own — the provider
      // resolves it (mirrors mcp-hub's own POST /mcp-servers rule that `url` is optional for
      // provider-routed connectors).
      if (!c.composio && !c.pipedream && !c.mcp_endpoint) throw new Error(`Connector '${c.id}' is available but has no mcp_endpoint`);
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
