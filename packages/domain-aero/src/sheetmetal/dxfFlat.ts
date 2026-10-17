/** R12 DXF of a flat pattern: LINE / CIRCLE / TEXT only, layers OUTLINE, CUTOUT, BEND_UP, BEND_DOWN and NOTES (FR-FTR-06, 37). */

import type { DocumentUnit, Vec2 } from '@core/model/types';
import { MM_PER_UNIT } from '@core/model/units';
import { toDegrees } from '@lib/angle';
import { DxfWriter, INSUNITS, fmt } from '@lib/dxfWriter';
import type { FlatBuild } from './flatData';

export const DXF_LAYERS = { outline: 'OUTLINE', cutout: 'CUTOUT', bendUp: 'BEND_UP', bendDown: 'BEND_DOWN', notes: 'NOTES' } as const;

/** AutoCAD Color Index per flat-pattern layer. */
const LAYER_COLOR: Readonly<Record<string, number>> = { OUTLINE: 7, CUTOUT: 1, BEND_UP: 3, BEND_DOWN: 5, NOTES: 2 };

type Group = readonly [code: number, value: string | number];

const flatten = (groups: ReadonlyArray<Group>): string[] => groups.flatMap(([code, value]) => [String(code), String(value)]);

export interface FlatDxf {
  readonly text: string;
  readonly entityCount: number;
  readonly layers: string[];
  /** [x, y] extent of the geometry in the output unit. */
  readonly extents: readonly [number, number];
}

function assemble(unit: DocumentUnit, writer: DxfWriter, bounds: readonly [number, number, number, number]): string {
  const layerRows = [...writer.layers].flatMap(([name, color]): Group[] => [
    [0, 'LAYER'],
    [2, name],
    [70, 0],
    [62, color],
    [6, 'CONTINUOUS'],
  ]);
  return [
    ...flatten([
      [0, 'SECTION'],
      [2, 'HEADER'],
      [9, '$ACADVER'],
      [1, 'AC1009'],
      [9, '$INSUNITS'],
      [70, INSUNITS[unit]],
      [9, '$EXTMIN'],
      [10, fmt(bounds[0])],
      [20, fmt(bounds[1])],
      [30, 0],
      [9, '$EXTMAX'],
      [10, fmt(bounds[2])],
      [20, fmt(bounds[3])],
      [30, 0],
      [0, 'ENDSEC'],
      [0, 'SECTION'],
      [2, 'TABLES'],
      [0, 'TABLE'],
      [2, 'LTYPE'],
      [70, 1],
      [0, 'LTYPE'],
      [2, 'CONTINUOUS'],
      [70, 0],
      [3, 'Solid line'],
      [72, 65],
      [73, 0],
      [40, '0.0'],
      [0, 'ENDTAB'],
      [0, 'TABLE'],
      [2, 'LAYER'],
      [70, writer.layers.size + 1],
      [0, 'LAYER'],
      [2, '0'],
      [70, 0],
      [62, 7],
      [6, 'CONTINUOUS'],
      ...layerRows,
      [0, 'ENDTAB'],
      [0, 'ENDSEC'],
      [0, 'SECTION'],
      [2, 'ENTITIES'],
    ]),
    ...writer.lines,
    ...flatten([
      [0, 'ENDSEC'],
      [0, 'EOF'],
    ]),
  ].join('\n');
}

/**
 * The DXF text of `build`'s flat pattern in `outUnit`, shifted so the bounding box starts at the origin; the NOTES layer sits below it.
 * @invariant only LINE, CIRCLE and TEXT entities; NOTES always carries the review reason and every unverified input
 */
export function buildFlatDxf(
  build: FlatBuild,
  docUnit: DocumentUnit,
  outUnit: DocumentUnit,
  options: { readonly bendLines: boolean; readonly bendNotes: boolean },
): FlatDxf {
  const { geometry, meta, part } = build;
  const factor = MM_PER_UNIT[docUnit] / MM_PER_UNIT[outUnit];
  const place = ([x, y]: Vec2): Vec2 => [(x - geometry.min[0]) * factor, (y - geometry.min[1]) * factor];
  const writer = new DxfWriter(LAYER_COLOR);
  const ring = (layer: string, points: readonly Vec2[]): void =>
    points.forEach((a, i) => writer.line(layer, place(a), place(points[(i + 1) % points.length] as Vec2)));
  ring(DXF_LAYERS.outline, geometry.outline);
  for (const cutout of geometry.cutouts)
    if (cutout.circle !== undefined) writer.circle(DXF_LAYERS.cutout, place(cutout.circle.center), cutout.circle.radius * factor);
    else ring(DXF_LAYERS.cutout, cutout.points);
  if (options.bendLines)
    for (const bend of geometry.bends)
      writer.line(bend.direction === 'up' ? DXF_LAYERS.bendUp : DXF_LAYERS.bendDown, place(bend.line[0]), place(bend.line[1]));
  const bounds = writer.bounds();
  const extents: [number, number] = [bounds[2] - bounds[0], bounds[3] - bounds[1]];
  const height = Math.max(0.03 * Math.max(extents[0], extents[1]), 1e-3);
  const notes = [
    `llull flat pattern ${part.id} (${outUnit})`,
    meta.reviewReason,
    ...meta.unverifiedInputs.map((input) => `UNVERIFIED ${input.kind} ${input.id}: ${input.source}`),
    ...(options.bendNotes
      ? geometry.bends.map(
          (bend) =>
            `BEND ${bend.id} ${bend.direction.toUpperCase()} ${fmt(toDegrees(Math.abs(bend.angle)))} deg R${fmt(bend.insideRadius * factor)} K${fmt(bend.k.value)} BA${fmt(bend.quantities.ba.value * factor)}`,
        )
      : []),
  ];
  notes.forEach((line, index) => writer.text(DXF_LAYERS.notes, [0, -(index + 1.5) * height * 1.6], height, line, 'left'));
  return { text: `${assemble(outUnit, writer, bounds)}\n`, entityCount: writer.entityCount, layers: [...writer.layers.keys()], extents };
}
