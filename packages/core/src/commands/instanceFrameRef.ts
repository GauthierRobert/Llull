import type { CadDocument } from '../model/types';
import { z } from './schema';

type InstanceFrameRefSchema = z.ZodObject<{
  instanceId: z.ZodString;
  frame: z.ZodOptional<
    z.ZodEnum<{ origin: 'origin'; 'axis-x': 'axis-x'; 'axis-y': 'axis-y'; 'axis-z': 'axis-z' }>
  >;
}>;

/**
 * Params object `{ instanceId, frame? }` naming one frame of an InstanceEntity (`add_joint`, `add_mate`).
 * @param ordinal which side the object is, for the `instanceId` description
 * @param description agent-facing description of the whole object
 */
export function instanceFrameRef(
  ordinal: 'first' | 'second',
  description: string,
): InstanceFrameRefSchema {
  return z
    .object({
      instanceId: z.string().describe(`Id of the ${ordinal} InstanceEntity.`),
      frame: z
        .enum(['origin', 'axis-x', 'axis-y', 'axis-z'])
        .optional()
        .describe('Frame selector: origin (default), axis-x, axis-y, or axis-z.'),
    })
    .describe(description);
}

/**
 * First problem with the `a` / `b` instance refs of `command`, or null when both name an existing
 * InstanceEntity.
 */
export function instanceRefsProblem(
  doc: CadDocument,
  command: string,
  refs: Readonly<Record<'a' | 'b', { readonly instanceId: string }>>,
): string | null {
  for (const side of ['a', 'b'] as const) {
    const { instanceId } = refs[side];
    if (instanceId.length === 0) {
      return `${command}: ${side} must be an object with a non-empty instanceId string.`;
    }
    if (doc.entities[instanceId]?.kind !== 'instance') {
      return `${command}: ${side}.instanceId '${instanceId}' does not exist or is not an InstanceEntity.`;
    }
  }
  return null;
}
