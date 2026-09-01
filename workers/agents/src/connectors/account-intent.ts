/**
 * Connector Account Intelligence — 3-Layer Intent & Context Filter
 *
 * Makes connector account selection (Personal Account vs Company Shared Workspace)
 * completely seamless and foolproof:
 *
 * Layer 1: THREAD CONTEXT DEFAULT
 *  - Tier 4 Private Scratchpads / 1-on-1s: Default = User's Personal Account (Gmail/Calendar/Drive)
 *  - Tier 1/2 Public Team Rooms & Customer Bots: Default = Company Shared Account (Corporate Drive/Inbox/Schedule)
 *
 * Layer 2: LINGUISTIC INTENT DETECTION
 *  - "My" words -> Personal Account ("Check my unread emails", "Block 2 hours on my calendar", "search my drive", "send from my account")
 *  - "Our/Company" words -> Company Shared ("Book client consultation on our schedule", "Post this update to our company Twitter", "upload to our company drive")
 *
 * Layer 3: VISUAL SCOPE PILL IN THE UI (ComposerDock) & INLINE AMBIGUITY CARD
 *  - Right above the chat box, a small clickable pill shows the active account:
 *    `[ 🔒 Using: Alice's Personal Gmail ]` -> (Click to switch to `[ 🏢 Company Shared Inbox ]`)
 *  - If Ambiguous, the Agent Asks Inline (Single-Click Card):
 *    "Where would you like me to book this meeting?" [ 👤 Alice's Personal Calendar ] or [ 🏢 Miami Dental Clinic Schedule ]
 */

import type {
  ConnectorAccountScope,
  ConnectorAccountResolution,
  ConnectorClarificationCardMetadata,
  ConnectorAccountOption,
} from "@naelao/types";

// ── Regex Pattern Matchers for Linguistic Intent ─────────────────────────────

const PERSONAL_INTENT_PATTERNS = [
  /\b(my|mine|personal|myself)\s+(calendar|email|emails|inbox|mail|gmail|outlook|drive|google\s*drive|schedule|account|meetings?|appointments?|docs?|files?|notes?|tasks?|reminders?)\b/i,
  /\b(check|read|search|find|view|open|show)\s+(in\s+)?(my|mine)\b/i,
  /\b(block|book|reserve|schedule|add)\s+.*?\s+(on|in|to)\s+my\s+(calendar|schedule|agenda)\b/i,
  /\bsend\s+(from|via|through|using)\s+my\s+(email|account|address|mail)\b/i,
  /\b(for\s+me|my\s+schedule|my\s+todo|my\s+day|my\s+afternoon|my\s+morning)\b/i,
  /\b(draft\s+from\s+my|create\s+in\s+my)\b/i,
];

const COMPANY_SHARED_INTENT_PATTERNS = [
  /\b(our|company|team|corporate|clinic|office|business|storefront|shop|firm|shared|public)\s+(calendar|email|emails|inbox|mail|gmail|drive|google\s*drive|schedule|account|twitter|x|slack|discord|website|customers?|pipeline|crm|leads?|tickets?)\b/i,
  /\b(post|publish|share|tweet|broadcast)\s+.*?\s+(to|on)\s+(our|the\s+company|the\s+team)\b/i,
  /\b(book|schedule|reserve)\s+(client|patient|customer|prospect|lead)\s+(consultation|appointment|call|demo|meeting)\s+(on|in)\s+(our|the\s+company|the\s+shared)\b/i,
  /\bupload\s+.*?\s+to\s+(our|the\s+company|the\s+corporate)\s+drive\b/i,
  /\b(company\s+inbox|team\s+schedule|office\s+calendar|shared\s+inbox|support\s+desk)\b/i,
];

/**
 * Layer 2: Detect Linguistic Intent from user message text
 */
export function detectConnectorAccountIntent(messageText: string): "personal" | "company_shared" | "ambiguous" {
  if (!messageText || typeof messageText !== "string") return "ambiguous";
  const trimmed = messageText.trim();
  if (!trimmed) return "ambiguous";

  const hasPersonal = PERSONAL_INTENT_PATTERNS.some((pattern) => pattern.test(trimmed));
  const hasCompany = COMPANY_SHARED_INTENT_PATTERNS.some((pattern) => pattern.test(trimmed));

  if (hasPersonal && !hasCompany) return "personal";
  if (hasCompany && !hasPersonal) return "company_shared";
  return "ambiguous";
}

/**
 * Layer 1: Determine default connector scope based on Thread Tier & Project Kind
 */
