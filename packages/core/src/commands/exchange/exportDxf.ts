import type { CommandResult } from '../types';
import { defineCommand, z, confirmExportControlled } from '../schema';
import { exportRefusal, report } from '../noop';
import { Dxf2000Writer } from '../../lib/dxf2000';
import { writeDraftItem } from './draftDxf';
import { isRefusal, planDraftExport, skippedNote } from './draftExport';

/**
 * @affects none; data = { filename, dxf, version, units, entityCount, layers, exported, dimensions, skipped }
 * @invariant R2000 (AC1015) ASCII; entities in world xy at their plane elevation; $INSUNITS = document units; import_dxf reads it back
 * @failure empty ids / unknown id / non-2D id / id on a tilted plane, an image or with a dangling dimension / no 2D entity -> EXPORT2D_* refusal
 */
export const exportDxf = defineCommand({
  name: 'export_dxf',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Export 2D drafting entities (all of them, or `ids`) to an R2000 (AC1015) ASCII DXF (AutoCAD-compatible structure; verified with ezdxf, not yet opened in AutoCAD itself; ' +
    'import_dxf reads it back). Mapping: line -> LINE, circle -> CIRCLE, arc -> ARC, polyline -> LWPOLYLINE, rectangle -> closed LWPOLYLINE, ' +
    'ellipse -> ELLIPSE, spline -> SPLINE (the exact Catmull-Rom curve as a degree-3 B-spline), point -> POINT, text -> TEXT (MTEXT when it has ' +
    'several lines, MTEXT keeps rotation and anchor), hatched region -> HATCH (solid, parallel or crossed lines; even-odd loops), unhatched region -> one closed LWPOLYLINE per loop, ' +
    'dimension -> its extension / dimension lines and arrowheads as LINEs plus the value as centred TEXT on the dimension layer (not an ' +
    'associative DIMENSION). Each entity is placed by its position and Z rotation; Z is the plane elevation. Layers keep name, colour, hidden ' +
    'and locked state; an entity colour that differs from its layer is a true colour. $INSUNITS = the document units. Layer names lose the characters ' +
    'DXF forbids (< > / \\ " : ; ? * | = and the backquote become _). Entities on a tilted plane (rotation x or y not 0) and image underlays are skipped ' +
    'with a named warning when `ids` is omitted, and refused when named in `ids`. Returns `data`: { filename, dxf (the file text; --save writes it), ' +
    'version "AC1015", units, entityCount, layers, exported (entity ids), dimensions, skipped: [{ id, kind, reason }] }.',
  params: z.object({
    confirmExportControlled,
    ids: z
      .array(z.string())
      .optional()
      .describe(
        '2D entity ids to export (line, polyline, arc, circle, rectangle, ellipse, spline, point, text, dimension, region). Default: every 2D entity.',
      ),
  }),
  run: (doc, { confirmExportControlled, ids }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_dxf', 'data', confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const plan = planDraftExport(doc, 'export_dxf', ids);
    if (isRefusal(plan)) return plan;
    const writer = new Dxf2000Writer();
    for (const item of plan.items) writeDraftItem(writer, item);
    const dxf = `${writer.assemble(doc.units)}\n`;
    const layers = writer.layerNames;
    const count = plan.entityIds.length;
    return report(
      doc,
      `DXF R2000 drawing.dxf: ${count} 2D entit${count === 1 ? 'y' : 'ies'} as ${writer.entityCount} DXF entities on ${layers.length} layer(s) (${layers.join(', ')}), units ${doc.units}.` +
        (plan.dimensions > 0 ? ` ${plan.dimensions} dimension(s) written as lines + text (not associative).` : '') +
        skippedNote(plan.skipped),
      {
        filename: 'drawing.dxf',
        dxf,
        version: 'AC1015',
        units: doc.units,
        entityCount: writer.entityCount,
        layers,
        exported: plan.entityIds,
        dimensions: plan.dimensions,
        skipped: plan.skipped,
      },
    );
  },
});
