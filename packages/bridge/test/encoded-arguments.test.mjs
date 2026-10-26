import test from "node:test";
import assert from "node:assert/strict";
import { decodeBridgeArgument } from "../src/runtime.mjs";

test("decodes generated terminal-independent arguments without shell interpretation", () => {
  for (const value of ["/home/user/Tax files/$draft's (final)", "C:\\Users\\Tendai\\Project", "python -c 'print(1)' && echo $HOME"]) {
    const encoded = Buffer.from(value, "utf8").toString("base64");
    assert.equal(decodeBridgeArgument(encoded, 8192), value);
  }
});

test("rejects malformed, noncanonical, oversized, and invalid UTF-8 encoded arguments", () => {
  assert.throws(() => decodeBridgeArgument("AQI", 128), /bridge_encoded_argument_invalid/);
  assert.throws(() => decodeBridgeArgument("AB==", 128), /bridge_encoded_argument_invalid/);
  assert.throws(() => decodeBridgeArgument(Buffer.alloc(129).toString("base64"), 128), /bridge_encoded_argument_invalid/);
  assert.throws(() => decodeBridgeArgument("/w==", 128), /bridge_encoded_argument_invalid/);
});
