/**
 * Guard of a second fillet step (BLD M0, TECHNICAL_SPEC 13.26): a circular fillet run along the rim of a round the solid already carries, with a radius larger than that round, is a spindle torus; OCCT answers with an approximating
 * B-spline that is not tangent to the round (0.044 rad for r1 1 / r2 2, 0.029 for r1 2 / r2 3, measured with the exact face projection: server/tests/nativeFilletKink.test.ts). The built result is read back with check_blends and a G1 failure is
 * refused by name instead of returning a solid that fails its own check.
 * @invariant only a source that already carries a fillet is read back (the first step of a solid meets nothing it could kink against); the limit is the check_blends G1 default
 * @failure a BLD_CHECK_G1_ANGLE failure on the new solid -> BLD_FILLET_NOT_TANGENT (path radius) with the measured angle and the edge, the document unchanged
 */

import type { CadDocument, ShapeRecipe } from '../../model/types';
import { filletNodes } from '../../geometry/blend/blendInfo';
import type { CommandResult, ExecutionContext } from '../types';
import { blendRejection } from './blendCodes';
import { checkBlends } from './checkBlends';

interface G1Finding {
  readonly code: string;
  readonly severity: string;
  readonly value?: number;
  readonly limit?: number;
  readonly edge?: number;
}

/** The refusal of `committed` (the result of a fillet step on `source`) when its new blends are not tangent to the blends already there, else null. */
export function refuseKinkedFillet(
  doc: CadDocument,
  command: string,
  id: string,
  committed: CommandResult,
  source: ShapeRecipe,
  ctx: ExecutionContext | undefined,
): CommandResult | null {
  const created = committed.affected[0];
  if (committed.document === doc || created === undefined || filletNodes(source).length === 0) return null;
  const checked = checkBlends.run(committed.document, { ids: [created] }, ctx);
  const findings = ((checked.data as { findings?: G1Finding[] } | undefined)?.findings ?? []).filter(
    (finding) => finding.code === 'BLD_CHECK_G1_ANGLE' && finding.severity === 'fail',
  );
  const worst = findings.reduce<G1Finding | null>(
    (found, finding) => (found === null || (finding.value ?? 0) > (found.value ?? 0) ? finding : found),
    null,
  );
  if (worst === null) return null;
  return blendRejection(
    doc,
    command,
    'BLD_FILLET_NOT_TANGENT',
    `the blend meets a blend the solid already has with a normal angle of ${worst.value} rad (limit ${worst.limit}): OCCT approximates a fillet larger than the round it runs onto and the approximation is not tangent; use a radius up to that of the round, or round the edges in one step`,
    [id],
    ['radius'],
    { angleRad: worst.value, limitRad: worst.limit },
  );
}
