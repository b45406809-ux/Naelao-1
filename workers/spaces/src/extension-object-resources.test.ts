import { describe, expect, it } from "vitest";
import { decodeExtensionObjectBase64, EXTENSION_OBJECT_MAX_BYTES, isExtensionObjectContentType, isExtensionObjectKey } from "@naelao/agent-sdk";

describe("extension object value bounds", () => {
  it("accepts namespaced relative keys and rejects traversal, empty segments, and overlong keys", () => {
    expect(isExtensionObjectKey("profiles/user-1.json")).toBe(true);
    for (const value of ["../secret", "a/../secret", "a//b", ".secret", "a/./b", "a\\b", "x".repeat(129), "a/é"]) {
      expect(isExtensionObjectKey(value), value).toBe(false);
    }
  });

  it("accepts only canonical base64 within the per-object byte ceiling", () => {
    expect(decodeExtensionObjectBase64("aGVsbG8=")).toEqual(new TextEncoder().encode("hello"));
    for (const value of ["aGVsbG8", "aGVsbG8=\n", "aGVsbG8!", "AB==", "A==="]) expect(decodeExtensionObjectBase64(value)).toBeNull();
    const maximum = btoa("x".repeat(EXTENSION_OBJECT_MAX_BYTES));
    expect(decodeExtensionObjectBase64(maximum)?.byteLength).toBe(EXTENSION_OBJECT_MAX_BYTES);
    expect(decodeExtensionObjectBase64(btoa("x".repeat(EXTENSION_OBJECT_MAX_BYTES + 1)))).toBeNull();
  });

  it("accepts bounded MIME essence values only", () => {
    expect(isExtensionObjectContentType("application/json")).toBe(true);
    for (const value of ["text/plain; charset=utf-8", "text/plain\r\nX: y", "not-a-type", "x".repeat(129)]) {
      expect(isExtensionObjectContentType(value)).toBe(false);
    }
  });
});
