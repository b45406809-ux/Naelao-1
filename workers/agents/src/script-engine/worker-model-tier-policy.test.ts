import { describe, expect, it } from "vitest";
import { ALLOWED_MODELS, costRankForModel, DEFAULT_WORKING_MODEL } from "@naelao/billing-core";
import { applyWorkerModelTierPolicy, workerModelTier, WORKER_MODEL_TIER_COST, type WorkerModelPolicy } from "./worker-model-tier-policy.js";

const platform = (tier: string) => ALLOWED_MODELS.filter(m => !m.startsWith("openrouter/") && !m.includes("/gemini") && !m.startsWith("google-ai-studio/") && workerModelTier(m) === tier);
const premium = platform("premium")[0]!, economy = platform("economy")[0]!, standard = platform("standard")[0];
const policy = (p: Partial<WorkerModelPolicy>): WorkerModelPolicy => ({ allowedModelTiers: [], preferredModelTier: null, fallbackTiers: [], preferredSource: "none", ...p });
const run = (model: string, p: WorkerModelPolicy, effort: "low" | "ultra" = "ultra") =>
  applyWorkerModelTierPolicy({ resolution: { model, downgraded: false }, policy: p, plannerModel: premium, effort, privateRoute: false });

describe("worker model tier policy (MS-25)", () => {
  it("maps tiers through billing-core cost ranks", () => {
    expect(workerModelTier(DEFAULT_WORKING_MODEL)).toBe(["economy", "standard", "premium"][costRankForModel(DEFAULT_WORKING_MODEL) - 1]);
    expect(workerModelTier("unknown/model")).toBe("standard");
    expect(WORKER_MODEL_TIER_COST).toEqual({ economy: 1, standard: 2, premium: 3 });
  });
  it("no user pick: host routing is kept when its tier is allowed or the set is empty", () => {
    expect(run(premium, policy({})).model).toBe(premium);
    expect(run(premium, policy({ allowedModelTiers: ["economy", "premium"], preferredModelTier: "economy", preferredSource: "cheapest-allowed" })).model).toBe(premium);
  });
  it("no user pick: a disallowed host tier is restricted to allowed tiers, not forced to the cheapest", () => {
    const allowedStandardOrEconomy = policy({ allowedModelTiers: ["economy", "standard"], preferredModelTier: "economy", preferredSource: "cheapest-allowed", fallbackTiers: [] });
    const out = run(premium, allowedStandardOrEconomy);
    expect(["economy", "standard"]).toContain(workerModelTier(out.model));
    if (standard) expect(workerModelTier(out.model)).toBe("standard"); // most expensive allowed not above the host's
    expect(out.downgraded).toBe(true);
    // host already economy and allowed -> untouched
    expect(run(economy, allowedStandardOrEconomy).model).toBe(economy);
  });
  it("user picked an allowed tier: uses it within the effort ceiling; never more expensive than the pick", () => {
    const pick = policy({ allowedModelTiers: ["economy", "premium"], preferredModelTier: "premium", fallbackTiers: ["economy"], preferredSource: "user" });
    expect(workerModelTier(run(economy, pick, "ultra").model)).toBe("premium");
    // low effort caps the ceiling at rank 1: premium is unreachable, fallback tier (cheaper) is used
    expect(workerModelTier(run(economy, pick, "low").model)).toBe("economy");
    const cheapPick = policy({ allowedModelTiers: ["economy", "premium"], preferredModelTier: "economy", fallbackTiers: [], preferredSource: "user" });
    expect(workerModelTier(run(premium, cheapPick).model)).toBe("economy");
  });
  it("fails closed instead of exceeding the user's pick when nothing fits", () => {
    const pick = policy({ allowedModelTiers: ["economy"], preferredModelTier: "economy", preferredSource: "user" });
    expect(() => applyWorkerModelTierPolicy({ resolution: { model: "openrouter/x/none", downgraded: false }, policy: { ...pick, allowedModelTiers: ["premium"], preferredModelTier: "premium", preferredSource: "user" }, plannerModel: premium, effort: "low", privateRoute: false })).toThrow("worker_model_tier_unavailable");
  });
  it("never re-targets private, local or custom routes, or another provider family", () => {
    const strict = policy({ allowedModelTiers: ["economy"], preferredModelTier: "economy", preferredSource: "user" });
    for (const model of ["local/m", "custom/m"]) expect(run(model, strict).model).toBe(model);
    expect(applyWorkerModelTierPolicy({ resolution: { model: premium, downgraded: false }, policy: strict, plannerModel: premium, effort: "ultra", privateRoute: true }).model).toBe(premium);
    const out = run("openrouter/deepseek/deepseek-v4.1-flash-1017", policy({ allowedModelTiers: ["economy", "standard", "premium"] }));
    expect(out.model.startsWith("openrouter/")).toBe(true);
  });
});
