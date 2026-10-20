/** add_ply, edit_ply, delete_ply, reorder_plies: the ply list of a composite part (FR-CMP-07). */

import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { CompositePart, CompositesModel, Ply, PlyBoundary, Rosette } from '@core/model/composites';
import { dot3 } from '@lib/vec3';
import type { CadDocument, Vec2 } from '@core/model/types';
import { nextId } from '@lib/id';
import { polygonArea, selfIntersects, toCounterClockwise } from '@lib/polygon';
import { refuseCmp } from './codes';
import { syncOutlines } from './derive';
import { insideOrOn } from './geometry2d';
import { normalizeAngle } from './notation';
import { compact, compositesOf, findPart, findPly, findRosette, pliesOf, withComposites } from './state';

const boundaryParam = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('whole_face').describe('Discriminator: the whole tool face.') }).describe('The whole tool face.'),
    z
      .object({
        kind: z.literal('polygon').describe('Discriminator: explicit regions.'),
        polygons: z
          .array(z.array(vec2('A vertex [x, y] in the part frame (document units).')))
          .describe('One or more simple polygons in the part frame (developed face frame, document units); the ply covers their union.'),
      })
      .describe('Explicit regions in the part frame.'),
  ])
  .describe('Where the ply lies on the tool face: { kind: "whole_face" } or { kind: "polygon", polygons: [[[x, y], ...]] }.');

type BoundaryParam = z.output<typeof boundaryParam>;

/** The stored boundary, or the refusal reason when a polygon is degenerate, self-intersecting or leaves the part outline. */
function toBoundary(boundary: BoundaryParam, part: CompositePart): PlyBoundary | string {
  if (boundary.kind === 'whole_face') return { kind: 'whole_face' };
  if (boundary.polygons.length === 0) return 'polygon boundary needs at least one polygon';
  for (const [index, polygon] of boundary.polygons.entries()) {
    if (polygon.length < 3 || polygonArea(polygon) < 1e-9) return `polygon ${index} is degenerate`;
    if (selfIntersects(polygon)) return `polygon ${index} crosses itself`;
    if (polygon.some((vertex) => !insideOrOn(vertex, part.outline))) return `polygon ${index} leaves the part outline`;
  }
  return { kind: 'polygons', polygons: boundary.polygons.map((polygon): Vec2[] => toCounterClockwise(polygon)) };
}

/** `plies` renumbered 0..n-1 in their current stacking order (immutably). */
function renumbered(plies: Readonly<Record<string, Ply>>, ordered: readonly Ply[]): Record<string, Ply> {
  return { ...plies, ...Object.fromEntries(ordered.map((ply, order) => [ply.id, { ...ply, order }])) };
}

export interface PlySpec {
  readonly name: string;
  readonly materialName: string;
  readonly orientation: number;
  readonly sequence: string;
  readonly rosetteId: string;
  readonly boundary: PlyBoundary;
  readonly drape?: Ply['drape'];
  readonly zoneOrigin?: Ply['zoneOrigin'];
}

/** `model` with a new ply of `part` inserted at stacking index `at` (default top). The ply id is minted here (step-scoped). */
export function insertPly(model: CompositesModel, part: CompositePart, spec: PlySpec, at?: number): { model: CompositesModel; ply: Ply } {
  const existing = pliesOf(model, part.id);
  const index = at === undefined ? existing.length : Math.max(0, Math.min(at, existing.length));
  const ply = compact<Ply>({ id: nextId('ply'), partId: part.id, order: index, ...spec, orientation: normalizeAngle(spec.orientation) });
  const ordered = [...existing.slice(0, index), ply, ...existing.slice(index)];
  return { model: { ...model, plies: renumbered({ ...model.plies, [ply.id]: ply }, ordered), plyOrder: [...model.plyOrder, ply.id] }, ply };
}

const MAX_PLIES = 5000;

