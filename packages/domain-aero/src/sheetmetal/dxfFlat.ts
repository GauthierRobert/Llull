/** R12 DXF of a flat pattern: LINE / CIRCLE / TEXT only, layers OUTLINE, CUTOUT, BEND_UP, BEND_DOWN and NOTES (FR-FTR-06, 37). */

import type { DocumentUnit, Vec2 } from '@core/model/types';
import { MM_PER_UNIT } from '@core/model/units';
import { toDegrees } from '@lib/angle';
import { DxfWriter, assembleDxf, fmt } from '@lib/dxfWriter';
import type { FlatBuild } from './flatData';
import { formingNote } from './formNotes';

export const DXF_LAYERS = { outline: 'OUTLINE', cutout: 'CUTOUT', bendUp: 'BEND_UP', bendDown: 'BEND_DOWN', notes: 'NOTES' } as const;

/** AutoCAD Color Index per flat-pattern layer. */
const LAYER_COLOR: Readonly<Record<string, number>> = { OUTLINE: 7, CUTOUT: 1, BEND_UP: 3, BEND_DOWN: 5, NOTES: 2 };

export interface FlatDxf {
  readonly text: string;
  readonly entityCount: number;
  readonly layers: string[];
  /** [x, y] extent of the geometry in the output unit. */
  readonly extents: readonly [number, number];
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
    ...geometry.forms.map((form) => formingNote(form, place, factor)),
    ...geometry.hems.map(
      (hem) =>
        `HEM ${hem.id} ${hem.hemType.toUpperCase()} GAP${fmt(hem.gap * factor)} LEG${fmt(hem.leg * factor)} DEVELOPED${fmt(hem.developedLength * factor)} (UNVERIFIED MODEL)`,
    ),
    ...(options.bendNotes
      ? geometry.bends.map(
          (bend) =>
            `BEND ${bend.id} ${bend.direction.toUpperCase()} ${fmt(toDegrees(Math.abs(bend.angle)))} deg R${fmt(bend.insideRadius * factor)} K${fmt(bend.k.value)} BA${fmt(bend.quantities.ba.value * factor)}`,
        )
      : []),
  ];
  notes.forEach((line, index) => writer.text(DXF_LAYERS.notes, [0, -(index + 1.5) * height * 1.6], height, line, 'left'));
  return { text: `${assembleDxf(outUnit, writer)}\n`, entityCount: writer.entityCount, layers: [...writer.layers.keys()], extents };
}
