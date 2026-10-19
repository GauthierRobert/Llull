/**
 * Host half of native `feature` nodes (RS-1): the WASM kernel's feature walk (core shapeKernel.ts `build` + occtFeatures.ts) up to the
 * OCCT calls. For each feature node of a request's recipes: the source's reach below the face plane (from the sidecar's own display
 * mesh, as the WASM kernel reads its mesh), the core lowering (`lowerFeature`) and the BRepFeat inputs (hole half-sections per position,
 * pocket outline chain and sketch-face probes). The sidecar then builds `featureCut` (solver/.../recipe/nodes.rs).
 * Nodes that stay on WASM for now: `fillet` / `chamfer` (edge indices come from `topology`, not native yet) and a pocket with a floor
 * fillet (it fillets edges found on the WASM topology); a request holding one is answered by the WASM kernel.
 * @failure a sidecar that cannot tessellate a source (unsupported node) -> the whole request is unsupported natively
 */

import type { MeshData, ShapeRecipe, Vec2, Vec3 } from '@core/model/types';
import { holeToolProfile, lowerFeature, needsReach, throughReach } from '@core/geometry/featureLowering';
import { frameToWorld } from '@core/geometry/featureFrame';
import { roundedOutline } from '@core/geometry/pocketOutline';
import { polygonCentroid } from '@lib/polygon';
import { add3, scale3 } from '@lib/vec3';
import { orientedChain } from './kernelLeaves';
import { SINGLE_SHAPE_OPS, type FeatureLowering, type FeatureLowerings } from './kernelProtocol';

type FeatureRecipe = Extract<ShapeRecipe, { op: 'feature' }>;

/** occtFeatures.ts NATIVE_MAX_HOLES: more positions are cut by the lowering's one compound boolean. */
const NATIVE_MAX_HOLES = 8;

/** Display mesh of a source recipe from the sidecar; 'unsupported' when the sidecar cannot build it. */
export type SourceMesher = (source: ShapeRecipe, features: FeatureLowerings) => Promise<MeshData | null | 'unsupported'>;

type PreparedFeatures = { readonly features: FeatureLowerings } | { readonly unsupported: string };

/** Recipe nodes the host keeps on the WASM kernel, with the reason logged on the first fallback. */
function gatedReason(recipe: ShapeRecipe): string | null {
  if (recipe.op === 'fillet' || recipe.op === 'chamfer') return `${recipe.op}: edge indices wait for native topology`;
  if (recipe.op === 'feature' && recipe.feature === 'pocket' && recipe.pocket.floorFillet > 0)
    return 'pocket floor fillet: needs native topology';
  return null;
}

const flat = (points: readonly Vec3[]): number[] => points.flat();

/** occtFeatures.ts `nativeHoles` inputs: one revolved half-section per position (world space). */
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

/** occtFeatures.ts `nativePocket` inputs: the oriented outline chain, the sketch-face probes and the prism length. */
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

function lowering(node: FeatureRecipe, reach: number): FeatureLowering {
  const lowered = lowerFeature(node, reach);
  if (lowered === null) return { tool: null, mode: 'subtract' };
  const holes = node.feature === 'hole' ? holeInputs(node, reach) : undefined;
  const pocket = node.feature === 'pocket' ? pocketInputs(node, reach) : undefined;
  return { tool: lowered.tool, mode: lowered.mode, ...(holes === undefined ? {} : { holes }), ...(pocket === undefined ? {} : { pocket }) };
}

/** The recipes a request carries (evaluate's recipe, or the recipes of its shape handles). */
function requestRecipes(op: string, args: readonly unknown[]): ShapeRecipe[] {
  const ofHandle = (handle: unknown): ShapeRecipe[] =>
    typeof handle === 'object' && handle !== null && 'recipe' in handle ? [(handle as { recipe: ShapeRecipe }).recipe] : [];
  if (op === 'evaluate') return args[0] === undefined ? [] : [args[0] as ShapeRecipe];
  if (SINGLE_SHAPE_OPS.has(op)) return ofHandle(args[0]);
  if (op === 'exportStep' && Array.isArray(args[0])) return args[0].flatMap(ofHandle);
  return [];
}

class Unsupported extends Error {}

/** Lowerings of every feature node in the request's recipes, children first; unsupported when a node stays on WASM. */
export async function prepareFeatures(op: string, args: readonly unknown[], mesh: SourceMesher): Promise<PreparedFeatures> {
  const features = new Map<FeatureRecipe, FeatureLowering>();
  const visit = async (recipe: ShapeRecipe): Promise<void> => {
    const gated = gatedReason(recipe);
    if (gated !== null) throw new Unsupported(gated);
    switch (recipe.op) {
      case 'solid':
      case 'brep':
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