/**
 * The ply angle expressed from the part rosette: a ply rosette's 0-degree axis, projected on a plane tool face, is rotated against the part's.
 * 'unsupported' on curved faces (their 0 degrees is the axis / meridian), 'degenerate' when the axis is normal to the face.
 */
function orientationInPartFrame(
  part: CompositePart,
  rosette: Rosette,
  orientation: number,
): { orientation: number } | 'degenerate' | 'unsupported' {
  if (rosette.id === part.rosetteId) return { orientation };
  if (part.surface.type !== 'plane') return 'unsupported';
  const { xDir, yDir } = part.surface;
  const [x, y] = [dot3(rosette.axis0, xDir), dot3(rosette.axis0, yDir)];
  if (Math.hypot(x, y) < 1e-9) return 'degenerate';
  return { orientation: orientation + (Math.atan2(y, x) * 180) / Math.PI };
}

/**
 * @affects creates doc.composites.plies[ply-<step>.<k>] and its outline polylines (planar parts)
 * @invariant orientation stored in (-90, 90]; stacking order renumbered 0..n-1 from the tool side; ids deterministic per step
 * @failure unknown part / material / rosette -> CMP_REF_MISSING; degenerate polygon -> CMP_ZONE_BOUNDARY_INVALID; duplicate name in the part -> CMP_NAME_TAKEN
 */
export const addPly = defineCommand({
  name: 'add_ply',
  description:
    'Add one ply to a composite part: a lamina `material` laid at `orientation` degrees (counter-clockwise from the rosette 0-degree ' +
    'direction, about the tool-face normal; on cylinders / cones 0 degrees is along the axis / meridian) over a boundary on the tool ' +
    'face. By default it goes on top of the stack (stacking runs from the tool side); `order` (0 = tool side) inserts it elsewhere. ' +
    '`sequence` is the ply-book label (default "S<n>"). boundary { kind: "whole_face" } covers the whole face; { kind: "polygon", ' +
    'polygons } uses regions in the part frame. `drape.method` "developable" (default) or "projection" (no shear model yet). Planar ' +
    'parts get a derived outline polyline per piece. Prefer define_zone + generate_plies_from_zones for thickness-varying skins.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    name: z.string().min(1).describe('Ply name, unique in the part (e.g. "P1").'),
    material: z.string().describe('Lamina material name (create_lamina_material).'),
    orientation: z
      .number()
      .describe('Fibre angle in degrees from the rosette 0-degree direction (counter-clockwise); stored in (-90, 90].'),
    sequence: z.string().describe('Ply-book sequence label; default "S<n>" with n the 1-based stacking position.').optional(),
    order: z.number().describe('Stacking index to insert at, 0 = tool side (integer); default on top.').optional(),
    boundary: boundaryParam,
    rosette: z.string().describe('Rosette id or name; default the part rosette.').optional(),
    drape: z
      .object({ method: z.enum(['developable', 'projection']).describe('Flattening method; default "developable".') })
      .describe('Drape settings.')
      .optional(),
  }),
  run: (doc, { part: partRef, name, material, orientation, sequence, order, boundary, rosette, drape }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'add_ply', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    if (model.materials[material] === undefined)
      return refuseCmp(doc, 'add_ply', 'CMP_REF_MISSING', `no lamina material '${material}'`, [], ['params.material']);
    const ros = rosette === undefined ? findRosette(model, part.rosetteId) : findRosette(model, rosette);
    if (ros === null)
      return refuseCmp(doc, 'add_ply', 'CMP_REF_MISSING', `no rosette '${rosette ?? part.rosetteId}'`, [], ['params.rosette']);
    const frame = orientationInPartFrame(part, ros, orientation);
    if (typeof frame === 'string')
      return refuseCmp(
        doc,
        'add_ply',
        frame === 'degenerate' ? 'CMP_ROSETTE_DEGENERATE' : 'CMP_PARAM_INVALID',
        frame === 'degenerate'
          ? 'the ply rosette 0-degree axis is parallel to the tool face normal'
          : 'a ply rosette other than the part rosette is only supported on plane tool faces',
        [part.id],
        ['params.rosette'],
      );
    const stored = toBoundary(boundary, part);
    if (typeof stored === 'string') return refuseCmp(doc, 'add_ply', 'CMP_ZONE_BOUNDARY_INVALID', stored, [part.id], ['params.boundary']);
    const existing = pliesOf(model, part.id);
    if (existing.some((ply) => ply.name === name))
      return refuseCmp(doc, 'add_ply', 'CMP_NAME_TAKEN', `part "${part.name}" already has a ply "${name}"`, [], ['params.name']);
    if (existing.length >= MAX_PLIES)
      return refuseCmp(doc, 'add_ply', 'CMP_PARAM_INVALID', `a part holds at most ${MAX_PLIES} plies`, [part.id]);
    const at = order === undefined ? undefined : Math.floor(order);
    const { model: next, ply } = insertPly(
      model,
      part,
      {
        name,
        materialName: material,
        orientation: frame.orientation,
        sequence: sequence ?? `S${(at ?? existing.length) + 1}`,
        rosetteId: ros.id,
        boundary: stored,
        ...(drape === undefined ? {} : { drape }),
      },
      at,
    );
    return changed(
      syncOutlines(withComposites(doc, next)),
      `add_ply: added ply "${name}" (${ply.id}) to part "${part.name}" at stacking position ${next.plies[ply.id]?.order}: ${material} at ${ply.orientation} deg, ${stored.kind === 'whole_face' ? 'whole face' : `${stored.polygons.length} polygon(s)`}; ${existing.length + 1} plies now.`,
      [ply.id],
    );
  },
});

