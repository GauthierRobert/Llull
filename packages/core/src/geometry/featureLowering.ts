/**
 * Lowering of a `feature` recipe node (07 FTR §5.3 / §5.5) to plain booleans: `source` minus ONE compound tool. A hole tool is a revolved
 * half-section (bore, counterbore step, countersink cone, drill point) per position; a pocket tool is the exact rounded outline extruded.
 * A modelled thread adds one helical groove sweep per position to the hole tool (./threadTool). Tools reach `epsilon` above the face so no cut face is coplanar with it. Every kernel therefore accepts the node. A rib tool is the thickened
 * path extruded from the face plane and FUSED to the source.
 * @invariant through-all depth = the source's extent below the face plane (`throughReach`) + 2 epsilon; up_to_next = its resolved depth + 2
 *   epsilon (it leaves the material); up_to_face = exactly its resolved depth (+ 2 epsilon when the target face is where the material ends: no zero-thickness skin)
 * @failure inconsistent spec (cone deeper than the hole, bad outline or island, bad rib path) -> null
 */

import { type Entity, type MeshData, type ShapeRecipe, type Vec3, DEFAULT_LAYER_ID } from '../model/types';
import type { FeatureFrame, HoleExtent, HoleSpec, PocketSpec, RibSpec } from '../model/features';
import { countersinkDepth, drillTipHeight } from '../lib/holeMath';
import { frameEuler, frameToWorld, heightAbove } from './featureFrame';
import { type PocketOutline, roundedOutline } from './pocketOutline';
import { thickenedPath } from './featureRib';
import { threadGroove } from './threadTool';

export type FeatureRecipe = Extract<ShapeRecipe, { op: 'feature' }>;

const TOOL_COLOR = '#808080';
/** Radial subdivisions of a revolved hole tool on mesh kernels (OCC builds exact cones and cylinders). */
const TOOL_SEGMENTS = 64;

/** Overshoot of a tool above the face, in document units. */
const epsilonOf = (size: number): number => Math.max(1e-3 * size, 1e-6);

/** How far the material of `mesh` reaches below the face plane of `frame` (0 when it lies entirely above). */
export function throughReach(mesh: MeshData, frame: FeatureFrame): number {
  let reach = 0;
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    const point: Vec3 = [mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0];
    reach = Math.max(reach, -heightAbove(frame, point));
  }
  return reach;
}

/**
 * Half-section [radius, height above the face] of one hole tool; the tool axis is the local z axis. A modelled thread overshoots the face by two
 * pitches so the groove ends lie inside the bore tool (a bore end plane cutting the groove makes the OCC union drop an operand).
 */
export function holeToolProfile(hole: HoleSpec, extent: HoleExtent, reach: number): Array<[number, number]> | null {
  const radius = hole.diameter / 2;
  const clearance = hole.thread?.modelled === true ? 2 * (hole.thread.pitch ?? 0) : 0;
  const eps = Math.max(epsilonOf(Math.max(hole.diameter, hole.cskDiameter ?? 0, hole.cboreDiameter ?? 0)), clearance);
  const top: Array<[number, number]> = [[0, eps]];
  let stepDepth = 0;
  if (hole.kind === 'countersink') {
    if (hole.cskDiameter === undefined || hole.cskAngle === undefined) return null;
    const cone = countersinkDepth(hole.diameter, hole.cskDiameter, hole.cskAngle).value;
    if (!(cone > 0)) return null;
    stepDepth = cone;
    top.push([hole.cskDiameter / 2 + eps * Math.tan((hole.cskAngle * Math.PI) / 360), eps], [radius, -cone]);
  } else if (hole.kind === 'counterbore') {
    if (hole.cboreDiameter === undefined || hole.cboreDepth === undefined) return null;
    stepDepth = hole.cboreDepth;
    top.push([hole.cboreDiameter / 2, eps], [hole.cboreDiameter / 2, -hole.cboreDepth], [radius, -hole.cboreDepth]);
  } else if (hole.kind === 'counterdrill') {
    const { cboreDiameter, cboreDepth, cskDiameter, cskAngle } = hole;
    if (cboreDiameter === undefined || cboreDepth === undefined || cskDiameter === undefined || cskAngle === undefined) return null;
    const cone = countersinkDepth(cboreDiameter, cskDiameter, cskAngle).value;
    if (!(cone > 0) || !(cboreDepth > cone)) return null;
    stepDepth = cboreDepth;
    top.push(
      [cskDiameter / 2 + eps * Math.tan((cskAngle * Math.PI) / 360), eps],
      [cboreDiameter / 2, -cone],
      [cboreDiameter / 2, -cboreDepth],
      [radius, -cboreDepth],
    );
  } else top.push([radius, eps]);
  const bottom = holeBottom(extent, Math.max(reach, stepDepth), eps);
  if (!(bottom > stepDepth) && hole.kind !== 'simple') return null;
  top.push([radius, -bottom]);
  const tip =
    extent.kind === 'blind' && extent.drillPointAngle !== undefined ? drillTipHeight(hole.diameter, extent.drillPointAngle).value : 0;
  top.push([0, -bottom - tip]);
  return top;
}

/** Depth of the cylindrical bottom of a hole tool below the face. */
function holeBottom(extent: HoleExtent, reach: number, eps: number): number {
  switch (extent.kind) {
    case 'blind':
      return extent.depth;
    case 'up_to_face':
      return extent.depth + (extent.exits === true ? 2 * eps : 0);
    case 'up_to_next':
      return extent.depth + 2 * eps;
    case 'through_all':
      return reach + 2 * eps;
  }
}

