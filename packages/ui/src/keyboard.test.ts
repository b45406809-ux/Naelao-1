import { describe, expect, it, vi } from "vitest";
import { activateOnKeyboard } from "./keyboard";

describe("activateOnKeyboard", () => {
  it.each(["Enter", " "]) ("activates on %s and prevents its default", (key) => {
    const activate = vi.fn();
    const preventDefault = vi.fn();
    activateOnKeyboard({ key, preventDefault }, activate);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
  });

  it.each(["Tab", "Escape", "ArrowDown"]) ("ignores %s", (key) => {
    const activate = vi.fn();
    const preventDefault = vi.fn();
    activateOnKeyboard({ key, preventDefault }, activate);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });
});