function finish(doc: CadDocument, model: CompositesModel, summary: string, ids: string[]): CommandResult {
  return changed(syncOutlines(withComposites(doc, model)), summary, ids);
}

/**
 * @affects replaces fields of doc.composites.plies[ply]; its outline polylines are regenerated
 * @invariant omitted fields keep their value; the stacking order is unchanged (use reorder_plies)
 * @failure unknown part / ply / material -> CMP_REF_MISSING; invalid boundary -> CMP_ZONE_BOUNDARY_INVALID; name in use -> CMP_NAME_TAKEN
 */
export const editPly = defineCommand({
  name: 'edit_ply',
  description:
    'Edit a ply of a composite part: its name, lamina material, orientation (degrees from the rosette 0-degree direction), sequence label ' +
    'or boundary (same forms as add_ply). Omitted fields are kept. The stacking position does not change; use reorder_plies.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    ply: z.string().describe('Ply id or name.'),
    name: z.string().min(1).describe('New ply name.').optional(),
    material: z.string().describe('New lamina material name.').optional(),
    orientation: z.number().describe('New fibre angle, degrees.').optional(),
    sequence: z.string().describe('New ply-book sequence label.').optional(),
    boundary: boundaryParam.optional(),
  }),
  run: (doc, { part: partRef, ply: plyRef, name, material, orientation, sequence, boundary }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'edit_ply', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const ply = findPly(model, part.id, plyRef);
    if (ply === null || ply.partId !== part.id)
      return refuseCmp(doc, 'edit_ply', 'CMP_REF_MISSING', `no ply '${plyRef}' in part "${part.name}"`, [], ['params.ply']);
    if (material !== undefined && model.materials[material] === undefined)
      return refuseCmp(doc, 'edit_ply', 'CMP_REF_MISSING', `no lamina material '${material}'`, [ply.id], ['params.material']);
    if (name !== undefined && pliesOf(model, part.id).some((other) => other.name === name && other.id !== ply.id))
      return refuseCmp(doc, 'edit_ply', 'CMP_NAME_TAKEN', `part "${part.name}" already has a ply "${name}"`, [ply.id], ['params.name']);
    const stored = boundary === undefined ? ply.boundary : toBoundary(boundary, part);
    if (typeof stored === 'string') return refuseCmp(doc, 'edit_ply', 'CMP_ZONE_BOUNDARY_INVALID', stored, [ply.id], ['params.boundary']);
    const next: Ply = {
      ...ply,
      name: name ?? ply.name,
      materialName: material ?? ply.materialName,
      orientation: orientation === undefined ? ply.orientation : normalizeAngle(orientation),
      sequence: sequence ?? ply.sequence,
      boundary: stored,
    };
    return finish(
      doc,
      { ...model, plies: { ...model.plies, [ply.id]: next } },
      `edit_ply: ply "${next.name}" (${ply.id}) is ${next.materialName} at ${next.orientation} deg, sequence ${next.sequence}.`,
      [ply.id],
    );
  },
});

