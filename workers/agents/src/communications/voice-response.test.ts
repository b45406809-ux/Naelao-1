import { describe, it, expect } from "vitest";
import { renderExtensionVoiceResponse as render } from "./voice-response.js";
describe("extension-owned voice presentation", () => {
  it("renders extension-selected prompts and digit counts with host-owned callbacks", () => {
    expect(
      render(
        { actions: [{ type: "gather", text: "Choose an option", digits: 3 }] },
        "https://host/menu"
      )
    ).toContain('numDigits="3"');
    expect(
      render(
        { actions: [{ type: "say", text: "<script>&" }, { type: "hangup" }] },
        "https://host/menu"
      )
    ).toBe("<Say>&lt;script&gt;&amp;</Say><Hangup/>");
  });
  it("renders only the bounded Twilio man/woman Say styles", () => {
    expect(render({ actions: [
      { type: "say", text: "Welcome", style: "woman" },
      { type: "gather", text: "Choose one", input: "dtmf", digits: 1, style: "man" },
    ] }, "https://host/menu")).toBe('<Say voice="woman">Welcome</Say><Gather input="dtmf" numDigits="1" timeout="10" action="https://host/menu" method="POST"><Say voice="man">Choose one</Say></Gather><Hangup/>');
    expect(() => render({ actions: [{ type: "say", text: "Hi", style: "Polly.Joanna" }] }, "/menu")).toThrow();
  });
  it("rejects executable TwiML, arbitrary URLs and unauthorized financial call actions", () => {
    for (const value of [
      "<Dial>evil</Dial>",
      { actions: [{ type: "dial", number: "+19005550100" }] },
      {
        actions: [
          { type: "gather", text: "Hi", digits: 1, url: "https://evil" },
        ],
      },
      { actions: [{ type: "say", text: "x".repeat(2001) }] },
    ])
      expect(() => render(value, "https://host/menu")).toThrow();
  });
});
