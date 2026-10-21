import { describe, expect, it } from "vitest";
import { isTrustedDomInspectionMessage } from "./dom-inspector-message";

describe("DOM inspector postMessage boundary", () => {
  const frameWindow = {};
  const valid = { type: "AVOS_DOM_CLICK", selector: "button:nth-child(1)", tag: "button", text: "Continue" };

  it("accepts bounded inspection data only from a registered preview frame", () => {
    expect(isTrustedDomInspectionMessage(frameWindow, valid, [frameWindow])).toBe(true);
  });

  it("rejects forged sources and malformed or oversized payloads", () => {
    expect(isTrustedDomInspectionMessage({}, valid, [frameWindow])).toBe(false);
    expect(isTrustedDomInspectionMessage(frameWindow, { ...valid, selector: "x".repeat(513) }, [frameWindow])).toBe(false);
    expect(isTrustedDomInspectionMessage(frameWindow, { ...valid, tag: "script>alert(1)" }, [frameWindow])).toBe(false);
    expect(isTrustedDomInspectionMessage(frameWindow, { ...valid, text: "x".repeat(81) }, [frameWindow])).toBe(false);
  });
});