/**
 * @affects removes doc.composites.plies[ply] and its outline polylines; the remaining plies are renumbered
 * @failure unknown part or ply -> CMP_REF_MISSING
 */
export const deletePly = defineCommand({
  name: 'delete_ply',
  description: 'Delete a ply of a composite part (and its derived outline); the remaining plies keep their relative stacking order.',
  annotations: { destructive: true },
  params: z.object({ part: z.string().describe('Part id or name.'), ply: z.string().describe('Ply id or name.') }),
  run: (doc, { part: partRef, ply: plyRef }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'delete_ply', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const ply = findPly(model, part.id, plyRef);
    if (ply === null || ply.partId !== part.id)
      return refuseCmp(doc, 'delete_ply', 'CMP_REF_MISSING', `no ply '${plyRef}' in part "${part.name}"`, [], ['params.ply']);
    const rest = pliesOf(model, part.id).filter((other) => other.id !== ply.id);
    const remaining = Object.fromEntries(Object.entries(model.plies).filter(([id]) => id !== ply.id));
    return finish(
      doc,
      { ...model, plies: renumbered(remaining, rest), plyOrder: model.plyOrder.filter((id) => id !== ply.id) },
      `delete_ply: removed ply "${ply.name}" (${ply.id}) from part "${part.name}"; ${rest.length} plies remain.`,
      [ply.id],
    );
  },
});

/**
 * @affects renumbers the stacking order of every ply of the part
 * @invariant `order` must list every ply of the part exactly once; ids stay
 * @failure unknown part / ply, missing or repeated plies -> CMP_REF_MISSING / CMP_PARAM_INVALID
 */
export const reorderPlies = defineCommand({
  name: 'reorder_plies',
  description:
    'Set the stacking order of a part: `order` lists every ply id or name from the tool side (first) to the top (last), each exactly once. ' +
    'Sequence labels are not renamed.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    order: z.array(z.string().describe('Ply id or name.')).describe('All plies of the part, tool side first.'),
  }),
  run: (doc, { part: partRef, order }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'reorder_plies', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const resolved = order.map((ref) => findPly(model, part.id, ref));
    const missing = order.filter((_, i) => resolved[i] === null || resolved[i]?.partId !== part.id);
    if (missing.length > 0)
      return refuseCmp(doc, 'reorder_plies', 'CMP_REF_MISSING', `unknown ply(ies) ${missing.join(', ')}`, [], ['params.order']);
    const ordered = resolved as Ply[];
    const ids = new Set(ordered.map((ply) => ply.id));
    const count = pliesOf(model, part.id).length;
    if (ids.size !== ordered.length || ids.size !== count)
      return refuseCmp(
        doc,
        'reorder_plies',
        'CMP_PARAM_INVALID',
        `order must list each of the ${count} plies exactly once (got ${ordered.length}, ${ids.size} distinct)`,
        [part.id],
        ['params.order'],
      );
    return finish(
      doc,
      { ...model, plies: renumbered(model.plies, ordered) },
      `reorder_plies: part "${part.name}" restacked, tool side ${ordered[0]?.name}, top ${ordered[ordered.length - 1]?.name} (${count} plies).`,
      ordered.map((ply) => ply.id),
    );
  },
});
