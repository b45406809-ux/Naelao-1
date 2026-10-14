import type { PrebuiltOpContext, PrebuiltScript } from "./index.js";

async function inventory(ctx: PrebuiltOpContext) {
  if (!ctx.env.containerRuntimeInventory) throw new Error("runtime_inventory_unavailable");
  return ctx.env.containerRuntimeInventory();
}

export const runtimeDiscovery: PrebuiltScript = {
  name: "runtime-discovery", domain: "orchestration", requires_tier: 1,
  description: "Discover installed specialized runtimes and deployed marketplace candidates. Discovery never installs, allocates compute, widens workspace scope, or authorizes native execution.",
  paramHints: {
    "runtime.list": "No arguments. List active actor-scoped installations and deployment-approved runtime candidates.",
    "runtime.find": "binary (required). Find installed exported binaries, or prepare a deployment-approved candidate for explicit human installation. Missing matches do not trigger automatic installation.",
  },
  operations: {
    "runtime.list": async (_a, c) => inventory(c),
    "runtime.find": async (a, c) => {
      const binary = String(a.binary ?? "");
      if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(binary)) throw new Error("runtime_binary_invalid");
      const found = await inventory(c);
      const installed = found.installed.filter(item => item.contract.exportedBinaries.includes(binary));
      if (installed.length) return { status: "installed", binary, candidates: installed.map(item => ({ installation_id: item.installationId,
        command: `${item.extensionId}/${item.contract.id}/${binary}`, image: item.contract.image })), requires_qualification: installed.length > 1 };
      const candidates = found.catalogue.filter(item => item.available && item.exported_binaries?.includes(binary));
      let recommended = candidates.length === 1 ? candidates[0]?.id : undefined;
      if (candidates.length > 1 && c.env.fastDecision) {
        try {
          const decision = await c.env.fastDecision.choice({ state: { binary }, instructions: "Recommend an available runtime for this binary. This is metadata-only; it does not grant installation or execution.",
            criteria: Object.fromEntries(candidates.map(item => [item.id, item.description])), policyCode: "runtime_candidate_v1" });
          if (decision.confidence !== undefined && decision.confidence >= 0.75 && candidates.some(item => item.id === decision.value)) recommended = decision.value;
        } catch { /* A missing sentry cannot authorize an install or create a runtime. */ }
      }
      return { status: candidates.length ? "installation_required" : "runtime_not_found", binary, candidates, recommended,
        requires_human_approval: true,
        ...(c.env.projectId ? { project_id: c.env.projectId, scope: "PROJECT_SHARED" } : { scope: "SPACE_SHARED", workspace: "dedicated_space_extension" }),
        next_action: candidates.length
          ? "Ask a Space owner to open Foundry → Specialized runtimes, review the permissions and limits, install the selected runtime, then retry this command."
          : "Ask an FDE/operator to prepare a trusted digest-pinned runtime and deploy its approved binding, or choose an already authorized local-machine alternative. No image is provisioned from model text." };
    },
  },
};
