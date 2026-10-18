import type { ZodType } from "zod";

interface AiBinding {
  run(
    model: string,
    input: {
      messages: Array<{ role: "system" | "user"; content: string }>;
      response_format?: { type: "json_object" };
    }
  ): Promise<unknown>;
}
export interface SchemaRepairEnv {
  AI: AiBinding;
}
const MAX_REPAIR_JSON_BYTES = 65_536;

function extractResponse(result: unknown): unknown {
  if (typeof result === "string") {
    if (new TextEncoder().encode(result).byteLength > MAX_REPAIR_JSON_BYTES)
      throw new Error("schema_repair_output_too_large");
    return JSON.parse(result);
  }
  if (!result || typeof result !== "object") return result;
  const response = (result as { response?: unknown }).response;
  if (typeof response !== "string") return response ?? result;
  if (new TextEncoder().encode(response).byteLength > MAX_REPAIR_JSON_BYTES)
    throw new Error("schema_repair_output_too_large");
  return JSON.parse(response);
}

/** Validate first; only malformed provider data incurs an AI inference. AI output is never trusted. */
export async function repairPayloadSchema<T>(
  malformedJson: unknown,
  targetZodSchema: ZodType<T>,
  env: SchemaRepairEnv
): Promise<T> {
  const decoded =
    typeof malformedJson === "string"
      ? (JSON.parse(malformedJson) as unknown)
      : malformedJson;
  const initial = targetZodSchema.safeParse(decoded);
  if (initial.success) return initial.data;
  const repairInput = JSON.stringify({
    input: decoded,
    validationIssues: initial.error.issues.map((issue) => ({
      path: issue.path,
      expected: issue.code,
      message: issue.message,
    })),
  });
  if (
    new TextEncoder().encode(repairInput).byteLength > MAX_REPAIR_JSON_BYTES
  ) {
    throw new Error("schema_repair_input_too_large");
  }
  const result = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
    messages: [
      {
        role: "system",
        content:
          "Map the input JSON onto the requested target. Return only one JSON object. Never invent values; omit fields that cannot be mapped.",
      },
      { role: "user", content: repairInput },
    ],
    response_format: { type: "json_object" },
  });
  return targetZodSchema.parse(extractResponse(result));
}
