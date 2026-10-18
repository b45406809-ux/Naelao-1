import assert from "node:assert/strict";
import test from "node:test";
import {
  comparePipelineCosts,
  scoreAnswer,
  scoreCitations,
  scoreExtraction,
  scoreSummary,
  scoreWorkerTrajectory,
} from "./evaluate-scaledown-pipeline.mjs";

test("summary score catches omitted contractual details and forbidden claims", () => {
  const complete =
    "Northstar Analytics Ltd., effective 2025-04-01, pays USD 1,250.00 within 30 days. Migration is excluded and needs separate written approval. Either party may terminate on 45 days written notice. Renewal rises no more than 4.5%.";
  assert.equal(scoreSummary(complete).passed, true);
  assert.equal(
    scoreSummary(complete.replace("within 30 days", "within 15 days")).passed,
    false
  );
  assert.deepEqual(
    scoreSummary(`${complete} Migration is included.`).forbiddenClaims,
    ["migration is included"]
  );
});

test("extraction metrics distinguish exact field coverage from extra or incorrect fields", () => {
  const fields = [
    { type: "Customer", text: "Northstar Analytics Ltd." },
    { type: "EffectiveDate", text: "2025-04-01" },
    { type: "MonthlyFee", text: "USD 1,250.00" },
    { type: "PaymentTerm", text: "within 30 days" },
    { type: "Exclusion", text: "optional data migration is excluded" },
    { type: "TerminationNotice", text: "45 days" },
    { type: "RenewalCap", text: "4.5%" },
  ];
  assert.equal(scoreExtraction(fields).passed, true);
  assert.equal(scoreExtraction(fields.slice(1)).recall, 6 / 7);
  assert.equal(
    scoreExtraction([...fields, { type: "GoverningLaw", text: "California" }])
      .precision,
    7 / 8
  );
});

test("summary scoring checks Unicode, corrections, negation and quoted injection claims", () => {
  const facts = [
    "QX-17",
    "2025-06-14",
    "20 business days",
    "Québec",
    "français",
    "2025-07-15",
    "supersedes the earlier 2025-07-01",
  ];
  const forbidden = [
    "10 calendar days remains",
    "effective date is 2025-07-01",
  ];
  const faithful =
    "Référence QX-17, version dated 2025-06-14. Notice is 20 business days; Québec entities may use français. Correction sets 2025-07-15 and supersedes the earlier 2025-07-01 date.";
  assert.equal(scoreSummary(faithful, facts, forbidden).passed, true);
  assert.equal(
    scoreSummary(
      `${faithful} The effective date is 2025-07-01.`,
      facts,
      forbidden
    ).passed,
    false
  );
});

test("downstream answers are scored for correctness and exact source citations", () => {
  const source =
    "The renewal fee is USD 40. The written notice period is 20 business days.";
  const answer = scoreAnswer("Fee USD 40; notice is 20 business days.", [
    "USD 40",
    "20 business days",
  ]);
  assert.equal(answer.passed, true);
  assert.deepEqual(
    scoreCitations(
      [
        {
          quote: "The renewal fee is USD 40.",
          start: 0,
          end: "The renewal fee is USD 40.".length,
        },
        { quote: "The notice is 90 days." },
      ],
      source
    ),
    {
      citationCount: 2,
      supportedCount: 1,
      supportPrecision: 0.5,
      unsupportedQuotes: 1,
      passed: false,
    }
  );
  assert.deepEqual(comparePipelineCosts(0.02, 0.01), {
    baselineCostUsd: 0.02,
    processedCostUsd: 0.01,
    savingsUsd: 0.01,
    savingsRate: 0.5,
    source: "measured-or-rate-estimated",
  });
  assert.equal(comparePipelineCosts(0.02, null).savingsUsd, null);
});

test("worker trajectory checks required tools, malformed calls and final answer quality", () => {
  const calls = [
    { function: { name: "lookup_invoice" } },
    { function: { name: "lookup_contract" } },
  ];
  const result = scoreWorkerTrajectory(
    calls,
    ["lookup_invoice", "lookup_contract"],
    scoreAnswer("USD 1,250.00", ["USD 1,250.00"])
  );
  assert.equal(result.passed, true);
  assert.deepEqual(result.missingTools, []);
  assert.equal(
    scoreWorkerTrajectory(
      calls.slice(0, 1),
      ["lookup_invoice", "lookup_contract"],
      scoreAnswer("wrong", ["right"])
    ).passed,
    false
  );
});
