import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedAgentAction, validateSetupDraft } from "./agent-policy.mjs";

const allowedFilter = {
  component: "input",
  label: "Draft inventory filter",
  action: "setValue",
  args: ["low stock"],
};

test("limits the inventory filter to its named control and sample values", () => {
  assert.equal(isAllowedAgentAction(allowedFilter), true);
  assert.equal(isAllowedAgentAction({ ...allowedFilter, args: [""] }), true);
  assert.equal(isAllowedAgentAction({ ...allowedFilter, args: ["all"] }), false);
  assert.equal(isAllowedAgentAction({ ...allowedFilter, args: ["low stock", "extra"] }), false);
});

test("limits voice setup actions to the three bounded draft fields", () => {
  assert.equal(isAllowedAgentAction({ component: "input", label: "Voice profile", action: "setValue", args: ["warm"] }), true);
  assert.equal(isAllowedAgentAction({ component: "input", label: "Business hours", action: "setValue", args: ["Daily 09:00-17:00"] }), true);
  assert.equal(isAllowedAgentAction({ component: "input", label: "Greeting", action: "setValue", args: ["Hello from the demo store."] }), true);
  assert.equal(isAllowedAgentAction({ component: "input", label: "Voice profile", action: "setValue", args: ["unlisted-voice"] }), false);
  assert.equal(isAllowedAgentAction({ component: "input", label: "Business hours", action: "setValue", args: ["Always open"] }), false);
  assert.equal(isAllowedAgentAction({ component: "input", label: "Greeting", action: "setValue", args: ["<img src=x>"] }), false);
  assert.equal(isAllowedAgentAction({ component: "input", label: "Greeting", action: "setValue", args: ["x".repeat(121)] }), false);
});

test("validates the complete setup draft before owner approval", () => {
  const valid = { voice: "warm", hours: "Weekdays 09:00-17:00", greeting: "Hello, thanks for calling the demo store." };
  assert.equal(validateSetupDraft(valid), true);
  assert.equal(validateSetupDraft({ ...valid, voice: "unlisted-voice" }), false);
  assert.equal(validateSetupDraft({ ...valid, hours: "" }), false);
  assert.equal(validateSetupDraft({ ...valid, greeting: "" }), false);
  assert.equal(validateSetupDraft(null), false);
});

test("refuses actions outside the declared synthetic controls", () => {
  assert.equal(isAllowedAgentAction({ ...allowedFilter, label: "Other field" }), false);
  assert.equal(isAllowedAgentAction({ ...allowedFilter, component: "button" }), false);
  assert.equal(isAllowedAgentAction({ ...allowedFilter, action: "clear" }), false);
  assert.equal(isAllowedAgentAction(null), false);
});
