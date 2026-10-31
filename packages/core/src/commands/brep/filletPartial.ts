/**
 * The `partial` option of fillet_edge (BLD M5, FR-BLD-11, TECHNICAL_SPEC 13.25): a blend over t in [start, end] of the edge with a run-out. It is refused by name: the native kernel only builds a radius law that stays above zero along the
 * whole edge, and the nearest law (falling to 1e-3 of the plateau radius at both ends) leaves a blend face along the part that was to stay sharp, seven faces on a cube instead of six (server/tests/nativePartialFillet.test.ts).
 * @invariant the range is validated first (finite, 0 <= start < end <= 1); a valid range is refused with the measured reason, nothing is built, the document is unchanged
 * @failure start / end not finite or outside [0, 1] or start >= end -> BLD_LAW_INVALID (path partial); a valid range -> BLD_PARTIAL_UNSUPPORTED
 */

import { z } from '../schema';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { blendRejection } from './blendCodes';

export const partialSchema = z
  .object({
    start: z.number().describe('Relative position along the edge where the blend starts (0 = the edge start), 0 <= start < end.'),
    end: z.number().describe('Relative position along the edge where the blend ends (1 = the edge end), start < end <= 1.'),
  })
  .describe(
    'Always refused (BLD_PARTIAL_UNSUPPORTED, a bad range BLD_LAW_INVALID): a blend over t in [start, end] of the edge is not built; use edges[].sizes / sizeEnd for a varying radius, corners (setback) to stop a blend short of a vertex, or chamfer_edge with distanceEnd.',
  );

/** The `partial` param is declared so that it is refused by name and never silently ignored (an undeclared key would be): a stub to implement or remove under FR-BLD-11. */

/** The refusal of a `partial` option, or null when there is none. */
export function refusePartial(doc: CadDocument, id: string, partial: { start: number; end: number } | undefined): CommandResult | null {
  if (partial === undefined) return null;
  const { start, end } = partial;
  if (!(Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= 1 && start < end))
    return blendRejection(
      doc,
      'fillet_edge',
      'BLD_LAW_INVALID',
      `partial must satisfy 0 <= start < end <= 1 (got start ${start}, end ${end})`,
      [id],
      ['partial'],
    );
  return blendRejection(
    doc,
    'fillet_edge',
    'BLD_PARTIAL_UNSUPPORTED',
    `a partial fillet over t in [${start}, ${end}] is not built: the kernel needs a radius above zero along the whole edge, and the nearest law (1e-3 of the radius at both ends) leaves a blend face on the part that should stay sharp (a cube edge gets 7 faces instead of 6)`,
    [id],
    ['partial'],
  );
}
