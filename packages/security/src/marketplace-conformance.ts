/** Deterministic, bounded conformance checks for declarative blueprint lint rules. */
export const CONFORMANCE_RUNNER_VERSION = "naelao-conformance-v1";
export const MIN_MARKETPLACE_FIXTURES = 50;

export interface ConformanceRule {
  id: string;
  match: string;
  flags?: "i";
}
export interface ConformanceFixture { id: string; text: string; expected: "compliant" | "violation" }
export interface ConformanceSuite { rules: ConformanceRule[]; fixtures: ConformanceFixture[] }
export interface ConformanceReport {
  runner: string;
  passed: number;
  total: number;
  diagnostics: Array<{ fixtureId: string; expected: string; actual: string }>;
}
export interface ConformanceCertificate {
  runner: string;
  artifactSha256: string;
  suiteSha256: string;
  passed: number;
  total: number;
  issuedAt: string;
  signature: string;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TEXT = 16_384;

export function validateConformanceSuite(value: unknown): value is ConformanceSuite {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const suite = value as Record<string, unknown>;
  if (!Array.isArray(suite.rules) || suite.rules.length < 1 || suite.rules.length > 64 ||
      !Array.isArray(suite.fixtures) || suite.fixtures.length < MIN_MARKETPLACE_FIXTURES || suite.fixtures.length > 500) return false;
  const rules = new Set<string>();
  for (const raw of suite.rules) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const rule = raw as Record<string, unknown>;
    if (typeof rule.id !== "string" || !ID.test(rule.id) || rules.has(rule.id) ||
        typeof rule.match !== "string" || rule.match.length < 1 || rule.match.length > 256 ||
        (rule.flags !== undefined && rule.flags !== "i")) return false;
    rules.add(rule.id);
  }
  const fixtures = new Set<string>();
  let compliant = 0;
  let violations = 0;
  for (const raw of suite.fixtures) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const fixture = raw as Record<string, unknown>;
    if (typeof fixture.id !== "string" || !ID.test(fixture.id) || fixtures.has(fixture.id) ||
        typeof fixture.text !== "string" || fixture.text.length > MAX_TEXT ||
        (fixture.expected !== "compliant" && fixture.expected !== "violation")) return false;
    fixtures.add(fixture.id);
    if (fixture.expected === "compliant") compliant++;
    else violations++;
  }
  return compliant > 0 && violations > 0;
}

/** All rules declared for a finding must match; no code execution or model judgment is involved. */
export function runConformanceSuite(suite: ConformanceSuite): ConformanceReport {
  if (!validateConformanceSuite(suite)) throw new Error("invalid_conformance_suite");
  const diagnostics: ConformanceReport["diagnostics"] = [];
  for (const fixture of suite.fixtures) {
    const text = fixture.text.normalize("NFKC");
    const matches = suite.rules.filter((rule) => (rule.flags === "i" ? text.toLocaleLowerCase("en-US") : text)
      .includes((rule.flags === "i" ? rule.match.normalize("NFKC").toLocaleLowerCase("en-US") : rule.match.normalize("NFKC"))));
    const actual = matches.length ? "violation" : "compliant";
    if (actual !== fixture.expected) diagnostics.push({ fixtureId: fixture.id, expected: fixture.expected, actual });
  }
  return { runner: CONFORMANCE_RUNNER_VERSION, passed: suite.fixtures.length - diagnostics.length, total: suite.fixtures.length, diagnostics };
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function payload(cert: Omit<ConformanceCertificate, "signature">): string { return stable(cert); }

export async function certifyArtifact(artifact: unknown, suite: ConformanceSuite, secret: string, issuedAt = new Date().toISOString()): Promise<{ report: ConformanceReport; certificate?: ConformanceCertificate }> {
  const report = runConformanceSuite(suite);
  if (!secret || report.passed !== report.total) return { report };
  const unsigned = {
    runner: CONFORMANCE_RUNNER_VERSION,
    artifactSha256: await sha256(stable(artifact)),
    suiteSha256: await sha256(stable(suite)),
    passed: report.passed,
    total: report.total,
    issuedAt,
  };
  return { report, certificate: { ...unsigned, signature: await hmac(secret, payload(unsigned)) } };
}

export async function verifyArtifactCertificate(artifact: unknown, certificate: ConformanceCertificate | undefined, secret: string): Promise<boolean> {
  if (!certificate || !secret || certificate.runner !== CONFORMANCE_RUNNER_VERSION || certificate.passed !== certificate.total || certificate.total < MIN_MARKETPLACE_FIXTURES) return false;
  const { signature, ...unsigned } = certificate;
  return certificate.artifactSha256 === await sha256(stable(artifact)) &&
    signature === await hmac(secret, payload(unsigned));
}
