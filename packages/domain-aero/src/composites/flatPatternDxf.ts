/** export_flat_patterns_dxf: ply flat patterns of plane, cylinder and cone tool faces as an R12 DXF in millimetres (FR-CMP-43, FR-CMP-50, VC-CMP-14..16). */

import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, report } from '@core/commands/noop';
import { MM_PER_UNIT } from '@core/model/units';
import type { Vec2 } from '@core/model/types';
import { DxfWriter, assembleDxf, dxfLayerName } from '@lib/dxfWriter';
import { offsetPolygon, polygonArea, polygonCentroid, toCounterClockwise } from '@lib/polygon';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { piecesOf } from './geometry2d';
import { compositesOf, findPart, findPly, pliesOf } from './state';
import { fibreDirection } from './surface';

const GAP_MM = 10;
const LABEL_FIELDS = ['name', 'orientation', 'sequence', 'material'] as const;

/**
 * @affects nothing (read-only)
 * @invariant one closed POLYLINE per ply piece on layer PLY_<ply name>, counter-clockwise, in mm ($INSUNITS 4), laid out left to right with a 10 mm gap; a 0-degree-referenced fibre arrow on layer ORIENT; a TEXT label per piece; developable faces unroll isometrically so the area equals the face area
 * @failure unknown part / ply -> CMP_REF_MISSING; no plies -> CMP_NO_PLIES
 */
export const exportFlatPatternsDxf = defineCommand({
  name: 'export_flat_patterns_dxf',
  annotations: { readOnly: true },
  description:
    'Export the flat patterns of the plies of a composite part as a DXF text file (R12, millimetres, $INSUNITS 4) ready for a ply cutter. ' +
    'Plane faces export the ply region as is; cylinders unroll to (arc length, axial) rectangles and cones to circular sectors, exactly ' +
    '(developable surfaces; fibre angles are preserved). Each ply piece is one closed counter-clockwise POLYLINE on layer PLY_<ply name>; a ' +
    'fibre-direction arrow sits on layer ORIENT and a text label (name, orientation in degrees, sequence, material; choose with `labels`) ' +
    'on the ply layer. Pieces are laid out left to right, 10 mm apart (no nesting). `plies` selects plies by id or name (default all); ' +
    '`allowance` (document length units, default 0) grows every outline for trimming. The DXF text is returned in data.files[0].content ' +
    '(mime image/vnd.dxf); save it with the CLI --save option. Plies with drape on a doubly curved face are not supported yet. Read-only.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    plies: z.array(z.string().describe('Ply id or name.')).describe('Plies to export; default every ply of the part.').optional(),
    labels: z
      .array(z.enum(LABEL_FIELDS))
      .describe('Label fields to write: name, orientation, sequence, material; default all four.')
      .optional(),
    allowance: z.number().describe('Trim allowance added around every outline, document length units; default 0; must be >= 0.').optional(),
    confirmExportControlled,
  }),
  run: (
    doc,
    { part: partRef, plies: selection, labels = [...LABEL_FIELDS], allowance = 0, confirmExportControlled: confirmation },
    ctx,
  ): CommandResult => {
    const refused = exportRefusal(doc, 'export_flat_patterns_dxf', 'data', confirmation, ctx);
    if (refused !== null) return refused;
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'export_flat_patterns_dxf', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    if (!(allowance >= 0))
      return refuseCmp(doc, 'export_flat_patterns_dxf', 'CMP_PARAM_INVALID', 'allowance must be >= 0', [part.id], ['params.allowance']);
    const chosen = selection === undefined ? pliesOf(model, part.id) : selection.map((ref) => findPly(model, part.id, ref));
    const missing = (selection ?? []).filter((_, i) => chosen[i] === null);
    if (missing.length > 0)
      return refuseCmp(
        doc,
        'export_flat_patterns_dxf',
        'CMP_REF_MISSING',
        `unknown ply(ies) ${missing.join(', ')}`,
        [part.id],
        ['params.plies'],
      );
    const plies = chosen.flatMap((ply) => (ply === null || ply.partId !== part.id ? [] : [ply]));
    if (plies.length === 0)
      return refuseCmp(
        doc,
        'export_flat_patterns_dxf',
        'CMP_NO_PLIES',
        `part "${part.name}" has no plies to export`,
        [part.id],
        ['params.part'],
      );
    const scale = MM_PER_UNIT[doc.units];
    const writer = new DxfWriter({ ORIENT: 3 });
    let cursor = 0;
    const pieces: Record<string, unknown>[] = [];
    for (const ply of plies) {
      const layer = `PLY_${dxfLayerName(ply.name)}`;
      const material = model.materials[ply.materialName];
      for (const [index, source] of piecesOf(ply, part).entries()) {
        const grown = allowance > 0 ? offsetPolygon(toCounterClockwise(source), allowance) : toCounterClockwise(source);
        const centre = polygonCentroid(grown);
        const xs = grown.map(([x]) => x * scale);
        const ys = grown.map(([, y]) => y * scale);
        const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
        const [width, height] = [Math.max(...xs) - minX, Math.max(...ys) - minY];
        const place = ([x, y]: Vec2): Vec2 => [x * scale - minX + cursor, y * scale - minY];
        writer.polyline(layer, grown.map(place), true);
        const direction = fibreDirection(part.surface, centre, ply.orientation);
        const size = 0.12 * Math.max(width, height, 1);
        const from = place(centre);
        const tip: Vec2 = [from[0] + direction[0] * size, from[1] + direction[1] * size];
        writer.line('ORIENT', from, tip);
        for (const wing of [0.5, -0.5]) {
          const back: Vec2 = [
            -direction[0] * 0.25 * size + -direction[1] * wing * 0.25 * size,
            -direction[1] * 0.25 * size + direction[0] * wing * 0.25 * size,
          ];
          writer.line('ORIENT', tip, [tip[0] + back[0], tip[1] + back[1]]);
        }
        const text = labels
          .map((field) =>
            field === 'name'
              ? ply.name
              : field === 'orientation'
                ? `${ply.orientation}deg`
                : field === 'sequence'
                  ? ply.sequence
                  : (material?.name ?? ply.materialName),
          )
          .join(' / ');
        if (text !== '')
          writer.text(
            layer,
            [from[0], from[1] - 0.06 * Math.max(width, height, 1)],
            Math.max(0.025 * Math.max(width, height), 1),
            text,
            'center',
          );
        pieces.push({
          ply: ply.id,
          name: ply.name,
          piece: index,
          widthMm: sig(width),
          heightMm: sig(height),
          areaMm2: sig(polygonArea(grown) * scale * scale),
          vertices: grown.length,
        });
        cursor += width + GAP_MM;
      }
    }
    const content = assembleDxf('mm', writer);
    const total = pieces.reduce((sum, piece) => sum + (piece['areaMm2'] as number), 0);
    return report(
      doc,
      `export_flat_patterns_dxf: part "${part.name}" (${part.surface.type} face): ${pieces.length} piece(s) of ${plies.length} ply(ies), total area ${sig(total)} mm^2, ${content.length} DXF characters (R12, mm).`,
      {
        part: part.id,
        surface: part.surface.type,
        unit: 'mm',
        files: [{ name: `${dxfLayerName(part.name)}.dxf`, mime: 'image/vnd.dxf', content }],
        pieces,
        provenance: {
          method: part.surface.type === 'plane' ? 'planar projection' : 'exact developable unrolling',
          reference: 'isometric development of the tool face',
          inputs: { part: part.id },
        },
      },
    );
  },
});
