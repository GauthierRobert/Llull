/** export_3mf: read-only export of the 3D bodies as a 3MF package (document returned unchanged, output in `data`). */

import type { CommandResult } from '../types';
import { confirmExportControlled, defineCommand, z } from '../schema';
import { exportRefusal, noop, report } from '../noop';
import { uint8ArrayToBase64 } from '../../lib/base64';
import { safeFileName } from '../../lib/safeFileName';
import { collectExportParts } from '../../geometry/entityTriangles';
import type { Vec3 } from '../../model/types';
import type { Triangle } from '../../geometry/triangles';
import { toMm } from '../../model/units';
import { entityIdsField } from './exportFormats';
import { buildThreeMf } from './threeMf';

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data = { format:'3mf', fileName, base64, objectCount, triangleCount, objects[{ name, vertices, triangles, manifold }] };
 *   one 3MF object per non-empty body (name, base-material colour); coordinates in millimetres whatever the document unit
 * @failure no exportable 3D body -> no-op, no data; 2D and unknown ids skipped
 */
export const export3mf = defineCommand({
  name: 'export_3mf',
  annotations: { readOnly: true },
  description:
    'Export the 3D bodies (all, or entityIds) as a 3MF package (.3mf, ZIP with 3D/3dmodel.model), the format slicers and print services ' +
    'read: one object per body carrying its name (set_entity_name, else the id) and its colour as a base material, one build item per ' +
    'object, units millimetre (document lengths are converted). Vertices are welded into an indexed mesh; data.objects[].manifold says ' +
    'whether each body is a closed, consistently oriented shell (printable). Returns data: { format:"3mf", fileName, base64, objectCount, ' +
    'triangleCount, objects[] }; the CLI writes it with --save PATH.3mf. 2D shapes and unknown ids are skipped. Does NOT modify the document.',
  params: z.object({
    entityIds: entityIdsField,
    name: z.string().optional().describe('File name without extension (default "model"); reduced to letters, digits, "." "_" "-".'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_3mf', '3mf', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const collected = collectExportParts(doc, params.entityIds);
    const mm = toMm(doc, 1);
    const scale = (v: Vec3): Vec3 => [v[0] * mm, v[1] * mm, v[2] * mm];
    const bodies = collected.parts
      .filter((part) => part.tris.length > 0)
      .map((part) => ({
        name: part.name ?? part.id,
        color: part.color,
        tris: part.tris.map(([a, b, c]): Triangle => [scale(a), scale(b), scale(c)]),
      }));
    if (bodies.length === 0) return noop(doc, 'export_3mf: no 3D body with geometry to export (2D shapes and unknown ids are skipped).');
    const { bytes, objects } = buildThreeMf(bodies);
    const triangleCount = objects.reduce((sum, object) => sum + object.triangles, 0);
    const open = objects.filter((object) => !object.manifold).map((object) => object.name);
    const fileName = `${safeFileName(params.name, 'model')}.3mf`;
    return report(
      doc,
      `export_3mf: ${objects.length} object(s), ${triangleCount} triangle(s), ${bytes.length} bytes → ${fileName} (millimetres).` +
        (open.length > 0 ? ` Not closed manifold shells: ${open.join(', ')}.` : '') +
        (collected.unknownIds.length > 0 ? ` Unknown ids skipped: ${collected.unknownIds.join(', ')}.` : ''),
      { format: '3mf', fileName, base64: uint8ArrayToBase64(bytes), objectCount: objects.length, triangleCount, objects },
    );
  },
});
