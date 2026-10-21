import { type CadDocument, type Entity, type Layer, type Vec2 } from '@core/model/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, report } from '@core/commands/noop';
import { toDegrees } from '@lib/angle';
import { nextId } from '@lib/id';
import { buildFlat, type FlatBuild } from '../flatData';
import { formingNote } from '../formNotes';
import { FLANGED_HOLE_SOURCE, HEM_SOURCE } from '../provenance';
import { REVIEW_NOTE, fixed, unverifiedNote } from '../result';
import { isRefusal } from '../partLookup';

/** Outline vertices returned inline before `outlineTruncated` is set (AF-12). */
const MAX_OUTLINE_POINTS = 200;

const round = (value: number): number => Math.round(value * 1e9) / 1e9 + 0;

const hemOf = (geometry: FlatBuild['geometry'], bendId: string): string | null =>
  geometry.hems.find((hem) => hem.bend === bendId)?.id ?? null;

function flatPatternData(build: FlatBuild): Record<string, unknown> {
  const { part, geometry, meta } = build;
  return {
    partId: part.id,
    extents: geometry.extents.map(round),
    area: round(geometry.area),
    outline: geometry.outline.slice(0, MAX_OUTLINE_POINTS).map(([x, y]): Vec2 => [round(x), round(y)]),
    outlineTruncated: geometry.outline.length > MAX_OUTLINE_POINTS,
    cutoutCount: geometry.cutouts.length,
    bends: geometry.bends.map((bend) => ({
      id: bend.id,
      angleDeg: round(toDegrees(Math.abs(bend.angle))),
      insideRadius: bend.insideRadius,
      direction: bend.direction,
      ba: bend.quantities.ba.value,
      bd: hemOf(geometry, bend.id) !== null ? null : bend.quantities.bd.value,
      ossb: hemOf(geometry, bend.id) !== null ? null : bend.quantities.ossb.value,
      hem: hemOf(geometry, bend.id),
      kFactor: { value: bend.k.value, source: bend.k.source, defaulted: false, verification: bend.k.verification },
    })),
    hems: geometry.hems.map((hem) => ({
      id: hem.id,
      bend: hem.bend,
      hemType: hem.hemType,
      gap: hem.gap,
      returnLeg: hem.leg,
      bendAllowance: hem.bendAllowance,
      developedLength: { value: hem.developedLength, source: HEM_SOURCE, defaulted: false, verification: 'unverified' },
    })),
    formingNotes: geometry.forms.map((form) => ({
      id: form.id,
      kind: form.kind,
      excludedFromFlatPattern: form.kind === 'bead',
      approximate: form.kind === 'flanged_hole',
      ...(form.kind === 'flanged_hole'
        ? {
            flatCutDiameter: {
              value: round(2 * form.developedRadius),
              source: FLANGED_HOLE_SOURCE,
              defaulted: false,
              verification: 'unverified',
            },
            tangentDiameter: round(2 * form.physicalRadius),
          }
        : {}),
      note: formingNote(form, (point) => point, 1),
    })),
    joggles: geometry.joggles.map((joggle) => ({
      id: joggle.id,
      allowance: joggle.quantities.allowance.value,
      run: joggle.quantities.run.value,
      inclinedStraight: joggle.quantities.inclinedStraight.value,
    })),
    ...meta,
  };
}

/**
 * @affects none; data = FlatPatternData { partId, extents, area, outline, outlineTruncated, cutoutCount, bends[], joggles[] } + FtrResultMeta
 * @invariant at K = 0.5 area * thickness equals the folded volume; the part is never modified
 * @failure unknown part (FTR_PART_NOT_FOUND), missing rule, undevelopable part (FTR_NON_DEVELOPABLE) -> rejected with error.code
 */
export const flatPattern = defineCommand({
  name: 'flat_pattern',
  description:
    'DATA form of the flat pattern (same pattern as materialize_flat_pattern = 2D entities and export_flat_pattern_dxf = DXF file): compute the analytic flat pattern of a sheet-metal part (BA = theta*(R+K*T) added at every bend, unfolded from the base flat) without changing the document. ' +
    'Returns data { extents [x, y], area, outline (vertices, bounded), bends[] with angleDeg, insideRadius, direction up/down, ba, bd, ossb and the K-factor used with its source, joggles[] with allowance/run/inclinedStraight, hems[] (add_hem: gap, returnLeg, developedLength = pi*(gap/2+K*T)+leg, unverified model; a hem bend has ossb/bd null), formingNotes[] (beads are excluded from the pattern; a flanged hole is developed to an approximate, unverified cut diameter), ' +
    'provenance (formulas, inputs, sources), unverified + unverifiedInputs, reviewRequired }. Lengths are in the document length unit, angles in degrees. ' +
    'The result is computed by llull, not approved: a qualified person must review it. Refusal: FTR_PART_NOT_FOUND, FTR_NON_DEVELOPABLE. Next: export_flat_pattern_dxf, materialize_flat_pattern, check_sheet_metal.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({ id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).') }),
  run: (doc, { id }): CommandResult => {
    const built = buildFlat(doc, 'flat_pattern', id);
    if (isRefusal(built)) return built.refusal;
    const data = flatPatternData(built);
    const { geometry, meta } = built;
    return report(
      doc,
      `flat_pattern ${id}: ${fixed(geometry.extents[0])} x ${fixed(geometry.extents[1])} ${doc.units}, area ${fixed(geometry.area)}, ${geometry.bends.length} bend(s), ${geometry.joggles.length} joggle(s)${geometry.hems.length > 0 ? `, ${geometry.hems.length} hem(s)` : ''}${geometry.forms.length > 0 ? `, ${geometry.forms.length} forming note(s)` : ''}.${unverifiedNote(meta)} ${REVIEW_NOTE}`,
      data,
    );
  },
});

