import { describe, expect, it } from "vitest";
import { preparePerception } from "./perception.js";
describe("explicit vision turns", () => {
  const image = { image_base64: "aGVsbG8=", mime_type: "image/png", screenshot_path: "private.png" };
  it("keeps navigate and old screenshots out of textual context", () => {
    const state = preparePerception([{ name: "browser.navigate", ok: true, params: {}, output: image }]);
    expect(state.imageUrl).toBeUndefined(); expect(JSON.stringify(state.steps)).not.toContain("aGVsbG8=");
    expect(JSON.stringify(state.steps)).toContain("private.png");
  });
  it("recognizes the explicit CLI see without treating a shell pipeline as permission", () => {
    const last = { name: "Bash", ok: true, params: { commands: "see latest" }, output: image };
    expect(preparePerception([last]).imageUrl).toBe("data:image/png;base64,aGVsbG8=");
    expect(preparePerception([{ ...last, params: { commands: "echo see" } }]).imageUrl).toBeUndefined();
    expect(preparePerception([{ ...last, params: { commands: "see latest; echo ok" } }]).imageUrl).toBeUndefined();
  });
  it("injects only the last explicit see result and discards it on the following action", () => {
    const see = { name: "browser.see", ok: true, params: {}, output: image };
    expect(preparePerception([see]).imageUrl).toBe("data:image/png;base64,aGVsbG8=");
    expect(preparePerception([see, { name: "Read", ok: true, params: {}, output: "text" }]).imageUrl).toBeUndefined();
    expect(preparePerception([{ ...see, ok: false }]).imageUrl).toBeUndefined();
  });
});
