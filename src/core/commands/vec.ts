/**
 * Vector param schemas typed as fixed tuples. Runtime accepts any number array — length and
 * shape are validated (or tolerated, e.g. `[x, y]` position shorthand) inside each command,
 * exactly as before the zod migration.
 *
 * @layer core/commands
 * @invariant emits the same agent-facing spec as an `array<number>` ParamSpec
 */

import type { Vec2, Vec3 } from '../model/types';
import { z } from './schema';

/** `[x, y]` typed vector; runtime accepts any number array. */
export function vec2(description: string): z.ZodType<Vec2> {
  return z.array(z.number()).describe(description) as unknown as z.ZodType<Vec2>;
}

/** `[x, y, z]` typed vector; runtime accepts any number array. */
export function vec3(description: string): z.ZodType<Vec3> {
  return z.array(z.number()).describe(description) as unknown as z.ZodType<Vec3>;
}