type Shape =
  | { readonly kind: 'polyline'; readonly points: readonly Vec2[]; readonly closed: boolean }
  | { readonly kind: 'circle'; readonly center: Vec2; readonly radius: number }
  | { readonly kind: 'line'; readonly start: Vec2; readonly end: Vec2 };

const LAYER_COLORS = { outline: '#1f77b4', cutout: '#d62728', up: '#2ca02c', down: '#ff7f0e' } as const;

function ensureLayer(layers: Record<string, Layer>, order: string[], name: string, color: string): string {
  const id = `layer-${name}`;
  if (layers[id] === undefined) {
    layers[id] = { id, name, visible: true, locked: false, color };
    order.push(id);
  }
  return id;
}

/**
 * @affects replaces the 2D flat-pattern snapshot of the part (tag flatpattern:<id>): 1 closed polyline outline, cutout circles/polylines, bend lines on FLAT-<id>-BEND-UP / -BEND-DOWN
 * @invariant the entities are plain drafting entities (a snapshot, editable and not re-derived); the part is not modified
 * @failure unknown part / undevelopable part -> rejected with error.code
 */
export const materializeFlatPattern = defineCommand({
  name: 'materialize_flat_pattern',
  description:
    'ENTITIES form of the flat pattern (same pattern as flat_pattern = data and export_flat_pattern_dxf = DXF file): draw the flat pattern of a sheet-metal part as plain 2D entities (outline polyline, cutouts, bend lines) on layers FLAT-<id>, FLAT-<id>-CUT, FLAT-<id>-BEND-UP and FLAT-<id>-BEND-DOWN, so it can be seen (render_view view=top) and drafted on. ' +
    'It is a snapshot: re-running replaces the previous snapshot of the same part. Lengths are in the document length unit. ' +
    'Refusal: FTR_PART_NOT_FOUND, FTR_NON_DEVELOPABLE. Use flat_pattern for the numbers and export_flat_pattern_dxf for the file.',
  params: z.object({
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    origin: vec2(
      'Optional plane position [x, y] in the document length unit where the lower-left corner of the pattern is placed. Default: beside the folded part, right of its bounding box.',
    ).optional(),
  }),
  run: (doc, { id, origin }): CommandResult => {
    const built = buildFlat(doc, 'materialize_flat_pattern', id);
    if (isRefusal(built)) return built.refusal;
    const { geometry } = built;
    const tag = `flatpattern:${id}`;
    const entities: Record<string, Entity> = Object.fromEntries(
      Object.entries(doc.entities).filter(([, entity]) => entity.tags?.includes(tag) !== true),
    );
    const order = doc.order.filter((entityId) => entities[entityId] !== undefined);
    const layers: Record<string, Layer> = { ...doc.layers };
    const layerOrder = [...doc.layerOrder];
    const folded = doc.entities[id];
    const foldedX = folded?.kind === 'mesh' ? folded.mesh.positions.filter((_, i) => i % 3 === 0) : [];
    const foldedY = folded?.kind === 'mesh' ? folded.mesh.positions.filter((_, i) => i % 3 === 1) : [];
    const gap = 0.1 * geometry.extents[0];
    const target: Vec2 = origin ?? [foldedX.length > 0 ? Math.max(...foldedX) + gap : 0, foldedY.length > 0 ? Math.min(...foldedY) : 0];
    const position = [target[0] - geometry.min[0], target[1] - geometry.min[1], 0] as const;
    const created: string[] = [];
    const add = (layerName: string, color: string, shape: Shape): void => {
      const entityId = nextId('fp');
      const layerId = ensureLayer(layers, layerOrder, layerName, color);
      entities[entityId] = { id: entityId, ...shape, position, rotation: [0, 0, 0], layerId, color, tags: ['flatpattern', tag] } as Entity;
      order.push(entityId);
      created.push(entityId);
    };
    add(`FLAT-${id}`, LAYER_COLORS.outline, { kind: 'polyline', points: geometry.outline, closed: true });
    for (const cutout of geometry.cutouts)
      add(
        `FLAT-${id}-CUT`,
        LAYER_COLORS.cutout,
        cutout.circle !== undefined
          ? { kind: 'circle', center: cutout.circle.center, radius: cutout.circle.radius }
          : { kind: 'polyline', points: cutout.points, closed: true },
      );
    for (const bend of geometry.bends)
      add(`FLAT-${id}-BEND-${bend.direction === 'up' ? 'UP' : 'DOWN'}`, LAYER_COLORS[bend.direction], {
        kind: 'line',
        start: bend.line[0],
        end: bend.line[1],
      });
    const next: CadDocument = {
      ...doc,
      entities,
      order,
      layers,
      layerOrder,
      selection: doc.selection.filter((entityId) => entities[entityId] !== undefined),
    };
    return changed(
      next,
      `materialize_flat_pattern ${id}: ${created.length} entities (outline, ${geometry.cutouts.length} cutout(s), ${geometry.bends.length} bend line(s)) at [${fixed(position[0])}, ${fixed(position[1])}] on layers FLAT-${id}*. ${REVIEW_NOTE}`,
      created,
    );
  },
});
