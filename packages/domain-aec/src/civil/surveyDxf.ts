/**
 * Survey points from a DXF: 3D points, polyline / line vertices (contours, breaklines), 3D face
 * corners and numeric spot-height texts become a point group for create_surface.
 * @layer domain-aec/civil
 */

import type { Vec3 } from '@core/model/types';
import { DOCUMENT_UNITS } from '@core/model/types';
import type { PointGroupObject, SurveyPoint } from '@core/model/civil';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { flattenDxf, parseDxf, type DxfPrimitive } from '@lib/dxfRead';
import { insUnitsMillimetres } from '@lib/dxfUnits';
import {
  civilAffected,
  civilObjectsOf,
  fromUnit,
  getCivil,
  nextCivilId,
  withObject,
} from './model';
import { regenerateCivil } from './evaluate';

const SOURCES = ['points', 'vertices', 'faces', 'text'] as const;
type Source = (typeof SOURCES)[number];

const MAX_POINTS = 50000;
const SPOT_HEIGHT = /^[+]?\s*(-?\d+(?:[.,]\d+)?)\s*m?$/i;

/** [x, y, z, code] samples of one primitive for the requested sources. */
function samples(primitive: DxfPrimitive, sources: ReadonlySet<Source>): Vec3[] {
  switch (primitive.kind) {
    case 'point':
      return sources.has('points') ? [primitive.at] : [];
    case 'line':
      return sources.has('vertices') ? [primitive.a, primitive.b] : [];
    case 'polyline':
      return sources.has('vertices') ? [...primitive.points] : [];
    case 'face':
      return sources.has('faces') ? [...primitive.corners] : [];
    case 'text': {
      if (!sources.has('text')) return [];
      const match = SPOT_HEIGHT.exec(primitive.content.trim());
      if (!match) return [];
      return [[primitive.at[0], primitive.at[1], Number((match[1] as string).replace(',', '.'))]];
    }
    case 'arc':
    case 'circle':
      return [];
  }
}

/**
 * @command import_survey_dxf
 * @pure
 * @affects creates 1 point group
 * @failure not a DXF / no elevated point -> no-op
 */
export const importSurveyDxf = defineCommand({
  name: 'import_survey_dxf',
  description:
    'Extract survey points from a topographic DXF into a point group, ready for create_surface: ' +
    'POINT entities, vertices of 3D polylines / elevated contours / lines (breaklines), 3DFACE ' +
    'corners and, optionally, numeric spot-height TEXT ("123.45" placed at the level). Filter by ' +
    'DXF `layers` (e.g. ["TOPO_PTS", "CONTOURS"]). Points at elevation 0 are ignored unless ' +
    '`keepZeroElevation`. Units from $INSUNITS unless `sourceUnit`.',
  params: z.object({
    text: z.string().describe('DXF file content (ASCII).'),
    name: z.string().optional().describe('Point group name. Default "DXF survey <n>".'),
    layers: z
      .array(z.string())
      .optional()
      .describe('Only these DXF layers (case-insensitive). Default: every layer.'),
    sources: z
      .array(z.enum(SOURCES))
      .optional()
      .describe(
        'What becomes a point: points, vertices, faces, text. Default points, vertices, faces.',
      ),
    sourceUnit: z
      .enum(DOCUMENT_UNITS)
      .optional()
      .describe('Drawing unit when $INSUNITS is missing. Default: $INSUNITS, else m.'),
    keepZeroElevation: z.boolean().optional().describe('Keep points at z = 0. Default false.'),
  }),
  run: (doc, params): CommandResult => {
    const drawing = parseDxf(params.text);
    if (drawing === null) {
      return noop(doc, 'import_survey_dxf failed: not an ASCII DXF with an ENTITIES section.');
    }
    const headerMm = insUnitsMillimetres(drawing.insUnits);
    const unit =
      params.sourceUnit ??
      (headerMm === null
        ? 'm'
        : (DOCUMENT_UNITS.find((u) => fromUnit({ units: 'mm' }, 1, u) === headerMm) ?? 'm'));
    const sources = new Set<Source>(params.sources ?? ['points', 'vertices', 'faces']);
    const wanted = params.layers?.map((layer) => layer.toLowerCase());
    const seen = new Set<string>();
    const points: SurveyPoint[] = [];
    let zeros = 0;
    for (const primitive of flattenDxf(drawing).primitives) {
      if (wanted !== undefined && !wanted.includes(primitive.layer.toLowerCase())) continue;
      for (const [x, y, z] of samples(primitive, sources)) {
        if (z === 0 && params.keepZeroElevation !== true) {
          zeros += 1;
          continue;
        }
        const key = `${x.toFixed(4)},${y.toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        points.push({
          number: String(points.length + 1),
          position: [fromUnit(doc, x, unit), fromUnit(doc, y, unit), fromUnit(doc, z, unit)],
          code: primitive.layer,
        });
      }
    }
    if (points.length === 0) {
      return noop(
        doc,
        `import_survey_dxf: no elevated point found${zeros > 0 ? ` (${zeros} at elevation 0 ignored — pass keepZeroElevation)` : ''}.`,
      );
    }
    if (points.length > MAX_POINTS) {
      return noop(
        doc,
        `import_survey_dxf failed: ${points.length} points exceed the ${MAX_POINTS}-point limit; filter by layers.`,
      );
    }
    const civil = getCivil(doc);
    const id = nextCivilId(civil, 'pointGroup');
    const group: PointGroupObject = {
      id,
      category: 'pointGroup',
      name: params.name?.trim() || `DXF survey ${civilObjectsOf(civil, 'pointGroup').length + 1}`,
      entityIds: [],
      points,
    };
    const document = regenerateCivil(doc, withObject(civil, group));
    return {
      document,
      summary:
        `Imported ${points.length} survey points from DXF (${unit}) as ${group.name} (${id})` +
        (zeros > 0 ? `; ${zeros} at elevation 0 ignored.` : '.'),
      affected: civilAffected(document, [id]),
      data: { pointGroupId: id, count: points.length },
    };
  },
});
