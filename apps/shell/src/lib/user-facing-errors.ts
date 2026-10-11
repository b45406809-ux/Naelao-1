/** Convert transport/provider failures into messages a person can act on. */
export function userFacingErrorMessage(raw: unknown, errorCode?: string, fallback = "The assistant couldn't complete that request. Please try again."): string {
  const message = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  const value = `${errorCode ?? ""} ${message}`.toLowerCase();

  if (value.includes("destructive_mutation_denied") || value.includes("egress_dlp_blocked")) return message;
  if (value.includes("no active key") || value.includes("missing or invalid authorization") || value.includes("no credentials configured") || value.includes("unauthorized") || value.includes("401")) {
    return "This model connection is not authorized. Add or select the provider key in Space settings, and check the Cloudflare Gateway token if your space uses one.";
  }
  if (value.includes("agent_not_provisioned") || value.includes("not provisioned")) {
    return "This agent is still being set up in the space. Try again after provisioning finishes.";
  }
  if (value.includes("space_provisioning") || value.includes("space is provisioning") || value.includes("provisioning")) {
    return "This space is still being set up. Try again when provisioning finishes.";
  }
  if (value.includes("invalid_argument") || value.includes("request contains an invalid argument") || value.includes("reasoner gateway error 400") || value.includes("bad request")) {
    return "The selected model rejected this request. Try again, or choose another model from the model menu.";
  }
  if (value.includes("rate limit") || value.includes("rate_limit") || value.includes("429")) {
    return "The model is busy right now. Please try again in a moment.";
  }
  if (value.includes("gateway network error") || value.includes("network error") || value.includes("timed out") || value.includes("503") || value.includes("502") || value.includes("500")) {
    return "The model service is temporarily unavailable. Please try again in a moment.";
  }
  if (value.includes("run not found") || value.includes("run_not_found")) {
    return "That run is no longer available. Please send the request again.";
  }
  if (value.includes("context") && (value.includes("overflow") || value.includes("too large") || value.includes("token"))) {
    return "This conversation is too large for the selected model. Start a new thread or ask a shorter question.";
  }
  if (value.includes("step_exhaustion") || value.includes("ran out of steps")) {
    return "The assistant ran out of steps before finishing. Try breaking the request into smaller parts.";
  }
  if (value.includes("no llm credentials") || value.includes("credential vault not bound")) {
    return "No model connection is configured for this space. Add a provider key in Space settings or configure the space's Gateway credentials.";
  }

  // Keep already useful application messages, but never surface a structured provider payload.
  if (message && !/[{\[]\s*["']?(?:error|success|code|message)["']?\s*:/.test(message)) return message;
  return fallback;
}
