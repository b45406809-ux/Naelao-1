const allowedDraftValues = new Set(["", "low stock"]);
const allowedVoices = new Set(["neutral", "warm"]);
const allowedHours = new Set([
  "Weekdays 09:00-17:00",
  "Daily 09:00-17:00",
]);

export function isAllowedAgentAction(step) {
  if (
    step?.component !== "input" ||
    step?.action !== "setValue" ||
    !Array.isArray(step?.args) ||
    step.args.length !== 1 ||
    typeof step.args[0] !== "string"
  ) return false;

  const [value] = step.args;
  if (step.label === "Draft inventory filter") return allowedDraftValues.has(value);
  if (step.label === "Voice profile") return allowedVoices.has(value);
  if (step.label === "Business hours") return allowedHours.has(value);
  if (step.label === "Greeting") {
    return value.length > 0 && value.length <= 120 && !/[\u0000-\u001f\u007f<>]/u.test(value);
  }
  return false;
}

export function validateSetupDraft(draft) {
  if (!draft || typeof draft !== "object") return false;
  return (
    allowedVoices.has(draft.voice) &&
    allowedHours.has(draft.hours) &&
    typeof draft.greeting === "string" &&
    draft.greeting.length > 0 &&
    draft.greeting.length <= 120 &&
    !/[\u0000-\u001f\u007f<>]/u.test(draft.greeting)
  );
}
