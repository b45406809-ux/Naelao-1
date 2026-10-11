import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const REQUIRED_NUMERIC_FIELDS = [
  "periodDays",
  "sampleCount",
  "tierOneTwoShare",
  "tierSixShare",
  "tierOneTwoP95DurationMs",
];

function assertRuntimeEconomicsMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime economics endpoint returned a non-object payload");
  }
  const metrics = value;
  for (const field of REQUIRED_NUMERIC_FIELDS) {
    if (typeof metrics[field] !== "number" || !Number.isFinite(metrics[field])) {
      throw new Error(`Runtime economics payload is missing numeric field: ${field}`);
    }
  }
  if (!Number.isInteger(metrics.periodDays) || metrics.periodDays <= 0) {
    throw new Error("Runtime economics payload has an invalid periodDays value");
  }
  if (!Number.isInteger(metrics.sampleCount) || metrics.sampleCount < 0) {
    throw new Error("Runtime economics payload has an invalid sampleCount value");
  }
  return metrics;
}

export async function fetchRuntimeEconomics({ endpoint, token, period = 30, fetchImpl = fetch }) {
  if (!endpoint) throw new Error("NAELAO_RUNTIME_ECONOMICS_URL is required");
  if (!token) throw new Error("NAELAO_OWNER_JWT is required");
  if (![7, 30, 90].includes(Number(period))) throw new Error("period must be 7, 30, or 90");

  const url = new URL(endpoint);
  url.searchParams.set("period", String(period));
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.message ?? body?.error ?? `Runtime economics request failed (${response.status})`;
    throw new Error(message);
  }
  return assertRuntimeEconomicsMetrics(body);
}

function parseArgs(argv) {
  const args = { out: null, period: process.env.NAELAO_ECONOMICS_PERIOD ?? "30" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--period") args.period = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const metrics = await fetchRuntimeEconomics({
    endpoint: process.env.NAELAO_RUNTIME_ECONOMICS_URL,
    token: process.env.NAELAO_OWNER_JWT,
    period: args.period,
  });
  const output = `${JSON.stringify(metrics, null, 2)}\n`;
  if (args.out) await writeFile(args.out, output, "utf8");
  else process.stdout.write(output);
}
