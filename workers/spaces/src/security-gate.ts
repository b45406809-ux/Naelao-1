import { ExportedBlueprintManifest, SecurityAuditReport, SecurityViolation } from "@naelao/types";

// Patterns commonly used in prompt injection, jailbreaks, or exfiltration
const EXFILTRATION_REGEXES = [
  /https?:\/\/(?:www\.)?(?:webhook\.site|requestbin|pipedream\.net|hookbin|pastebin\.com|ngrok\.io|localtunnel\.me)/i,
  /(?:curl|wget|fetch)\s+(?:-[a-zA-Z]+\s+)*https?:\/\/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/i,
  /base64\s+decode/i,
  /exfiltrat(?:e|ing|ion)/i
];

const INJECTION_OVERRIDE_REGEXES = [
  /ignore\s+(?:all\s+)?(?:previous|prior|system)\s+(?:instructions|prompts|rules)/i,
  /disregard\s+(?:all\s+)?(?:safety|system)\s+(?:guidelines|rules)/i,
  /you\s+are\s+now\s+in\s+(?:developer|unrestricted|god)\s+mode/i,
  /bypass\s+(?:security|firewall|guardrails)/i
];

export class SecurityGateAuditor {
  static audit(blueprint: ExportedBlueprintManifest): SecurityAuditReport {
    const violations: SecurityViolation[] = [];

    // ── LAYER 1: STATIC STRUCTURAL & CAPABILITY AUDIT ────────────────────────
    for (const project of blueprint.projects) {
      // Rule 1: Customer support and voice bots cannot touch Tier 6 Containers or Tier 5 Chromium
      if (project.kind === "customer_bot" || project.kind === "voice_agent") {
        if (project.allowedLadderTiers.some(tier => tier >= 5)) {
          violations.push({
            id: `CAP-001-${project.slug}`,
            severity: "CRITICAL",
            category: "CAPABILITY_ESCALATION",
            targetResource: `project:${project.slug}`,
            description: `Project kind '${project.kind}' attempts to bind execution ladder Tier 5 or 6.`,
            recommendation: "Clamp customer-facing and voice projects strictly to Tier 1 and 2 (Safe RAG / Isolates)."
          });
        }
      }

      // Rule 2: Non-dev projects cannot bind native compilers
      if (project.kind !== "product_dev" && project.kind !== "model_studio") {
        if (project.allowedLadderTiers.includes(6)) {
          violations.push({
            id: `CAP-002-${project.slug}`,
            severity: "HIGH",
            category: "CAPABILITY_ESCALATION",
            targetResource: `project:${project.slug}`,
            description: `Project kind '${project.kind}' declares Tier 6 container compilation without being a developer studio.`,
            recommendation: "Remove Tier 6 container access unless the project kind is 'product_dev' or 'model_studio'."
          });
        }
      }
    }

    // ── LAYER 2: PROMPT INJECTION & EXFILTRATION AUDIT ───────────────────────
    // Audit Knowledge Seeds
    for (const seed of blueprint.knowledgeSeeds) {
      for (const pattern of EXFILTRATION_REGEXES) {
        if (pattern.test(seed.content)) {
          violations.push({
            id: `EXFIL-001-${Math.random().toString(36).slice(2, 7)}`,
            severity: "CRITICAL",
            category: "EXFILTRATION_RISK",
            targetResource: `knowledge_seed:${seed.title}`,
            description: `Knowledge seed contains an unauthorized third-party exfiltration URL pattern: ${pattern}.`,
            recommendation: "Remove external webhook or pastebin URLs from seed data."
          });
        }
      }

      for (const pattern of INJECTION_OVERRIDE_REGEXES) {
        if (pattern.test(seed.content)) {
          violations.push({
            id: `INJECT-001-${Math.random().toString(36).slice(2, 7)}`,
            severity: "CRITICAL",
            category: "PROMPT_INJECTION",
            targetResource: `knowledge_seed:${seed.title}`,
            description: `Knowledge seed contains system instruction override / jailbreak pattern: ${pattern}.`,
            recommendation: "Remove adversarial override text."
          });
        }
      }
    }

    // Audit System Directives & Linter Rules
    for (const project of blueprint.projects) {
      for (const rule of project.linterRules) {
        if (rule.includes("eval(") || rule.includes("Function(") || rule.includes("require('child_process')")) {
          violations.push({
            id: `LINTER-001-${project.slug}`,
            severity: "CRITICAL",
            category: "PROMPT_INJECTION",
            targetResource: `linter:${project.slug}`,
            description: "Custom linter rule contains unsafe arbitrary code evaluation.",
            recommendation: "Use declarative linter regex rules instead of raw dynamic function calls."
          });
        }
      }
    }

    // ── CALCULATE SCORE ──────────────────────────────────────────────────────
    let score = 100;
    for (const v of violations) {
      if (v.severity === "CRITICAL") score -= 100;
      else if (v.severity === "HIGH") score -= 25;
      else if (v.severity === "MEDIUM") score -= 10;
      else if (v.severity === "LOW") score -= 5;
    }

    const finalScore = Math.max(0, score);
    const hasFatal = violations.some(v => v.severity === "CRITICAL" || v.severity === "HIGH");

    return {
      score: finalScore,
      passed: finalScore >= 80 && !hasFatal,
      auditedAt: new Date().toISOString(),
      violations
    };
  }
}
