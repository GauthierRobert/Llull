import type { CadDocument, Entity, RegionEntity, Vec2 } from '../../model/types';
import { type RegionHatchPattern, REGION_HATCH_PATTERNS } from '../../model/regionHatch';
import type { CommandResult } from '../types';
import { defineCommand, z, looseVec2, nameField, layerIdField, colorField } from '../schema';
import { codedRejection } from '../noop';
import { nextId } from '../../lib/id';
import { pointsDiagonal } from '../../lib/extent';
import { niceStep } from '../../lib/niceStep';
import { ORIGIN } from '../../lib/vec3';
import { regionLoopsIssue, regionNetArea } from '../../geometry/region';
import { newEntity } from '../entity/newEntity';
import { withEntities } from '../entity/entityOps';
import { MAX_REGION_LOOPS, MAX_REGION_POINTS } from '../limits';
import { existingLayerOrDefault } from '../solids/shared';
import { placementOf } from './sketchPlanes';
import { DEFAULT_DRAW_COLOR } from './shared';
import { type FrameLoop, type WorkPlane, boundaryLoops, groupByOutermost, isCurved, isRefusal, loopsAtPoint } from './regionLoops';

const COMMAND = 'hatch_region';

/** Default pattern line angle: 45° (ANSI31). */
const DEFAULT_ANGLE = Math.PI / 4;

/** Pattern spacing when none is given: a 1-2-5 step near 1/40 of the region diagonal. */
const DEFAULT_SPACING_DIVISOR = 40;

const LOOP_ISSUES = {
  REGION_DEGENERATE_LOOP: [
    'a boundary loop has no area',
    'Remove the zero-area shape (collapsed polyline, collinear points) from the boundary.',
  ],
  REGION_SELF_INTERSECTING: [
    'a boundary loop crosses or touches itself (self-crossing, a vertex on another edge, a spike that doubles back)',
    'Redraw it as a simple outline (a figure-eight is two loops: split it into two closed shapes; remove the spike).',
  ],
  REGION_LOOPS_TOUCH: [
    'two boundary loops touch (shared vertex, T-contact, collinear overlap, tangency or coincident outlines)',
    'Separate the shapes by a visible gap or nest them clearly (a hole must not touch the outer edge, a circle must not be tangent to an edge).',
  ],
  REGION_LOOPS_CROSS: [
    'two boundary loops cross each other',
    'Trim the shapes so loops are nested or disjoint (crossing circles / rectangles have no single even-odd boundary).',
  ],
} as const;

function planeOf(doc: CadDocument, plane: string | undefined): WorkPlane | string {
  if (plane === undefined) return { origin: ORIGIN, rotation: [0, 0, 0] };
  const sketchPlane = doc.sketchPlanes?.[plane];
  if (sketchPlane === undefined) return `no sketch plane '${plane}'`;
  const { position, rotation } = placementOf(sketchPlane.frame);
  return { origin: position, rotation };
}

/**
 * @affects creates 1 region entity per outermost boundary (loops nested inside it become holes / islands, even-odd); sources are kept
 * @invariant exactly one of ids (closed shapes, or open pieces that join into one loop) or point (pick point inside closed shapes on a plane);
 *   loops neither cross, touch nor self-intersect; all shapes share one work plane; the region keeps exact curves (circle area is exactly πr²)
 * @invariant region sits at the first shape's position / rotation (ids) or at the plane origin (point); ids are step-scoped
 * @failure empty / missing input -> REGION_EMPTY_SELECTION; unknown id -> REGION_ENTITY_NOT_FOUND; text / solids -> REGION_UNSUPPORTED_KIND;
 *   open boundary -> REGION_OPEN_BOUNDARY; other plane -> REGION_PLANE_MISMATCH; self-crossing -> REGION_SELF_INTERSECTING; crossing loops ->
 *   REGION_LOOPS_CROSS; pick point outside every shape -> REGION_POINT_NOT_ENCLOSED; touching loops -> REGION_LOOPS_TOUCH; pick point on an outline -> REGION_POINT_ON_BOUNDARY; too large -> REGION_TOO_LARGE; ids with point, spacing <= 0 -> REGION_BAD_PARAM -> no-op, affected:[]
 */
