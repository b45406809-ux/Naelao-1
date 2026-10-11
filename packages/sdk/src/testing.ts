import { parseExtensionPrimitive, serializeExtensionPrimitive, type ExtensionPrimitiveManifest } from "@naelao/agent-sdk";

export function createContractTestHarness() {
  return Object.freeze({
    parse: parseExtensionPrimitive,
    roundTrip(value: ExtensionPrimitiveManifest): ExtensionPrimitiveManifest { return parseExtensionPrimitive(JSON.parse(serializeExtensionPrimitive(value))); },
  });
}
