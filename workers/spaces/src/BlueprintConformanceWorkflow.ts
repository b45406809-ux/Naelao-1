import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { type SpaceBlueprint, instantiateBlueprint } from "@naelao/agent-sdk";
import { mintInternalToken } from "@naelao/http";
import {
  type StateDeltaConformanceReport,
  certifyStateDeltaArtifact,
} from "@naelao/security";
import type { Env } from "./index.js";
import type { StateDeltaSuite } from "./state-delta-conformance.js";
import { certifiedBlueprintKey } from "./certified-blueprint.js";

export interface BlueprintConformanceParams {
  tenantId: string;
  jobId: string;
  key: string;
  digest: string;
}
export async function conformanceDigest(text: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export class BlueprintConformanceWorkflow extends WorkflowEntrypoint<
  Env,
  BlueprintConformanceParams
> {
  async run(
    event: WorkflowEvent<BlueprintConformanceParams>,
    step: WorkflowStep
  ) {
    const params = event.payload;
    const object = await this.env.SCRIPTS_R2?.get(params.key);
    if (!object || object.size > 5 * 1024 * 1024)
      throw new Error("conformance_artifact_missing");
    const raw = await object.text();
    if ((await conformanceDigest(raw)) !== params.digest)
      throw new Error("conformance_artifact_changed");
    const { blueprint, suite, security } = JSON.parse(raw) as {
      blueprint: SpaceBlueprint;
      suite: StateDeltaSuite;
      security: { rating: string };
    };
    await step.do("blueprint-compile-check", async () => {
      // Validate and normalize using the same SDK compiler as SpaceDO, without writing projects,
      // tasks, agent definitions or starter files into the production SpaceDO namespace.
      const compiled = instantiateBlueprint(
        blueprint,
        `conformance-${params.jobId}`
      );
      return {
        projects: compiled.projects.length,
        requiredExtensions: compiled.requiredExtensions.length,
      };
    });
    const report: StateDeltaConformanceReport = {
      runner: "naelao-state-delta-v1",
      passed: 0,
      total: suite.fixtures.length,
      securityViolations: 0,
      tokensUsed: 0,
      maximumCostUpperBoundUsd: 0.025,
      diagnostics: [],
    };
    for (const fixture of suite.fixtures) {
      const result = await step.do(
        `fixture-${fixture.id}`,
        {
          retries: { limit: 0, delay: "2 seconds", backoff: "exponential" },
          timeout: "15 seconds",
        },
        async () => {
          if (!this.env.CONFORMANCE_EXECUTOR)
            throw new Error("conformance_executor_unavailable");
          const response = await this.env.CONFORMANCE_EXECUTOR.fetch(
            new Request("http://spaces/internal/conformance/fixture", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-naelao-tenant-id": params.tenantId,
                "x-naelao-internal-token": await mintInternalToken(
                  this.env.PLATFORM_SECRET,
                  params.tenantId
                ),
              },
              body: JSON.stringify({ blueprint, fixture }),
            })
          );
          if (!response.ok)
            throw new Error(`conformance_executor_http_${response.status}`);
          return response.json<{ passed: boolean; error?: string }>();
        }
      );
      if (result.passed) report.passed++;
      else
        report.diagnostics.push({
          fixtureId: fixture.id,
          error: result.error ?? "fixture_failed",
        });
    }
    return step.do("certify-and-store", async () => {
      const certificate = await certifyStateDeltaArtifact(
        blueprint,
        suite,
        report,
        this.env.PLATFORM_SECRET,
        params.tenantId
      );
      if (!certificate) return { status: "rejected", report };
      if (!this.env.SCRIPTS_R2)
        throw new Error("conformance_artifact_storage_unavailable");
      const key = certifiedBlueprintKey(params.tenantId, blueprint.id);
      await this.env.SCRIPTS_R2.put(
        key,
        JSON.stringify({
          blueprint: { ...blueprint, securityRating: security.rating },
          conformanceCertificate: certificate,
        }),
        {
          httpMetadata: { contentType: "application/json" },
          customMetadata: {
            safetyRating: security.rating,
            schemaVersion: "2.0",
          },
        }
      );
      return {
        status: "certified",
        blueprintId: blueprint.id,
        key,
        report,
        certificate,
      };
    });
  }
}
