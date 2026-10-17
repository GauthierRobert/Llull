/**
 * Lowering of a `feature` recipe node (07 FTR §5.3 / §5.5) to plain booleans: `source` minus ONE compound tool. A hole tool is a revolved
 * half-section (bore, counterbore step, countersink cone, drill point) per position; a pocket tool is the exact rounded outline extruded.
 * Tools reach `epsilon` above the face so no cut face is coplanar with it. Every kernel therefore accepts the node.
 * @invariant through-all depth = the source's extent below the face plane (`throughReach`) + 2 epsilon
 * @failure inconsistent spec (cone deeper than the hole, bad outline) -> null
 */

import { type Entity, type MeshData, type ShapeRecipe, type Vec3, DEFAULT_LAYER_ID } from '../model/types';
import type { FeatureFrame, HoleExtent, HoleSpec, PocketSpec } from '../model/features';
import { countersinkDepth, drillTipHeight } from '../lib/holeMath';
import { frameEuler, frameToWorld, heightAbove } from './featureFrame';
import { type PocketOutline, roundedOutline } from './pocketOutline';

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

/** Half-section [radius, height above the face] of one hole tool; the tool axis is the local z axis. */
function holeToolProfile(hole: HoleSpec, extent: HoleExtent, reach: number): Array<[number, number]> | null {
  const radius = hole.diameter / 2;
  const eps = epsilonOf(Math.max(hole.diameter, hole.cskDiameter ?? 0, hole.cboreDiameter ?? 0));
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
  } else top.push([radius, eps]);
  const bottom = extent.kind === 'blind' ? extent.depth : Math.max(reach, stepDepth) + 2 * eps;
  if (!(bottom > stepDepth) && hole.kind !== 'simple') return null;
  top.push([radius, -bottom]);
  const tip =
    extent.kind === 'blind' && extent.drillPointAngle !== undefined ? drillTipHeight(hole.diameter, extent.drillPointAngle).value : 0;
  top.push([0, -bottom - tip]);
  return top;
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
  return unionOf(tools);
}

/** A pocket tool, its exact outline and its floor depth below the face. */
export interface PocketTool {
  readonly recipe: ShapeRecipe;
  readonly outline: PocketOutline;
  readonly floorDepth: number;
}

function pocketTool(frame: FeatureFrame, pocket: PocketSpec, reach: number): PocketTool | null {
  const outline = roundedOutline(pocket.outline, pocket.cornerRadius);
  if (typeof outline === 'string') return null;
  const eps = epsilonOf(pocket.cornerRadius > 0 ? pocket.cornerRadius : 1);
  const floorDepth = pocket.depth === 'through' ? reach + 2 * eps : pocket.depth;
  if (!(floorDepth > 0)) return null;
  const entity = toolEntity(
    { kind: 'extrusion', profile: outline.profile, curves: outline.curves, depth: floorDepth + eps },
    frameToWorld(frame, [0, 0], floorDepth),
    frameEuler(frame),
  );
  return { recipe: { op: 'solid', entity }, outline, floorDepth };
}

export interface LoweredFeature {
  /** The compound tool: subtract it from `source`. */
  readonly tool: ShapeRecipe;
  /** Set for a pocket: its outline and floor depth, to find the floor edges on the cut result. */
  readonly pocket?: PocketTool;
}

/** The compound tool of a feature node; `reach` is only read by through-all holes and through pockets. */
export function lowerFeature(node: FeatureRecipe, reach: number): LoweredFeature | null {
  if (node.feature === 'hole') {
    const tool = holeTool(node, reach);
    return tool === null ? null : { tool };
  }
  const tool = pocketTool(node.frame, node.pocket, reach);
  return tool === null ? null : { tool: tool.recipe, pocket: tool };
}

/** Whether lowering reads the source's extent (through-all hole, through pocket). */
export const needsReach = (node: FeatureRecipe): boolean =>
  node.feature === 'hole' ? node.extent.kind === 'through_all' : node.pocket.depth === 'through';
