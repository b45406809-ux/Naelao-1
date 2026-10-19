import { describe, expect, it, vi } from "vitest";
import {
  type TracingConfig,
  createTracer,
  extractTraceId,
  formatTraceparent,
  generateSpanId,
  injectTraceId,
  parseTraceparent,
} from "./index.js";

function dataset(writeDataPoint = vi.fn()) {
  return { dataset: { writeDataPoint }, writeDataPoint };
}

describe("tracing boundaries", () => {
  it("parses, validates, and propagates canonical trace identifiers", () => {
    expect(
      parseTraceparent(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`)
    ).toMatchObject({
      traceId: "a".repeat(32),
      parentSpanId: "b".repeat(16),
      sampled: true,
    });
    expect(
      parseTraceparent(`00-${"0".repeat(32)}-${"b".repeat(16)}-01`)
    ).toBeNull();
    expect(
      extractTraceId({ "x-trace-id": "bad", "x-request-id": "also-bad" })
    ).toMatch(/^[a-f0-9]{32}$/);
    const headers = new Headers();
    injectTraceId(headers, "c".repeat(32));
    expect(headers.get("x-trace-id")).toBe("c".repeat(32));
    expect(() => injectTraceId(headers, "bad\r\nheader")).toThrow(
      "invalid_trace_context"
    );
    expect(() => formatTraceparent("0".repeat(32), generateSpanId())).toThrow(
      "invalid_trace_context"
    );
  });

  it("bounds span identity and Analytics Engine attribute payload", () => {
    const ae = dataset();
    const config: TracingConfig = {
      service: "agent",
      dataset: ae.dataset as never,
    };
    expect(() => createTracer(config, "invalid")).toThrow(
      "invalid_trace_context"
    );
    const span = createTracer(config, "a".repeat(32)).startSpan(
      "model.call",
      "b".repeat(16)
    );
    expect(() => span.setAttribute("too-large", "x".repeat(2_049))).toThrow(
      "trace_attribute_value_too_large"
    );
    expect(() => span.setAttribute("__proto__", "unsafe")).toThrow(
      "invalid_trace_attribute_key"
    );
    for (let index = 0; index < 64; index++)
      span.setAttribute(`field-${index}`, "x".repeat(150));
    expect(() => span.setAttribute("field-64", true)).toThrow(
      "too_many_trace_attributes"
    );
    const oversized = createTracer(config, "f".repeat(32)).startSpan(
      "large-attributes"
    );
    for (let index = 0; index < 5; index++)
      oversized.setAttribute(`large-${index}`, "x".repeat(2_000));
    expect(() =>
      oversized.setAttribute("large-final", "x".repeat(2_000))
    ).toThrow("trace_attributes_too_large");
  });

  it("writes an ended span once and clamps negative wall-clock movement", () => {
    const ae = dataset();
    const config: TracingConfig = {
      service: "agent",
      dataset: ae.dataset as never,
    };
    const span = createTracer(config, "d".repeat(32)).startSpan("operation");
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    span.end();
    span.end();
    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint.mock.calls[0]?.[0].doubles).toEqual([0]);
    now.mockRestore();
  });
});
