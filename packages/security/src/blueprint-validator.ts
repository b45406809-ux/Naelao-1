interface SecurityProject {
  name: string;
  systemPrompt: string;
  starterFiles: Array<{ content: string }>;
  roles?: string[];
  capabilities?: string[];
  executionTier?: number;
}
export interface SecurityBlueprint {
  schemaVersion: string;
  projects: SecurityProject[];
}

export type BlueprintRating = "A+" | "A" | "B" | "REJECTED";
export interface BlueprintSecurityResult {
  rating: BlueprintRating;
  score: number;
  publishable: boolean;
  criticalViolations: string[];
  warnings: string[];
}

const INJECTION =
  /ignore\s+(?:all\s+)?previous\s+instructions|reveal\s+(?:the\s+)?(?:system\s+)?prompt|credential\s+exfiltrat|send\s+(?:all\s+)?(?:secrets|credentials)/i;
const SCRIPT = /<script(?:\s|>)[\s\S]*?<\/script\s*>/i;
const DESTRUCTIVE =
  /^(?:shell|container|exec|terminal|delete_file|rm|format_disk)$/i;

export function evaluateBlueprintSecurity(
  blueprint: SecurityBlueprint
): BlueprintSecurityResult {
  const criticalViolations: string[] = [];
  const warnings: string[] = [];
  if (
    !blueprint ||
    typeof blueprint !== "object" ||
    typeof blueprint.schemaVersion !== "string" ||
    !Array.isArray(blueprint.projects) ||
    blueprint.projects.length > 1000
  ) {
    return {
      rating: "REJECTED",
      score: 0,
      publishable: false,
      criticalViolations: ["Malformed or oversized blueprint structure"],
      warnings,
    };
  }
  if (blueprint.schemaVersion !== "2.0")
    criticalViolations.push("Unsupported blueprint schema");
  let scannedChars = 0;
  for (const project of blueprint.projects ?? []) {
    if (
      !project ||
      typeof project !== "object" ||
      typeof project.name !== "string" ||
      project.name.length > 256 ||
      typeof project.systemPrompt !== "string" ||
      !Array.isArray(project.starterFiles) ||
      project.starterFiles.length > 1000 ||
      (project.roles !== undefined &&
        (!Array.isArray(project.roles) ||
          project.roles.length > 1000 ||
          !project.roles.every(
            (role) => typeof role === "string" && role.length <= 256
          ))) ||
      (project.capabilities !== undefined &&
        (!Array.isArray(project.capabilities) ||
          project.capabilities.length > 1000 ||
          !project.capabilities.every(
            (capability) =>
              typeof capability === "string" && capability.length <= 256
          ))) ||
      (project.executionTier !== undefined &&
        !Number.isFinite(project.executionTier)) ||
      !project.starterFiles.every(
        (file) => file && typeof file.content === "string"
      )
    ) {
      criticalViolations.push("Malformed project or starter-file structure");
      continue;
    }
    scannedChars +=
      project.systemPrompt.length +
      project.starterFiles.reduce(
        (total, file) => total + file.content.length,
        0
      );
    if (scannedChars > 1_000_000) {
      criticalViolations.push(
        "Blueprint content exceeds the security scan limit"
      );
      break;
    }
    const restricted = (project.roles ?? []).some((role) =>
      /^(CUSTOMER_SUPPORT|GROWTH_OPERATOR)$/i.test(role)
    );
    const dangerous =
      (project.executionTier ?? 0) >= 5 ||
      (project.capabilities ?? []).some((capability) =>
        DESTRUCTIVE.test(capability)
      );
    if (restricted && dangerous)
      criticalViolations.push(
        `${project.name}: restricted role has Tier 5/6 or destructive capability`
      );
    const texts = [
      project.systemPrompt,
      ...project.starterFiles.map((file) => file.content),
    ];
    if (texts.some((text) => INJECTION.test(text)))
      criticalViolations.push(
        `${project.name}: prompt injection or credential exfiltration payload`
      );
    if (texts.some((text) => SCRIPT.test(text)))
      criticalViolations.push(
        `${project.name}: unescaped script injection tag`
      );
    if (texts.some((text) => text.includes("\0")))
      criticalViolations.push(`${project.name}: seed file contains null bytes`);
    for (const file of project.starterFiles) {
      const candidate = file as { content: string; path?: string };
      if (candidate.path?.endsWith(".json")) {
        try {
          JSON.parse(candidate.content);
        } catch {
          criticalViolations.push(
            `${project.name}: malformed JSON seed file ${candidate.path}`
          );
        }
      }
    }
    if (!project.systemPrompt.trim())
      warnings.push(`${project.name}: empty system prompt`);
  }
  let score = 100 - criticalViolations.length * 30 - warnings.length * 5;
  score = Math.max(0, score);
  const rating: BlueprintRating =
    criticalViolations.length > 0 || score < 80
      ? "REJECTED"
      : score === 100
        ? "A+"
        : score >= 90
          ? "A"
          : "B";
  return {
    rating,
    score,
    publishable: rating !== "REJECTED",
    criticalViolations,
    warnings,
  };
}
