/**
 * Exact-length tuple schemas for building command params.
 * @layer core/commands/building
 * @invariant output type is exactly `[number, number]` / `[number, number, number]` (no rest element)
 */

import { z } from '../schema';

/** Plan point `[x, y]`. */
export function vec2(description: string): z.ZodTuple<[z.ZodNumber, z.ZodNumber], null> {
  return z.tuple([z.number(), z.number()]).describe(description);
}

/** Space point `[x, y, z]`. */
export function vec3(
  description: string,
): z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber], null> {
  return z.tuple([z.number(), z.number(), z.number()]).describe(description);
}