export function getThreadTierDefaultConnectorScope(
  tier?: number,
  projectKind?: string,
  isPrivateThread?: boolean
): "personal" | "company_shared" {
  // Tier 4 Private Scratchpad / 1-on-1s default to personal accounts
  if (tier === 4 || isPrivateThread) {
    return "personal";
  }

  // Customer bots, public support, CRM, and lower tiers default to company shared accounts
  if (tier === 1 || tier === 2 || projectKind === "customer_bot" || projectKind === "support_inbox" || projectKind === "crm") {
    return "company_shared";
  }

  // Tier 3 or unclassified default to company shared for collaborative business spaces
  return "company_shared";
}

/**
 * Full 3-Layer Connector Account Resolution
 */
export function resolveConnectorAccountIntent(params: {
  connectorId: string;
  messageText: string;
  tier?: number;
  projectKind?: string;
  isPrivateThread?: boolean;
  userStoredMode?: "personal" | "business" | "company_shared";
  userName?: string;
  companyName?: string;
}): ConnectorAccountResolution {
  const {
    connectorId,
    messageText,
    tier,
    projectKind,
    isPrivateThread,
    userStoredMode,
    userName = "User",
    companyName = "Company Shared",
  } = params;

  // Layer 3 priority: Explicit user session pill override
  if (userStoredMode) {
    const scope: ConnectorAccountScope = userStoredMode === "personal" ? "personal" : "company_shared";
    return {
      connectorId,
      accountScope: scope,
      source: "composer_pill_override",
      confidence: 1.0,
      userName,
      companyName,
      ambiguous: false,
    };
  }

  // Layer 2: Linguistic Intent Detection
  const linguisticIntent = detectConnectorAccountIntent(messageText);

  if (linguisticIntent === "personal") {
    return {
      connectorId,
      accountScope: "personal",
      source: "linguistic_intent",
      confidence: 0.95,
      userName,
      companyName,
      ambiguous: false,
    };
  }

  if (linguisticIntent === "company_shared") {
    return {
      connectorId,
      accountScope: "company_shared",
      source: "linguistic_intent",
      confidence: 0.95,
      userName,
      companyName,
      ambiguous: false,
    };
  }

  // Layer 1: Context / Thread Tier Fallback
  const tierDefault = getThreadTierDefaultConnectorScope(tier, projectKind, isPrivateThread);

  // Check if the query has generic action verbs that would benefit from an inline single-click card
  const isActionRequiringAccount = /\b(book|schedule|email|send|save|upload|read|check|create\s+meeting|calendar)\b/i.test(messageText);
  const isAmbiguous = isActionRequiringAccount && !isPrivateThread && tier !== 4;

  const options: ConnectorAccountOption[] = [
    {
      scope: "personal",
      label: `${userName}'s Personal ${getConnectorDisplayName(connectorId)}`,
      description: "Private user account",
      icon: "👤",
    },
    {
      scope: "company_shared",
      label: `${companyName} Schedule`,
      description: "Shared workspace account",
      icon: "🏢",
    },
  ];

  return {
    connectorId,
    accountScope: tierDefault,
    source: "thread_tier_default",
    confidence: isAmbiguous ? 0.6 : 0.85,
    userName,
    companyName,
    ambiguous: isAmbiguous,
    options: isAmbiguous ? options : undefined,
  };
}

/**
 * Format inline Single-Click Clarification Card payload
 */
export function buildConnectorClarificationCard(params: {
  connectorId: string;
  actionDescription?: string;
  userName?: string;
  companyName?: string;
}): ConnectorClarificationCardMetadata {
  const {
    connectorId,
    actionDescription = "perform this action",
    userName = "Your",
    companyName = "Company Shared",
  } = params;

  const connLabel = getConnectorDisplayName(connectorId);

  return {
    connector_id: connectorId,
    prompt_question: `Where would you like me to ${actionDescription}?`,
    options: [
      {
        scope: "personal",
        label: `${userName} Personal ${connLabel}`,
        description: "Use your private connected account",
        icon: "👤",
      },
      {
        scope: "company_shared",
        label: `${companyName} ${connLabel}`,
        description: "Use the shared organization account",
        icon: "🏢",
      },
    ],
  };
}

export function getConnectorDisplayName(connectorId: string): string {
  const nameMap: Record<string, string> = {
    google_calendar: "Calendar",
    google_drive: "Drive",
    google_gmail: "Gmail",
    gmail: "Gmail",
    slack: "Slack",
    discord: "Discord",
    notion: "Notion",
    github: "GitHub",
    hubspot: "HubSpot",
    twitter: "X / Twitter",
  };
  return nameMap[connectorId] || connectorId.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