export const hatchRegion = defineCommand({
  name: 'hatch_region',
  description:
    'Create a hatched planar region (entity kind "region") from closed 2D shapes: the AutoCAD HATCH / BHATCH of llull. ' +
    'Give EXACTLY ONE of: `ids` = closed shapes (circle, rectangle, ellipse, closed polyline, closed spline; lines / arcs / open polylines ' +
    'are accepted when together they join end to end into one more closed loop), all on the same work plane; the outermost loop is the ' +
    'boundary and every loop nested inside it is a hole, a loop inside a hole is an island (even-odd nesting); several disjoint outermost ' +
    'loops give one region each. OR `point` = [x, y] pick point on a plane (`plane` = sketch plane id, default the world XY plane at z=0, point ' +
    'in that plane coordinates): the smallest closed shape on that plane around the point is the boundary and the shapes directly inside it ' +
    'its holes (pick-point detection works over closed shapes, not over a network of loose lines; shapes crossing the chosen boundary are refused). ' +
    'The region keeps exact curves, is placed at the first shape (ids) or the plane origin (point), and the source shapes stay. ' +
    '`pattern`: lines (parallel lines at `angle`, 45° = ANSI31 steel / default), cross (lines at `angle` and `angle`+90°), solid (filled), ' +
    'none (outline only). `angle` is in radians (45° = 0.7854), `spacing` the distance between pattern lines in document units (default ' +
    'about 1/40 of the region diagonal, rounded to 1-2-5). Net area (outer minus holes) = measure_area on the region; extrude_profile ' +
    'extrudes a region without holes. Refusals carry a code: REGION_EMPTY_SELECTION, REGION_ENTITY_NOT_FOUND, REGION_UNSUPPORTED_KIND, ' +
    'REGION_OPEN_BOUNDARY, REGION_PLANE_MISMATCH, REGION_SELF_INTERSECTING, REGION_LOOPS_CROSS, REGION_POINT_NOT_ENCLOSED, REGION_POINT_ON_BOUNDARY, REGION_LOOPS_TOUCH, REGION_TOO_LARGE, REGION_BAD_PARAM. ' +
    'The region copies the boundary geometry when created: it is NOT associative, editing or moving a source shape afterwards does not update the region (run hatch_region again).',
  params: z.object({
    ids: z
      .array(z.string())
      .describe(
        'Ids of the boundary shapes: closed shapes and/or open pieces that join into one loop; nested ones become holes. Excludes point.',
      )
      .optional(),
    point: looseVec2(
      'Pick point [x, y] in plane coordinates (see plane); hatches the smallest closed shape around it. Excludes ids.',
    ).optional(),
    plane: z
      .string()
      .describe(
        'Only with point: sketch plane id (create_sketch_plane) whose closed shapes are searched. Default the world XY plane at z=0.',
      )
      .optional(),
    pattern: z
      .enum(['none', ...REGION_HATCH_PATTERNS])
      .describe('Hatch pattern: lines (default, 45° = ANSI31), cross, solid, or none (outline only).')
      .optional(),
    angle: z.number().describe('Pattern line angle in radians, counter-clockwise from the plane +X. Default 0.7854 (45°).').optional(),
    spacing: z
      .number()
      .describe('Distance between pattern lines, document units, > 0. Default about 1/40 of the region diagonal (1-2-5 step).')
      .optional(),
    color: colorField(DEFAULT_DRAW_COLOR),
    layerId: layerIdField(),
    name: nameField(),
  }),
  run: (
    doc,
    { ids, point, plane, pattern = 'lines', angle = DEFAULT_ANGLE, spacing, color = DEFAULT_DRAW_COLOR, layerId, name },
  ): CommandResult => {
    const refuse = (code: string, message: string, remediation: string, refIds: readonly string[] = []): CommandResult =>
      codedRejection(doc, COMMAND, code, message, remediation, refIds);
    if (ids !== undefined && point !== undefined)
      return refuse('REGION_BAD_PARAM', 'pass ids or point, not both', 'Give either ids or point.');
    if ((ids ?? []).length === 0 && point === undefined)
      return refuse('REGION_EMPTY_SELECTION', 'no boundary given', 'Pass ids (closed shapes) or point (pick point inside closed shapes).');
    if (spacing !== undefined && !(spacing > 0))
      return refuse('REGION_BAD_PARAM', `spacing must be > 0 (got ${String(spacing)})`, 'Give a positive spacing or omit it.');
    if (!Number.isFinite(angle)) return refuse('REGION_BAD_PARAM', 'angle must be finite', 'Give the angle in radians or omit it.');
    if ((ids?.length ?? 0) > MAX_REGION_LOOPS)
      return refuse('REGION_TOO_LARGE', `${ids?.length} ids exceed ${MAX_REGION_LOOPS}`, 'Hatch fewer shapes per call.');

    let all: FrameLoop[];
    let frame: WorkPlane;
    if (ids !== undefined) {
      const first = doc.entities[ids[0] as string];
      if (first === undefined)
        return refuse('REGION_ENTITY_NOT_FOUND', `no entity "${ids[0]}"`, 'Pass the ids of existing closed 2D shapes.', [ids[0] as string]);
      frame = { origin: first.position, rotation: first.rotation };
      const loops = boundaryLoops(doc, [...new Set(ids)], frame);
      if (isRefusal(loops)) return refuse(loops.code, loops.message, loops.remediation, loops.ids);
      all = loops;
    } else {
      const found = planeOf(doc, plane);
      if (typeof found === 'string')
        return refuse('REGION_ENTITY_NOT_FOUND', found, 'Create it first (create_sketch_plane) or omit plane.');
      frame = found;
      const loops = loopsAtPoint(doc, frame, point as Vec2);
      if (isRefusal(loops)) return refuse(loops.code, loops.message, loops.remediation, loops.ids);
      all = loops;
    }

    const pointCount = all.reduce((sum, loop) => sum + loop.profile.length, 0);
    if (pointCount > MAX_REGION_POINTS)
      return refuse(
        'REGION_TOO_LARGE',
        `the boundaries tessellate to ${pointCount} points (limit ${MAX_REGION_POINTS})`,
        'Hatch fewer or simpler shapes.',
      );
    const issue = regionLoopsIssue(
      all.map((loop) => loop.profile),
      all.map(isCurved),
    );
    if (issue !== null) {
      const [message, remediation] = LOOP_ISSUES[issue.code];
      return refuse(issue.code, message, remediation, (all[issue.index] as FrameLoop).ids);
    }
    const groups = groupByOutermost(all);
    if (groups.length === 0)
      return refuse(
        'REGION_LOOPS_TOUCH',
        'no outermost boundary found among the shapes',
        'Pass at least one closed shape that is not inside another.',
      );

    const layer = existingLayerOrDefault(doc, layerId);
    const regions = groups.map((group) => {
      const loops = group.map((loop) => loop.profile);
      const hatch =
        pattern === 'none' ? {} : { hatch: { pattern: pattern as RegionHatchPattern, angle, spacing: spacing ?? defaultSpacing(loops) } };
      return newEntity('region', nextId('region'), { loops, curves: group.map((loop) => loop.curves), ...hatch }, frame.origin, color, {
        rotation: frame.rotation,
        layerId: layer,
        name,
      }) as RegionEntity;
    });
    const parts = regions.map((region) => describe(region, doc.displayPrecision, `${doc.units}²`));
    return {
      document: withEntities(doc, regions as Entity[]),
      summary: `hatch_region: created ${regions.length} region(s) — ${parts.join('; ')}`,
      affected: regions.map((region) => region.id),
    };
  },
});

const defaultSpacing = (loops: ReadonlyArray<ReadonlyArray<Vec2>>): number =>
  niceStep(pointsDiagonal(loops.flat()) / DEFAULT_SPACING_DIVISOR);

function describe(region: RegionEntity, precision: number, areaUnit: string): string {
  const { hatch } = region;
  const fill =
    hatch === undefined
      ? 'no hatch'
      : hatch.pattern === 'solid'
        ? 'solid fill'
        : `${hatch.pattern} hatch at ${((hatch.angle * 180) / Math.PI).toFixed(1)}°, spacing ${hatch.spacing}`;
  const holes = region.loops.length - 1;
  return `"${region.id}" net area ${regionNetArea(region).toFixed(precision)} ${areaUnit}, ${region.loops.length} loop(s) (${holes} inside the outer), ${fill}`;
}
