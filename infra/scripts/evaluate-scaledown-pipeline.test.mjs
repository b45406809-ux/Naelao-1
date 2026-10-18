import test from "node:test";
import assert from "node:assert/strict";
import { scoreExtraction, scoreSummary } from "./evaluate-scaledown-pipeline.mjs";

test("summary score catches omitted contractual details and forbidden claims", () => {
  const complete = "Northstar Analytics Ltd., effective 2025-04-01, pays USD 1,250.00 within 30 days. Migration is excluded and needs separate written approval. Either party may terminate on 45 days written notice. Renewal rises no more than 4.5%.";
  assert.equal(scoreSummary(complete).passed, true);
  assert.equal(scoreSummary(complete.replace("within 30 days", "within 15 days")).passed, false);
  assert.deepEqual(scoreSummary(`${complete} Migration is included.`).forbiddenClaims, ["migration is included"]);
});

test("extraction metrics distinguish exact field coverage from extra or incorrect fields", () => {
  const fields = [
    { type: "Customer", text: "Northstar Analytics Ltd." }, { type: "EffectiveDate", text: "2025-04-01" },
    { type: "MonthlyFee", text: "USD 1,250.00" }, { type: "PaymentTerm", text: "within 30 days" },
    { type: "Exclusion", text: "optional data migration is excluded" }, { type: "TerminationNotice", text: "45 days" },
    { type: "RenewalCap", text: "4.5%" },
  ];
  assert.equal(scoreExtraction(fields).passed, true);
  assert.equal(scoreExtraction(fields.slice(1)).recall, 6 / 7);
  assert.equal(scoreExtraction([...fields, { type: "GoverningLaw", text: "California" }]).precision, 7 / 8);
});

test("summary scoring checks Unicode, corrections, negation and quoted injection claims", () => {
  const facts = ["QX-17", "2025-06-14", "20 business days", "Québec", "français", "2025-07-15", "supersedes the earlier 2025-07-01"];
  const forbidden = ["10 calendar days remains", "effective date is 2025-07-01"];
  const faithful = "Référence QX-17, version dated 2025-06-14. Notice is 20 business days; Québec entities may use français. Correction sets 2025-07-15 and supersedes the earlier 2025-07-01 date.";
  assert.equal(scoreSummary(faithful, facts, forbidden).passed, true);
  assert.equal(scoreSummary(`${faithful} The effective date is 2025-07-01.`, facts, forbidden).passed, false);
});
