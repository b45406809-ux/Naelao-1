import "@ui-sdk/web/field";
import "@ui-sdk/web/input";
import { createAgent } from "@ui-sdk/web/agent";
import { createBusinessActionClient } from "@naelao/agent-sdk";
import { isAllowedAgentAction, validateSetupDraft } from "./agent-policy.mjs";
import { readAuthorizedLowStock, resolveBusinessActionEndpoint } from "./inventory-bridge.mjs";
import "./style.css";

const products = [
  { name: "Paper clips", onHand: 18, version: 1, reorderPoint: 20 },
  { name: "Blue notebooks", onHand: 42, version: 1, reorderPoint: 15 },
  { name: "Desk lamps", onHand: 6, version: 1, reorderPoint: 8 },
  { name: "Shipping labels", onHand: 120, version: 1, reorderPoint: 40 },
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
const embeddedCanvas = window.parent !== window;
const hostActionEndpoint = resolveBusinessActionEndpoint(window.location.pathname, embeddedCanvas);
const businessActionClient = hostActionEndpoint ? createBusinessActionClient(hostActionEndpoint) : null;
let authorizedProducts = null;
let inventoryReadSequence = 0;
const setupFields = {
  voice: document.querySelector("#voice-profile"),
  greeting: document.querySelector("#greeting"),
  hours: document.querySelector("#business-hours"),
};
const setupDefaults = Object.fromEntries(Object.entries(setupFields).map(([key, input]) => [key, input.value]));

function renderRows() {
  if (embeddedCanvas) {
    const visibleProducts = authorizedProducts ?? [];
    rows.replaceChildren(...visibleProducts.map((product) => {
      const row = document.createElement("tr");
      for (const value of [product.productId, String(product.quantity), String(product.version), product.quantity <= 20 ? "Low stock" : "In range"]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    }));
    count.textContent = authorizedProducts === null ? "No authorized read yet" : `${visibleProducts.length} authorized ${visibleProducts.length === 1 ? "row" : "rows"}`;
    return;
  }
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
        String(product.version),
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

async function refreshAuthorizedInventory() {
  const sequence = ++inventoryReadSequence;
  if (!businessActionClient) {
    authorizedProducts = null;
    renderRows();
    status.textContent = "No recognized active Canvas host. No synthetic rows are shown in an embedded frame.";
    return;
  }
  if (filterValue.trim().toLowerCase() !== "low stock") {
    authorizedProducts = null;
    renderRows();
    status.textContent = "Choose “low stock” to run the signed read-only action; no server data is requested for this draft filter.";
    return;
  }
  authorizedProducts = null;
  renderRows();
  status.textContent = "Requesting the signed read-only low-stock action from this Canvas host…";
  try {
    const result = await readAuthorizedLowStock(businessActionClient);
    if (sequence !== inventoryReadSequence) return;
    authorizedProducts = result.products;
    renderRows();
    status.textContent = `Host-authorized read completed. ${result.products.length} bounded rows returned${result.hasMore ? "; more rows are available through the action cursor" : ""}. No data was changed.`;
  } catch (error) {
    if (sequence !== inventoryReadSequence) return;
    authorizedProducts = [];
    renderRows();
    const code = typeof error?.errorCode === "string" ? error.errorCode : error instanceof Error ? error.message : "read_failed";
    status.textContent = `Authorized inventory read unavailable (${String(code).slice(0, 120)}). Synthetic rows are not shown inside an embedded Canvas.`;
  }
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
  if (embeddedCanvas) void refreshAuthorizedInventory();
  else {
    renderRows();
    status.textContent = event.detail.source === "agent"
      ? "Owner approved an agent change to this synthetic draft view. No business data was changed."
      : "Synthetic draft filter updated locally. No business data was changed.";
  }
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
if (embeddedCanvas) {
  document.querySelector(".eyebrow").textContent = "Embedded Canvas · signed host actions only";
  document.querySelector("#table-heading").textContent = "Host-authorized inventory";
  document.querySelector("#inventory-description").textContent = "The low-stock filter calls the installed, signed read-only action; no synthetic fallback is used in this frame.";
  document.querySelector("#boundary-heading + p").textContent = "Filter edits change only the draft view. In an active signed Canvas, low-stock results come from the owner/admin-authorized read action; no business data is written.";
  if (!businessActionClient) status.textContent = "This embedded page is outside a recognized active Space/Project Canvas route. No synthetic rows are shown.";
  else status.textContent = "Choose “low stock” to retrieve a bounded page through the signed, owner/admin-authorized read action.";
}
Object.assign(window, { uiAgent: agent });
