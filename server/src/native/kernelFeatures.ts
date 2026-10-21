/**
 * Host half of native `feature` nodes (RS-1): the feature walk (core shapeKernel.ts `build` + `lowerFeature`) up to the
 * OCCT calls, which the sidecar makes. For each feature node of a request's recipes: the source's reach below the face plane (from the sidecar's own display
 * mesh), the core lowering (`lowerFeature`) and the BRepFeat inputs (hole half-sections per position,
 * pocket outline chain and sketch-face probes). The sidecar then builds `featureCut` (solver/.../recipe/nodes.rs).
 * A pocket floor fillet sends the floor-selection inputs; the sidecar picks the floor edges on the cut's own topology and fillets them.
 * @failure a sidecar that cannot tessellate a source (unsupported node) -> the whole request is unsupported natively
 */

import type { MeshData, ShapeRecipe, Vec2, Vec3 } from '@core/model/types';
import { holeToolProfile, lowerFeature, needsReach, throughReach, type PocketTool } from '@core/geometry/featureLowering';
import { frameToWorld } from '@core/geometry/featureFrame';
import { roundedOutline } from '@core/geometry/pocketOutline';
import { polygonCentroid } from '@lib/polygon';
import { add3, scale3 } from '@lib/vec3';
import { orientedChain } from './kernelLeaves';
import type { StepAssemblyPart, StepOccurrence } from '@core/geometry/kernel';
import type { ExchangeWriteRequest } from '@core/geometry/kernelExchange';
import { takesShapeFirst, type FeatureLowering, type FeatureLowerings } from './kernelProtocol';

type FeatureRecipe = Extract<ShapeRecipe, { op: 'feature' }>;

/** NATIVE_MAX_HOLES: more positions are cut by the lowering's one compound boolean. */
const NATIVE_MAX_HOLES = 8;

/** Display mesh of a source recipe from the sidecar; 'unsupported' when the sidecar cannot build it. */
export type SourceMesher = (source: ShapeRecipe, features: FeatureLowerings) => Promise<MeshData | null | 'unsupported'>;

type PreparedFeatures = { readonly features: FeatureLowerings } | { readonly unsupported: string };

const flat = (points: readonly Vec3[]): number[] => points.flat();

/** BRepFeat hole inputs: one revolved half-section per position (world space). */
function holeInputs(node: Extract<FeatureRecipe, { feature: 'hole' }>, reach: number): FeatureLowering['holes'] {
  if (node.points.length > NATIVE_MAX_HOLES || node.hole.thread?.modelled === true) return undefined;
  const profile = holeToolProfile(node.hole, node.extent, reach);
  if (profile === null) return undefined;
  const origins = node.points.map((point) => frameToWorld(node.frame, point));
  const profiles = origins.map((origin) =>
    flat(profile.map(([radius, height]) => add3(add3(origin, scale3(node.frame.xDir, radius)), scale3(node.frame.normal, height)))),
  );
  return { profiles, origins, normal: node.frame.normal };
}

/** BRepFeat pocket inputs: the oriented outline chain, the sketch-face probes and the prism length. */
function pocketInputs(node: Extract<FeatureRecipe, { feature: 'pocket' }>, reach: number): FeatureLowering['pocket'] {
  const { pocket, frame } = node;
  if ((pocket.islands?.length ?? 0) > 0) return undefined;
  const outline = roundedOutline(pocket.outline, pocket.cornerRadius);
  if (typeof outline === 'string') return undefined;
  const place = (point: Vec2): Vec3 => frameToWorld(frame, point);
  const probes = flat([polygonCentroid(pocket.outline), ...outline.profile].map(place));
  const length = pocket.depth === 'through' ? reach + 1e-3 * (1 + reach) : pocket.depth;
  return { chain: orientedChain(outline.curves, place, true), origin: frame.origin, normal: frame.normal, probes, length };
}

/** featureFillet.ts `floorEdgeIndices` inputs: the floor plane and the outline / island curves, selected on the cut's native topology. */
function floorFilletInputs(node: Extract<FeatureRecipe, { feature: 'pocket' }>, tool: PocketTool): FeatureLowering['floorFillet'] {
  if (!(node.pocket.floorFillet > 0)) return undefined;
  const { origin, normal, xDir } = node.frame;
  return {
    radius: node.pocket.floorFillet,
    floorDepth: tool.floorDepth,
    origin,
    normal,
    xDir,
    outlines: [tool.outline, ...tool.islands].map((outline) => outline.curves),
  };
}

