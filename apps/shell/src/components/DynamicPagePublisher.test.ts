import { expect, it } from "vitest";
import { buildDynamicPagePreviewDocument } from "./DynamicPagePublisher";

it("isolates owner previews from scripts, forms and remote asset requests", () => {
  const preview = buildDynamicPagePreviewDocument("<img src='https://tracker.example/pixel'><form><button>Join</button></form>");
  expect(preview).toContain("default-src 'none'");
  expect(preview).toContain("img-src data:");
  expect(preview).toContain("form-action 'none'");
  expect(preview).toContain("<img src='https://tracker.example/pixel'>");
});
