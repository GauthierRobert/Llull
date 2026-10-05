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
