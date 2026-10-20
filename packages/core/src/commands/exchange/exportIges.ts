/** export_iges (SC-D4): IGES 5.3 of the document's 3D solids from the kernel's exact B-rep (native OCC kernel). */

import type { ShapeHandle } from '../../geometry/kernel';
import type { CommandResult } from '../types';
import { confirmExportControlled, defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { exportRefusal, noop } from '../noop';
import { operandRecipe } from '../brep/kernelShape';
import { stepTargets } from '../brep/stepTargets';

/**
 * @affects nothing — read-only
 * @invariant data = { format: 'iges', text (the IGES file), fileName, solidCount, entityIds, skipped }; exact B-rep, world space, millimetres
 * @failure no solids, no kernel, kernel without IGES export, a solid the kernel cannot build -> no-op, no data
 */
export const exportIges = defineCommand({
  name: 'export_iges',
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'Export 3D solids to IGES 5.3 from the exact B-rep (faces as true analytic / NURBS surfaces, B-rep solid entities, millimetres). ' +
    'Assembly instances are written as their world-space solids (IGES has no assembly structure; use export_step_exact for it). ' +
    'Needs the native OCC kernel; another kernel refuses. Returns data { format: "iges", text, fileName, solidCount, entityIds, skipped } ' +
    '(llull export_iges --save part.igs writes the file). Read IGES back with import_step_exact format "iges". Does not modify the document.',
  params: z.object({
    entityIds: z
      .array(z.string())
      .optional()
      .describe('Ids of the 3D solids to export. Omit or pass [] for every 3D solid of the document.'),
    fileName: z.string().optional().describe('Suggested file name. Default "model.igs".'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_iges', 'iges', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('export_iges'));
    if (kernel.exportIges === undefined) return noop(doc, 'export_iges: this kernel cannot write IGES; use the native OCC kernel.');
    const { solids, skipped } = stepTargets(doc, params.entityIds);
    if (solids.length === 0) return noop(doc, 'export_iges: no 3D solids to export.');
    const shapes: ShapeHandle[] = [];
    for (const entity of solids) {
      const shape = kernel.evaluate(operandRecipe(kernel, entity));
      if (shape === null)
        return noop(doc, `export_iges: the kernel could not build '${entity.id}' (kind '${entity.kind}'); nothing exported.`);
      shapes.push(shape);
    }
    const text = kernel.exportIges(shapes);
    if (text === null) return noop(doc, 'export_iges: the kernel refused to write these solids as IGES; nothing exported.');
    const entityIds = [...new Set(solids.map((entity) => entity.id))];
    return {
      document: doc,
      summary: `export_iges: ${solids.length} exact solid(s) → IGES 5.3, ${text.length} bytes${skipped.length > 0 ? `; skipped ${skipped.join(', ')}` : ''}.`,
      affected: [],
      data: { format: 'iges', text, fileName: params.fileName ?? 'model.igs', solidCount: solids.length, entityIds, skipped },
    };
  },
});
