import "@ui-sdk/web/field";
import "@ui-sdk/web/input";
import { createAgent } from "@ui-sdk/web/agent";
import { isAllowedAgentAction, validateSetupDraft } from "./agent-policy.mjs";
import "./style.css";

const products = [
  { name: "Paper clips", onHand: 18, reorderPoint: 20 },
  { name: "Blue notebooks", onHand: 42, reorderPoint: 15 },
  { name: "Desk lamps", onHand: 6, reorderPoint: 8 },
  { name: "Shipping labels", onHand: 120, reorderPoint: 40 },
];

const filter = document.querySelector("ui-input");
const nativeInput = document.querySelector("#draft-filter");
const rows = document.querySelector("#inventory-rows");
const count = document.querySelector("#result-count");
const status = document.querySelector("#change-status");
const approval = document.querySelector("#agent-approval");
const approvalMessage = document.querySelector("#approval-message");
const setupApproval = document.querySelector("#setup-approval");
const setupApprovalMessage = document.querySelector("#setup-approval-message");
const setupStatus = document.querySelector("#setup-status");
const setupPreview = document.querySelector("#setup-preview");
let filterValue = nativeInput.value;
const setupFields = {
  voice: document.querySelector("#voice-profile"),
  greeting: document.querySelector("#greeting"),
  hours: document.querySelector("#business-hours"),
};
const setupDefaults = Object.fromEntries(Object.entries(setupFields).map(([key, input]) => [key, input.value]));

function renderRows() {
  const lowStockOnly = filterValue.trim().toLowerCase() === "low stock";
  const visibleProducts = products.filter(
    (product) => !lowStockOnly || product.onHand <= product.reorderPoint,
  );

  rows.replaceChildren(
    ...visibleProducts.map((product) => {
      const row = document.createElement("tr");
      for (const value of [
        product.name,
        String(product.onHand),
        String(product.reorderPoint),
        product.onHand <= product.reorderPoint ? "Reorder" : "In range",
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    }),
  );
  count.textContent = `${visibleProducts.length} sample ${visibleProducts.length === 1 ? "item" : "items"}`;
}

function requestOwnerConfirmation(step, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (approved) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(approved);
    };
    const onAbort = () => {
      if (approval.open) approval.close("deny");
      finish(false);
    };

    const currentValue = step.label === "Draft inventory filter"
      ? nativeInput.value
      : Object.values(setupFields).find((input) => input.closest("ui-field")?.querySelector("ui-field-label")?.textContent === step.label)?.value ?? "";
    approvalMessage.textContent = `Allow the assistant to change ${step.label} from “${currentValue}” to “${step.args[0]}”? This only changes a local synthetic draft.`;
    approval.returnValue = "deny";
    approval.addEventListener("close", () => finish(approval.returnValue === "allow"), { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    approval.showModal();
  });
}

function readSetupDraft() {
  return Object.fromEntries(Object.entries(setupFields).map(([key, input]) => [key, input.value]));
}

function renderSetupPreview() {
  const labels = { voice: "Voice profile", greeting: "Greeting", hours: "Business hours" };
  const draft = readSetupDraft();
  setupPreview.replaceChildren(...Object.entries(labels).flatMap(([key, label]) => {
    const term = document.createElement("dt");
    term.textContent = label;
    const value = document.createElement("dd");
    const before = document.createElement("span");
    before.textContent = `Default: ${setupDefaults[key]}`;
    const proposed = document.createElement("span");
    proposed.textContent = `Draft: ${draft[key]}`;
    value.append(before, proposed);
    return [term, value];
  }));
}

function requestSetupReview() {
  const draft = readSetupDraft();
  if (!validateSetupDraft(draft)) {
    setupStatus.textContent = "This draft has an unsupported value. Check each field's allowed values and length.";
    setupStatus.setAttribute("role", "alert");
    return;
  }
  setupStatus.setAttribute("role", "status");
  setupApprovalMessage.replaceChildren();
  const list = document.createElement("ul");
  for (const [label, value] of [
    ["Voice profile", draft.voice],
    ["Greeting", draft.greeting],
    ["Business hours", draft.hours],
  ]) {
    const item = document.createElement("li");
    item.textContent = `${label}: ${value}`;
    list.append(item);
  }
  setupApprovalMessage.append(list);
  setupApproval.returnValue = "deny";
  setupApproval.showModal();
}

filter.addEventListener("valuechange", (event) => {
  filterValue = event.detail.value;
  renderRows();
  status.textContent = event.detail.source === "agent"
    ? "Owner approved an agent change to this draft view. No business data was changed."
    : "Draft filter updated locally. No business data was changed.";
});

for (const input of Object.values(setupFields)) {
  const component = input.closest("ui-input");
  component.addEventListener("valuechange", (event) => {
    input.value = event.detail.value;
    renderSetupPreview();
    setupStatus.setAttribute("role", "status");
    setupStatus.textContent = event.detail.source === "agent"
      ? "Agent edited only a local setup draft. It remains unpublished."
      : "Local setup draft changed. It remains unpublished.";
  });
}

document.querySelector("#review-setup").addEventListener("click", requestSetupReview);
setupApproval.addEventListener("close", () => {
  if (setupApproval.returnValue === "approve") {
    setupStatus.textContent = "Owner approved this local draft only. It is not saved, published, or connected to a provider.";
  } else {
    setupStatus.textContent = "Owner canceled. The settings remain a local draft and are not published.";
  }
});

const agent = createAgent({
  allow: async (step, { signal }) => {
    if (!isAllowedAgentAction(step)) return false;
    return requestOwnerConfirmation(step, signal);
  },
});

renderRows();
renderSetupPreview();
Object.assign(window, { uiAgent: agent });
