import { type ZodObject, type ZodRawShape, type ZodType, z } from "zod";

/** Provider objects evolve frequently: retain new fields while coercing common primitives. */
export function lenientObject<T extends ZodRawShape>(shape: T): ZodObject<T> {
  return z.object(shape).passthrough();
}

export const optionalString = z.coerce.string().optional().catch(undefined);
export const optionalNumber = z.coerce.number().optional().catch(undefined);
export const optionalBoolean = z
  .union([
    z.boolean(),
    z.enum(["true", "false"]).transform((value) => value === "true"),
    z.enum(["1", "0"]).transform((value) => value === "1"),
    z.union([z.literal(1), z.literal(0)]).transform((value) => value === 1),
  ])
  .optional()
  .catch(undefined);

export function parseLenient<T>(
  schema: ZodType<T>,
  payload: unknown,
  fallback: T
): T {
  return schema.catch(fallback).parse(payload);
}
