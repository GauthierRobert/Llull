/**
 * add_pocket (07 FTR M2): a pocket with a rounded-corner outline, optional islands and floor fillet cut into one planar face of a solid. The result
 * is a `mesh` whose `brep` is a `feature(pocket)` node over the target's recipe.
 */

import { type CadDocument, type Entity, type ShapeRecipe, type Vec2, is3D } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import type { FtrCode } from '../../model/manufacturing';
import type { CommandResult } from '../types';
import { defineCommand, vec2, vec3, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import { operandRecipe } from '../../geometry/operandRecipe';
import { noop } from '../noop';
import { frameToWorld } from '../../geometry/featureFrame';
import { throughReach } from '../../geometry/featureLowering';
import { roundedOutline } from '../../geometry/pocketOutline';
import { isValidPolygon, pointInPolygon, polygonCentroid, segmentsIntersect, selfIntersects } from '../../lib/polygon';
import { type ResolvedFace, resolveFace } from './faceResolve';
import { expectedShape, localPoints } from './facePoints';
import { refuse } from './ftr';
import { depthToFace } from './holeExtents';

const outlineParams = z
  .object({
    kind: z.enum(['rectangle', 'polygon']).describe('"rectangle" (center + size, axis-aligned in the face frame) or "polygon" (points).'),
    center: vec2('Rectangle only: centre [u, v] in the pointsFrame, in document length units.').optional(),
    size: vec2('Rectangle only: [width along u, length along v], in document length units.').optional(),
    points: z
      .array(z.array(z.number()))
      .optional()
      .describe(
        'Polygon only: at least 3 vertices [u, v] (pointsFrame), in document length units; implicitly closed, simple (no self-crossing).',
      ),
  })
  .describe('Closed pocket outline on the face plane, before corner rounding.');

type OutlineParams = z.output<typeof outlineParams>;

/** Raw outline vertices (`[u, v]` per the pointsFrame) of the params, or null when malformed. */
function rawVertices(outline: OutlineParams): ReadonlyArray<readonly number[]> | null {
  if (outline.kind === 'polygon') return outline.points ?? null;
  const { center, size } = outline;
  if (center === undefined || size === undefined || !(size[0] > 0) || !(size[1] > 0)) return null;
  const [hu, hv] = [size[0] / 2, size[1] / 2];
  return [
    [center[0] - hu, center[1] - hv],
    [center[0] + hu, center[1] - hv],
    [center[0] + hu, center[1] + hv],
    [center[0] - hu, center[1] + hv],
  ];
}

const edgesOf = (polygon: readonly Vec2[]): Array<readonly [Vec2, Vec2]> =>
  polygon.map((point, i): readonly [Vec2, Vec2] => [point, polygon[(i + 1) % polygon.length] as Vec2]);

const crossing = (a: readonly Vec2[], b: readonly Vec2[]): boolean =>
  edgesOf(a).some(([a1, a2]) => edgesOf(b).some(([b1, b2]) => segmentsIntersect(a1, a2, b1, b2)));

/** Why `island` cannot stand inside `outline` alongside the earlier `islands`, or null. */
function islandProblem(island: readonly Vec2[], outline: readonly Vec2[], earlier: ReadonlyArray<readonly Vec2[]>): string | null {
  if (!isValidPolygon(island) || selfIntersects(island)) return 'is not a simple closed polygon';
  if (crossing(island, outline) || !island.every((point) => pointInPolygon(point, outline))) return 'is not inside the outline';
  const clash = earlier.findIndex(
    (other) =>
      crossing(island, other) ||
      island.some((point) => pointInPolygon(point, other)) ||
      other.some((point) => pointInPolygon(point, island)),
  );
  return clash === -1 ? null : `overlaps island ${clash}`;
}

/**
 * @affects replaces `target` by 1 mesh entity (the part with the pocket cut, `brep` = feature(pocket) over the target's recipe)
 * @invariant corners rounded with exact arcs; floorFillet <= cornerRadius; the pocket stays inside the picked face unless open=true; islands stay inside the
 *   outline and keep their material; needs an exact kernel for a floor fillet
 * @failure missing / non-solid target, no kernel, face not found / not planar, open / self-crossing / too-small outline, outline outside the face (open=false),
 *   bad island, floorFillet > cornerRadius, depth beyond the stock, bad up-to face, kernel refusal -> rejected no-op with an FTR_* code
 */
export const addPocket = defineCommand({
  name: 'add_pocket',
  annotations: { requiresKernel: true },
  description:
    'Cut a pocket into a planar face of a 3D solid: a closed outline (rectangle or polygon) whose vertical corners are rounded by ' +
    'cornerRadius (exact arcs) and whose floor edges may carry a floorFillet (exact kernel only). Give exactly one of depth, through=true (cut ' +
    'through the part) or upToFace (stop at the plane of a parallel planar face below). islands are closed polygons inside the outline that ' +
    'stay as material posts (their corners are rounded by cornerRadius too). The pocket must stay inside the picked face unless open=true (it ' +
    'may then run out over a side of the part, e.g. a step). The face is picked by a world point (face.near); coordinates are [u, v] in the face frame (origin = the world origin ' +
    'projected on the face plane, u = world X (or Y) projected on it, v = normal x u) or, with pointsFrame "world_xy", world [x, y]. All ' +
    'lengths are in the document length unit. cornerRadius must be >= floorFillet and >= toolDiameter / 2 for machinable corners ' +
    '(check_machining reports it). Consumes target, creates one mesh entity. Refusals carry error.code: FTR_FACE_NOT_FOUND, ' +
    'FTR_FACE_NOT_PLANAR, FTR_PROFILE_NOT_CLOSED, FTR_POCKET_CORNER_TOO_LARGE, FTR_POCKET_FILLET_GT_CORNER, FTR_POCKET_DEPTH_EXCEEDS_STOCK, ' +
    'FTR_HOLE_POINT_OUTSIDE_FACE (outline leaves the face without open=true), FTR_POCKET_ISLAND_INVALID, FTR_UP_TO_TARGET_INVALID, ' +
    'FTR_NEEDS_EXACT_KERNEL (floor fillet), FTR_FEATURE_BUILD_FAILED. Next: ' +
    'check_machining, recognize_features.',
  params: z.object({
    target: z.string().describe('Id of the 3D solid to cut (a primitive or a kernel result).'),
    face: z
      .object({ near: vec3('World point [x, y, z] on the planar face, in document length units.') })
      .describe('The planar face to cut into, picked by a world point.'),
    outline: outlineParams,
    islands: z
      .array(z.array(z.array(z.number())))
      .optional()
      .describe(
        'Optional material posts left standing inside the pocket: each a closed polygon of >= 3 [u, v] vertices (same pointsFrame as the outline), ' +
          'simple, fully inside the outline and not overlapping another island, in document length units.',
      ),
    pointsFrame: z
      .enum(['face', 'world_xy'])
      .optional()
      .describe('Coordinates of the outline and islands: "face" (default) or "world_xy".'),
    depth: z
      .number()
      .optional()
      .describe('Pocket depth below the face, in document length units; must be inside the stock. Omit with through=true or upToFace.'),
    upToFace: z
      .object({ near: vec3('World point [x, y, z] on the planar target face, in document length units.') })
      .optional()
      .describe(
        'Stop the floor at the plane of this planar face, which must be parallel to the picked face and below it. Omit depth / through.',
      ),
    open: z
      .boolean()
      .optional()
      .describe(
        'true = the outline may leave the picked face (the pocket runs out over a side of the part); it must still overlap the face. Default false.',
      ),
    through: z.boolean().optional().describe('true = cut through the whole part along the face normal (no depth, no floorFillet).'),
    cornerRadius: z
      .number()
      .min(0)
      .describe('Radius of every vertical outline corner (convex and concave), in document length units; 0 = sharp. Give it explicitly.'),
    floorFillet: z
      .number()
      .min(0)
      .describe(
        'Radius of the fillet between floor and walls, in document length units; 0 = sharp floor; must be <= cornerRadius. Needs an exact kernel.',
      ),
    toolDiameter: z
      .number()
      .positive()
      .optional()
      .describe('Planned cutter diameter, in document length units; recorded for check_machining.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { target, face, outline, islands, pointsFrame = 'face', depth, through = false, upToFace, open = false } = params;
    const { cornerRadius, floorFillet, toolDiameter } = params;
    const fail = (code: FtrCode, why: string, remediation: string, ...paths: string[]): CommandResult =>
      refuse(doc, 'add_pocket', code, why, remediation, [target], paths);
    const entity = doc.entities[target];
    if (!entity) return fail('FTR_FACE_NOT_FOUND', `entity '${target}' not found`, 'pass an existing 3D solid id', 'target');
    if (!is3D(entity) || entity.kind === 'instance')
      return noop(doc, `add_pocket: entity '${target}' (kind '${entity.kind}') is not a 3D solid; explode instances first.`);
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('add_pocket'));
    if (floorFillet > cornerRadius)
      return fail(
        'FTR_POCKET_FILLET_GT_CORNER',
        `floorFillet ${floorFillet} exceeds cornerRadius ${cornerRadius}`,
        'floor fillet must be <= corner radius',
        'floorFillet',
        'cornerRadius',
      );
    const extents = [depth !== undefined, through, upToFace !== undefined].filter(Boolean).length;
    if (extents !== 1 || (depth !== undefined && !(depth > 0)) || (through && floorFillet > 0))
      return fail(
        'FTR_POCKET_DEPTH_EXCEEDS_STOCK',
        through && floorFillet > 0 ? 'through=true takes no floorFillet' : 'give exactly one of depth (> 0), through=true or upToFace',
        "reduce depth, or use 'through' / 'upToFace'",
        'depth',
        'through',
        'upToFace',
      );
    if (floorFillet > 0 && !kernel.supports('fillet'))
      return fail(
        'FTR_NEEDS_EXACT_KERNEL',
        'a floor fillet needs an exact kernel',
        'rerun with --kernel occt-native, or use floorFillet 0',
        'floorFillet',
      );
    const vertices = rawVertices(outline);
    const source = operandRecipe(kernel, entity);
    const resolved = resolveFace(kernel, source, face.near);
    if (resolved === 'not_found' || resolved === 'not_planar')
      return fail(
        resolved === 'not_found' ? 'FTR_FACE_NOT_FOUND' : 'FTR_FACE_NOT_PLANAR',
        resolved === 'not_found' ? `no face within reach of face.near ${JSON.stringify(face.near)}` : 'the picked face is not planar',
        'pick a point on a planar face (inspect_topology lists faces)',
        'face.near',
      );
    const placed = vertices === null ? null : localPoints(resolved.frame, vertices, pointsFrame);
    if (placed === null || placed.bad.length > 0 || !isValidPolygon(placed.local) || selfIntersects(placed.local))
      return fail(
        'FTR_PROFILE_NOT_CLOSED',
        `the outline is not a simple closed polygon of ${expectedShape[pointsFrame]} vertices`,
        'pass a closed, simple 2D profile',
        'outline',
      );
    const posts = (islands ?? []).map((island) => localPoints(resolved.frame, island, pointsFrame));
    const badIsland = posts.findIndex(
      (post, index) =>
        post.bad.length > 0 ||
        islandProblem(
          post.local,
          placed.local,
          posts.slice(0, index).map((earlier) => earlier.local),
        ) !== null,
    );
    if (badIsland !== -1) {
      const post = posts[badIsland] as { local: Vec2[]; bad: number[] };
      const why =
        post.bad.length > 0
          ? `has points that are not ${expectedShape[pointsFrame]}`
          : islandProblem(
              post.local,
              placed.local,
              posts.slice(0, badIsland).map((earlier) => earlier.local),
            );
      return fail(
        'FTR_POCKET_ISLAND_INVALID',
        `island ${badIsland} ${why}`,
        'islands are simple closed polygons inside the outline',
        `islands.${badIsland}`,
      );
    }
    let floorDepth = depth;
    if (upToFace !== undefined) {
      const reach = depthToFace(kernel, source, resolved.frame, upToFace.near, 'upToFace.near');
      if (typeof reach !== 'number') return fail('FTR_UP_TO_TARGET_INVALID', reach.why, reach.remediation, ...reach.paths);
      floorDepth = reach;
    }
    const plan = { entity, source, resolved, polygon: placed.local, islands: posts.map((post) => post.local), depth: floorDepth, open };
    return cut(doc, { ...plan, cornerRadius, floorFillet, toolDiameter }, kernel, fail);
  },
});

interface PocketPlan {
  readonly entity: Entity;
  readonly source: ShapeRecipe;
  readonly resolved: ResolvedFace;
  readonly polygon: readonly Vec2[];
  readonly islands: ReadonlyArray<readonly Vec2[]>;
  readonly open: boolean;
  readonly depth: number | undefined;
  readonly cornerRadius: number;
  readonly floorFillet: number;
  readonly toolDiameter: number | undefined;
}

function cut(
  doc: CadDocument,
  plan: PocketPlan,
  kernel: GeometryKernel,
  fail: (code: FtrCode, why: string, remediation: string, ...paths: string[]) => CommandResult,
): CommandResult {
  const { entity, source, resolved, polygon, islands, open, depth, cornerRadius, floorFillet, toolDiameter } = plan;
  const outline = roundedOutline(polygon, cornerRadius);
  if (typeof outline === 'string')
    return fail('FTR_POCKET_CORNER_TOO_LARGE', outline, 'reduce cornerRadius so the arcs fit the outline edges', 'cornerRadius');
  const tooBig = islands.map((island) => roundedOutline(island, cornerRadius)).find((rounded) => typeof rounded === 'string');
  if (typeof tooBig === 'string')
    return fail('FTR_POCKET_CORNER_TOO_LARGE', `island: ${tooBig}`, 'reduce cornerRadius so the arcs fit the island edges', 'cornerRadius');
  const onFace = (point: Vec2): boolean => resolved.contains(frameToWorld(resolved.frame, point));
  if (!open && outline.profile.some((point) => !onFace(point)))
    return fail(
      'FTR_HOLE_POINT_OUTSIDE_FACE',
      'the outline leaves the picked face',
      'keep the pocket inside the face outline, or set open=true for a pocket that runs out over a side',
      'outline',
    );
  if (open && ![...outline.profile, polygonCentroid(polygon)].some(onFace))
    return fail(
      'FTR_HOLE_POINT_OUTSIDE_FACE',
      'an open pocket must still overlap the picked face',
      'move the outline onto the face',
      'outline',
    );
  const shape = kernel.evaluate(source);
  const mesh = shape === null ? null : kernel.tessellate(shape);
  if (depth !== undefined && mesh !== null && depth >= throughReach(mesh, resolved.frame))
    return fail(
      'FTR_POCKET_DEPTH_EXCEEDS_STOCK',
      `depth ${depth} reaches or exceeds the stock below the face`,
      "reduce depth or use 'through'",
      'depth',
    );
  const recipe: ShapeRecipe = {
    op: 'feature',
    source,
    feature: 'pocket',
    frame: resolved.frame,
    pocket: {
      outline: polygon,
      ...(islands.length === 0 ? {} : { islands }),
      depth: depth ?? 'through',
      cornerRadius,
      floorFillet,
      ...(toolDiameter === undefined ? {} : { toolDiameter }),
    },
  };
  const result = evaluateRecipe(kernel, recipe);
  if (result === 'refused' || result === 'empty')
    return fail(
      'FTR_FEATURE_BUILD_FAILED',
      `the kernel could not cut the pocket (${result})`,
      'check the solid, the corner radius and the floor fillet',
    );
  const size = depth === undefined ? 'through' : `depth ${depth}`;
  return commitKernelResult(
    doc,
    kernel,
    result,
    [entity],
    (newId, triangles) =>
      `add_pocket: cut a ${polygon.length}-vertex pocket (${size}, cornerRadius ${cornerRadius}, floorFillet ${floorFillet}) into '${entity.id}'; ` +
      `result mesh '${newId}' (${triangles} triangles). Target consumed.`,
  );
}
