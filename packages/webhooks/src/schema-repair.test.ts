import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { repairPayloadSchema } from "./schema-repair.js";

describe("AI schema repair boundaries", () => {
  it("rejects model output that still fails the target schema", async () => {
    const run = vi.fn().mockResolvedValue({ response: '{"customerId":17}' });
    await expect(
      repairPayloadSchema(
        { customer_id: "cus_1" },
        z.object({ customerId: z.string() }),
        { AI: { run } }
      )
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("does not call the model for already-valid input", async () => {
    const run = vi.fn();
    await expect(
      repairPayloadSchema(
        { customerId: "cus_1" },
        z.object({ customerId: z.string() }),
        { AI: { run } }
      )
    ).resolves.toEqual({ customerId: "cus_1" });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects malformed model JSON instead of returning it as repaired data", async () => {
    const run = vi.fn().mockResolvedValue({ response: "not-json" });
    await expect(
      repairPayloadSchema(
        { customer_id: "cus_1" },
        z.object({ customerId: z.string() }),
        { AI: { run } }
      )
    ).rejects.toThrow();
  });

  it("caps input and output sizes before parsing or returning model data", async () => {
    const run = vi.fn().mockResolvedValue({
      response: JSON.stringify({ customerId: "x".repeat(65_537) }),
    });
    const schema = z.object({ customerId: z.string().length(1) });
    await expect(
      repairPayloadSchema({ customer_id: "cus_1" }, schema, { AI: { run } })
    ).rejects.toThrow("schema_repair_output_too_large");
    await expect(
      repairPayloadSchema({ customer_id: "x".repeat(65_537) }, schema, {
        AI: { run },
      })
    ).rejects.toThrow("schema_repair_input_too_large");
    expect(run).toHaveBeenCalledOnce();
  });
});