const toolEntity = (fields: Record<string, unknown>, position: Vec3, rotation: Vec3): Entity =>
  ({ id: 'feature-tool', ...fields, position, rotation, layerId: DEFAULT_LAYER_ID, color: TOOL_COLOR }) as Entity;

function unionOf(tools: readonly ShapeRecipe[]): ShapeRecipe {
  const [first] = tools;
  if (tools.length === 1 && first !== undefined) return first;
  const middle = Math.ceil(tools.length / 2);
  return { op: 'boolean', boolean: 'union', a: unionOf(tools.slice(0, middle)), b: unionOf(tools.slice(middle)) };
}

function holeTool(node: Extract<FeatureRecipe, { feature: 'hole' }>, reach: number): ShapeRecipe | null {
  const profile = holeToolProfile(node.hole, node.extent, reach);
  if (profile === null || node.points.length === 0) return null;
  const rotation = frameEuler(node.frame);
  const tools = node.points.map(
    (point): ShapeRecipe => ({
      op: 'solid',
      entity: toolEntity(
        { kind: 'revolution', profile, axis: [0, 0, 1], angle: 2 * Math.PI, segments: TOOL_SEGMENTS },
        frameToWorld(node.frame, point),
        rotation,
      ),
    }),
  );
  const groove = threadGroove(node.hole, node.extent, reach);
  if (node.hole.thread?.modelled === true && groove === null) return null;
  if (groove !== null)
    for (const point of node.points) {
      const start = frameToWorld(node.frame, point, groove.startDepth);
      tools.push({ op: 'solid', entity: toolEntity({ kind: 'mesh', mesh: groove.mesh }, start, rotation) });
    }
  return unionOf(tools);
}

/** A pocket tool, its exact outline (and island outlines) and its floor depth below the face. */
export interface PocketTool {
  readonly recipe: ShapeRecipe;
  readonly outline: PocketOutline;
  readonly islands: readonly PocketOutline[];
  readonly floorDepth: number;
}

function pocketTool(frame: FeatureFrame, pocket: PocketSpec, reach: number): PocketTool | null {
  const outline = roundedOutline(pocket.outline, pocket.cornerRadius);
  if (typeof outline === 'string') return null;
  const islands = (pocket.islands ?? []).map((island) => roundedOutline(island, pocket.cornerRadius));
  const rounded = islands.filter((island): island is PocketOutline => typeof island !== 'string');
  if (rounded.length !== islands.length) return null;
  const eps = epsilonOf(pocket.cornerRadius > 0 ? pocket.cornerRadius : 1);
  const floorDepth = pocket.depth === 'through' ? reach + 2 * eps : pocket.depth;
  if (!(floorDepth > 0)) return null;
  const cutter: ShapeRecipe = {
    op: 'solid',
    entity: toolEntity(
      { kind: 'extrusion', profile: outline.profile, curves: outline.curves, depth: floorDepth + eps },
      frameToWorld(frame, [0, 0], floorDepth),
      frameEuler(frame),
    ),
  };
  const posts = rounded.map(
    (island): ShapeRecipe => ({
      op: 'solid',
      entity: toolEntity(
        { kind: 'extrusion', profile: island.profile, curves: island.curves, depth: floorDepth + 3 * eps },
        frameToWorld(frame, [0, 0], floorDepth + eps),
        frameEuler(frame),
      ),
    }),
  );
  const recipe: ShapeRecipe = posts.length === 0 ? cutter : { op: 'boolean', boolean: 'subtract', a: cutter, b: unionOf(posts) };
  return { recipe, outline, islands: rounded, floorDepth };
}

/** The rib tool: the thickened path extruded `height` along the frame normal from the face plane. */
function ribTool(frame: FeatureFrame, rib: RibSpec): ShapeRecipe | null {
  const polygon = thickenedPath(rib.path, rib.thickness, rib.symmetric);
  if (typeof polygon === 'string' || !(rib.height > 0)) return null;
  const entity = toolEntity({ kind: 'extrusion', profile: polygon, depth: rib.height }, frameToWorld(frame, [0, 0]), frameEuler(frame));
  return { op: 'solid', entity };
}

export interface LoweredFeature {
  /** The compound tool: subtracted from `source`, or fused to it when `mode` is 'union' (rib). */
  readonly tool: ShapeRecipe;
  readonly mode: 'subtract' | 'union';
  /** Set for a pocket: its outline and floor depth, to find the floor edges on the cut result. */
  readonly pocket?: PocketTool;
}

/** The compound tool of a feature node; `reach` is only read by through-all holes and through pockets. */
export function lowerFeature(node: FeatureRecipe, reach: number): LoweredFeature | null {
  if (node.feature === 'hole') {
    const tool = holeTool(node, reach);
    return tool === null ? null : { tool, mode: 'subtract' };
  }
  if (node.feature === 'rib') {
    const tool = ribTool(node.frame, node.rib);
    return tool === null ? null : { tool, mode: 'union' };
  }
  const tool = pocketTool(node.frame, node.pocket, reach);
  return tool === null ? null : { tool: tool.recipe, mode: 'subtract', pocket: tool };
}

/** Whether lowering reads the source's extent (through-all hole, through pocket). */
export const needsReach = (node: FeatureRecipe): boolean => {
  if (node.feature === 'hole') return node.extent.kind === 'through_all';
  return node.feature === 'pocket' && node.pocket.depth === 'through';
};