function lowering(node: FeatureRecipe, reach: number): FeatureLowering {
  const lowered = lowerFeature(node, reach);
  if (lowered === null) return { tool: null, mode: 'subtract' };
  const floorFillet = node.feature === 'pocket' && lowered.pocket !== undefined ? floorFilletInputs(node, lowered.pocket) : undefined;
  const holes = node.feature === 'hole' ? holeInputs(node, reach) : undefined;
  const pocket = node.feature === 'pocket' ? pocketInputs(node, reach) : undefined;
  return {
    tool: lowered.tool,
    mode: lowered.mode,
    ...(holes === undefined ? {} : { holes }),
    ...(pocket === undefined ? {} : { pocket }),
    ...(floorFillet === undefined ? {} : { floorFillet }),
  };
}

/** Every shape handle of an assembly export, each shared part once. */
function assemblyHandles(occurrences: readonly StepOccurrence<unknown>[]): unknown[] {
  const seen = new Set<StepAssemblyPart<unknown>>();
  const handles: unknown[] = [];
  const visit = ({ part }: StepOccurrence<unknown>): void => {
    if (seen.has(part)) return;
    seen.add(part);
    handles.push(...part.shapes);
    for (const child of part.children ?? []) visit(child);
  };
  occurrences.forEach(visit);
  return handles;
}

/** The recipes a request carries (evaluate's recipe, or the recipes of its shape handles). */
function requestRecipes(op: string, args: readonly unknown[]): ShapeRecipe[] {
  const ofHandle = (handle: unknown): ShapeRecipe[] =>
    typeof handle === 'object' && handle !== null && 'recipe' in handle ? [(handle as { recipe: ShapeRecipe }).recipe] : [];
  if (op === 'evaluate') return args[0] === undefined ? [] : [args[0] as ShapeRecipe];
  if (takesShapeFirst(op)) return ofHandle(args[0]);
  if (op === 'distance') return [...ofHandle(args[0]), ...ofHandle(args[1])];
  if (op === 'exportStep' && Array.isArray(args[0])) return args[0].flatMap(ofHandle);
  if (op === 'exportStepAssembly' && Array.isArray(args[0])) return assemblyHandles(args[0] as StepOccurrence<unknown>[]).flatMap(ofHandle);
  if (op === 'writeExchange' && typeof args[0] === 'object' && args[0] !== null)
    return (args[0] as ExchangeWriteRequest).products.flatMap((product) => product.solids.flatMap((solid) => ofHandle(solid.shape)));
  return [];
}

class Unsupported extends Error {}

/** Lowerings of every feature node in the request's recipes, children first; unsupported when a node has no native lowering. */
export async function prepareFeatures(op: string, args: readonly unknown[], mesh: SourceMesher): Promise<PreparedFeatures> {
  const features = new Map<FeatureRecipe, FeatureLowering>();
  const visit = async (recipe: ShapeRecipe): Promise<void> => {
    switch (recipe.op) {
      case 'solid':
      case 'brep':
      case 'faceSlab':
        return;
      case 'boolean':
        await visit(recipe.a);
        return visit(recipe.b);
      case 'blend':
        for (const source of recipe.sources) await visit(source);
        return;
      case 'feature': {
        await visit(recipe.source);
        if (features.has(recipe)) return;
        let reach = 0;
        if (needsReach(recipe)) {
          const sourceMesh = await mesh(recipe.source, features);
          if (sourceMesh === 'unsupported') throw new Unsupported('feature source not native');
          if (sourceMesh === null) return void features.set(recipe, { tool: null, mode: 'subtract' });
          reach = throughReach(sourceMesh, recipe.frame);
        }
        features.set(recipe, lowering(recipe, reach));
        return;
      }
      default:
        return visit(recipe.source);
    }
  };
  try {
    for (const recipe of requestRecipes(op, args)) await visit(recipe);
  } catch (error) {
    if (error instanceof Unsupported) return { unsupported: `NATIVE_UNSUPPORTED: ${error.message}` };
    throw error;
  }
  return { features };
}
