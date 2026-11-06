/** The `chordTolerance` parameter of the fabrication exports (STL, 3MF, OBJ) and the kernel tessellation it selects. */

import { currentContext } from '../context';
import { chordOptions, MIN_CHORD_TOLERANCE, PREVIOUS_DISPLAY_TOLERANCE } from '../../geometry/exactMesh';
import type { ExactTessellation, TessellationReport } from '../../geometry/entityTriangles';
import type { ExecutionContext } from '../types';
import { z } from '../schema';
import { codedRejection } from '../noop';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';

export const chordToleranceField = z
  .number()
  .min(MIN_CHORD_TOLERANCE)
  .optional()
  .describe(
    'Maximum chord error of the triangles of curved bodies, in DOCUMENT UNITS (at least 0.0001; default 0.1, the accuracy before the display mesh scaled with the part). ' +
      'With the exact native kernel, a body that keeps its exact recipe (a boolean / fillet / chamfer / shell / primitive kernel result) is re-tessellated at this ' +
      'tolerance (angular limit 0.5 rad), so the file is as accurate as asked whatever the size of the part: a smaller value gives more triangles. ' +
      'Without the exact kernel, or for bodies without a recipe (imported meshes, scans, analytic primitives), the stored triangles are exported and the tolerance is not applied; ' +
      'the summary says which path was used. A tolerance finer than the body diagonal / 1000000 is refused (EXPORT_TESSELLATION_BUDGET: it would mesh the body into millions of triangles); the refusal names the smallest allowed value.',
  );

export interface ExportTessellation extends ExactTessellation {
  readonly chordTolerance: number;
}

/** The kernel and deflections a fabrication export re-tessellates with (`chordTolerance` default = `PREVIOUS_DISPLAY_TOLERANCE`). */
export function exportTessellation(ctx: ExecutionContext | undefined, chordTolerance: number | undefined): ExportTessellation {
  const tolerance = chordTolerance ?? PREVIOUS_DISPLAY_TOLERANCE.linearDeflection;
  return { kernel: (ctx ?? currentContext()).kernel, options: chordOptions(tolerance), chordTolerance: tolerance };
}

/** The summary report of a collected selection. */
export const tessellationReport = (
  used: ExportTessellation,
  collected: { readonly exactIds: readonly string[]; readonly recipeBodies: number },
): TessellationReport => ({
  chordTolerance: used.chordTolerance,
  kernel:
    used.kernel === null || used.kernel === undefined
      ? 'none'
      : used.kernel.honoursTessellationOptions === true
        ? 'honours-options'
        : 'ignores-options',
  recipeBodies: collected.recipeBodies,
  exactIds: collected.exactIds,
});

/** The coded refusal of an export whose chordTolerance is finer than the budget of a body (null when every body is within it). */
export function budgetRefusal(
  doc: CadDocument,
  command: string,
  chordTolerance: number,
  overBudget: ReadonlyArray<{ readonly id: string; readonly minimum: number }>,
): CommandResult | null {
  if (overBudget.length === 0) return null;
  const minimum = Math.max(...overBudget.map((entry) => entry.minimum));
  return codedRejection(
    doc,
    command,
    'EXPORT_TESSELLATION_BUDGET',
    `chordTolerance ${chordTolerance} would mesh ${overBudget.map((entry) => `'${entry.id}'`).join(', ')} into millions of triangles (diagonal / tolerance over 1000000)`,
    `use chordTolerance ${minimum.toPrecision(3)} or larger (the body diagonal / 1000000), or export a smaller part`,
    overBudget.map((entry) => entry.id),
  );
}
