/** The `chordTolerance` parameter of the fabrication exports (STL, 3MF, OBJ) and the kernel tessellation it selects. */

import { currentContext } from '../context';
import { chordOptions, PREVIOUS_DISPLAY_TOLERANCE } from '../../geometry/exactMesh';
import type { ExactTessellation, TessellationReport } from '../../geometry/entityTriangles';
import type { ExecutionContext } from '../types';
import { z } from '../schema';

export const chordToleranceField = z
  .number()
  .positive()
  .optional()
  .describe(
    'Maximum chord error of the triangles of curved bodies, in DOCUMENT UNITS (default 0.1, the accuracy before the display mesh scaled with the part). ' +
      'With the exact native kernel, a body that keeps its exact recipe (a boolean / fillet / chamfer / shell / primitive kernel result) is re-tessellated at this ' +
      'tolerance (angular limit 0.5 rad), so the file is as accurate as asked whatever the size of the part: a smaller value gives more triangles. ' +
      'Without the exact kernel, or for bodies without a recipe (imported meshes, scans, analytic primitives), the stored triangles are exported and the tolerance is not applied; ' +
      'the summary says which path was used.',
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
export const tessellationReport = (used: ExportTessellation, exactIds: readonly string[], bodyCount: number): TessellationReport => ({
  chordTolerance: used.chordTolerance,
  exactIds,
  bodyCount,
});
