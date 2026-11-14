import { describe, expect, it } from "vitest";
import { validateMachineHardware, type MachineHardware } from "./tunnel-protocol.js";

const hardware: MachineHardware = {
  platform: "linux", arch: "x64", cpuCount: 4, memoryBytes: 8_000_000_000,
  capabilities: [], models: ["qwen:7b", "llama3.2"],
  modelProfiles: [{ id: "qwen:7b", inputModalities: ["text", "image"], outputModalities: ["text"], contextTokens: 32768, toolCalling: true }],
};

describe("named machine model profile contract", () => {
  it("accepts bounded profiles only for models in the machine inventory", () => {
    expect(() => validateMachineHardware(hardware)).not.toThrow();
    expect(() => validateMachineHardware({ ...hardware, modelProfiles: [{ ...hardware.modelProfiles![0]!, id: "missing" }] })).toThrow("tunnel_hardware_invalid");
  });

  it("rejects unknown fields and invalid context or capability declarations", () => {
    expect(() => validateMachineHardware({ ...hardware, modelProfiles: [{ ...hardware.modelProfiles![0]!, endpoint: "https://example.test" }] })).toThrow("tunnel_hardware_invalid");
    expect(() => validateMachineHardware({ ...hardware, modelProfiles: [{ ...hardware.modelProfiles![0]!, contextTokens: 9_000_000 }] })).toThrow("tunnel_hardware_invalid");
    expect(() => validateMachineHardware({ ...hardware, modelProfiles: [{ ...hardware.modelProfiles![0]!, toolCalling: "yes" as never }] })).toThrow("tunnel_hardware_invalid");
  });
});
