/**
 * Lower a kernel result's exact construction (`mesh.brep`) — or one fillet / chamfer / shell step — to feature-program ops, so generated
 * code rebuilds the B-rep instead of a triangle soup.
 * @failure a node no program op expresses (a rotated placement, a scale, a shell with open faces) -> null (caller falls back)
 */

import type { EdgeRadius, Entity, Vec3 } from '../model/types';
import type { GeometryKernel } from '../geometry/kernel';
import type { MeshData } from '../model/types';
import type { ShapeRecipe } from '../model/types';
import type { Feature, FeatureBase, FilletLaw, Term } from './program';
import { lawNodes } from '../geometry/blend/law';
import { type FeatureRecipe, lowerFeature, needsReach, throughReach } from '../geometry/featureLowering';
import { floorEdgeIndices } from '../geometry/featureFillet';
import { featureNotes } from './featureNotes';

const BOOLEAN_OPS = { union: 'union', subtract: 'cut', intersect: 'intersect' } as const;

export interface RecipeLowering {
  readonly kernel: GeometryKernel | null;
  /** Fresh variable name for a leaf solid. */
  readonly take: (preferred: string) => string;
  /** The `solid` feature of a leaf entity (placement included). */
  readonly solid: (entity: Entity, variable: string) => Feature;
  readonly base: (variable: string) => FeatureBase;
}

/** World-space triangle soup (9 numbers per triangle) of an indexed mesh. */
export function meshSoup(mesh: MeshData): number[] {
  return mesh.indices.flatMap((index) => [
    mesh.positions[index * 3] ?? 0,
    mesh.positions[index * 3 + 1] ?? 0,
    mesh.positions[index * 3 + 2] ?? 0,
  ]);
}

/** Mid points of the selected edges of `source`, when the kernel has exact topology (else the recipe's own `near`). */
function edgeMidPoints(kernel: GeometryKernel | null, source: ShapeRecipe, edges: readonly number[]): Vec3[] | undefined {
  if (kernel === null || edges.length === 0) return undefined;
  const shape = kernel.evaluate(source);
  const topology = shape === null ? null : kernel.topology(shape);
  const mids = edges.map((index) => topology?.edges[index]?.mid);
  return mids.every((mid): mid is Vec3 => mid !== undefined) ? mids : undefined;
}

/** Display triangles of a recipe node (the OpenSCAD fallback for fillets / shells). */
function soupOf(kernel: GeometryKernel | null, recipe: ShapeRecipe): number[] | undefined {
  const shape = kernel?.evaluate(recipe) ?? null;
  const mesh = shape === null ? null : (kernel?.tessellate(shape) ?? null);
  return mesh === null ? undefined : meshSoup(mesh);
}

/** Lengths of the selected edges of `source` (document units), or null when the kernel has no exact topology. */
function edgeLengths(kernel: GeometryKernel | null, source: ShapeRecipe, edges: readonly number[]): number[] | null {
  const shape = kernel === null ? null : kernel.evaluate(source);
  const topology = shape === null || kernel === null ? null : kernel.topology(shape);
  const lengths = edges.map((index) => topology?.edges[index]?.length);
  return lengths.every((length): length is number => length !== undefined) ? lengths : null;
}

/** The laws of a fillet with a varying radius, with the nodes a kernel interpolates; null when edge lengths are needed and unavailable. */
function filletLaws(recipe: Extract<ShapeRecipe, { op: 'fillet' | 'chamfer' }>, kernel: GeometryKernel | null): FilletLaw[] | null {
  const laws: readonly EdgeRadius[] =
    recipe.radii ?? recipe.edges.map(() => ({ size: recipe.size, ...(recipe.sizeEnd === undefined ? {} : { sizeEnd: recipe.sizeEnd }) }));
  const needsLength = laws.some((law) => law.interpolation === 'linear');
  const lengths = needsLength ? edgeLengths(kernel, recipe.source, recipe.edges) : laws.map(() => 1);
  if (lengths === null) return null;
  return laws.map((law, at) => ({
    size: law.size,
    ...(law.sizeEnd === undefined ? {} : { sizeEnd: law.sizeEnd }),
    ...(law.sizes === undefined ? {} : { sizes: law.sizes }),
    linear: law.interpolation === 'linear',
    ...(law.interpolation === 'monotone' ? { monotone: true } : {}),
    nodes: lawNodes(law, lengths[at] ?? 1),
  }));
}

/** A fillet with a conic / curvature section, a second leg or a setback corner. */
const profiledFillet = (recipe: Extract<ShapeRecipe, { op: 'fillet' | 'chamfer' }>): boolean =>
  (recipe.profile !== undefined && recipe.profile.type !== 'circular') ||
  (recipe.radii ?? []).some((law) => law.size2 !== undefined) ||
  (recipe.op === 'fillet' && (recipe.corners ?? []).length > 0);

/** Whether a fillet / chamfer node is one the program ops cannot express (a sided chamfer, a profile or two-leg fillet: BLD_CODEGEN_UNSUPPORTED, the export carries the exact result). */
export function blendNotExpressible(recipe: ShapeRecipe): boolean {
  switch (recipe.op) {
    case 'chamfer':
      return recipe.faces !== undefined || recipe.sizeEnd !== undefined || blendNotExpressible(recipe.source);
    case 'fillet':
      return profiledFillet(recipe) || blendNotExpressible(recipe.source);
    case 'faceBlend':
    case 'fullRound':
      return true;
    case 'solid':
    case 'brep':
    case 'faceSlab':
    case 'sheetSolid':
      return false;
    case 'boolean':
      return blendNotExpressible(recipe.a) || blendNotExpressible(recipe.b);
    case 'blend':
      return recipe.sources.some(blendNotExpressible);
    default:
      return blendNotExpressible(recipe.source);
  }
}

/**
 * One fillet / chamfer / shell op applied in place to `variable`.
 * @failure a varying radius whose straight pieces need edge lengths the kernel cannot give, or a sided chamfer -> null
 */
export function modificationFeature(
  recipe: Extract<ShapeRecipe, { op: 'fillet' | 'chamfer' | 'shell' }>,
  base: FeatureBase,
  kernel: GeometryKernel | null,
  mesh: number[] | undefined,
  size: Term = { value: recipe.op === 'shell' ? recipe.thickness : recipe.size },
): Feature | null {
  const fallback = mesh === undefined ? {} : { mesh };
  if (recipe.op === 'shell') return { ...base, op: 'shell', thickness: size, ...fallback };
  if (recipe.op === 'chamfer' && (recipe.faces !== undefined || recipe.sizeEnd !== undefined)) return null;
  if (recipe.op === 'fillet' && profiledFillet(recipe)) return null;
  const varying = recipe.op === 'fillet' && (recipe.sizeEnd !== undefined || recipe.radii !== undefined);
  const laws = varying ? filletLaws(recipe, kernel) : undefined;
  if (laws === null) return null;
  const near =
    edgeMidPoints(kernel, recipe.source, recipe.edges) ??
    (recipe.near !== undefined && recipe.near.length > 0 ? [...recipe.near] : undefined);
  return {
    ...base,
    op: recipe.op,
    edges: recipe.edges,
    size,
    ...(laws === undefined ? {} : { laws }),
    ...(near === undefined ? {} : { near }),
    ...fallback,
  };
}

/** A hole / pocket as notes + tool solids + one cut (+ the floor fillet of a pocket); null when the kernel cannot supply what lowering needs. */
function lowerFeatureNode(recipe: FeatureRecipe, lowering: RecipeLowering): Lowered | null {
  const source = lowerRecipe(recipe.source, lowering);
  const sourceShape = lowering.kernel?.evaluate(recipe.source) ?? null;
  const mesh = sourceShape === null ? null : (lowering.kernel?.tessellate(sourceShape) ?? null);
  if (source === null || (needsReach(recipe) && mesh === null)) return null;
  const plan = lowerFeature(recipe, mesh === null ? 0 : throughReach(mesh, recipe.frame));
  const tool = plan === null ? null : lowerRecipe(plan.tool, lowering);
  if (plan === null || tool === null) return null;
  const base = lowering.base(source.variable);
  const notes = featureNotes(recipe).map((text): Feature => ({ ...base, op: 'note', text }));
  const cut: Feature = {
    ...base,
    op: 'boolean',
    kind: plan.mode === 'union' ? 'union' : 'cut',
    left: source.variable,
    right: tool.variable,
  };
  const features = [...source.features, ...notes, ...tool.features, cut];
  if (recipe.feature !== 'pocket' || recipe.pocket.floorFillet <= 0 || plan.pocket === undefined)
    return { features, variable: source.variable };
  const kernel = lowering.kernel;
  const cutRecipe: ShapeRecipe = { op: 'boolean', boolean: 'subtract', a: recipe.source, b: plan.tool };
  const cutShape = kernel === null ? null : kernel.evaluate(cutRecipe);
  const topology = kernel === null || cutShape === null ? null : kernel.topology(cutShape);
  const edges = topology === null ? [] : floorEdgeIndices(topology, plan.pocket, recipe.frame);
  if (topology === null || edges.length === 0) return null;
  const near = edges.map((index) => topology.edges[index]?.mid).filter((mid): mid is Vec3 => mid !== undefined);
  const size: Term = { value: recipe.pocket.floorFillet };
  return { features: [...features, { ...base, op: 'fillet', edges, near, size }], variable: source.variable };
}

interface Lowered {
  readonly features: Feature[];
  readonly variable: string;
}

/** Features that rebuild `recipe` exactly, and the variable holding the result; null if inexpressible. */
export function lowerRecipe(recipe: ShapeRecipe, lowering: RecipeLowering): Lowered | null {
  switch (recipe.op) {
    case 'solid': {
      const variable = lowering.take(recipe.entity.kind);
      return { features: [lowering.solid(recipe.entity, variable)], variable };
    }
    case 'boolean': {
      const left = lowerRecipe(recipe.a, lowering);
      const right = left === null ? null : lowerRecipe(recipe.b, lowering);
      if (left === null || right === null) return null;
      const feature: Feature = {
        ...lowering.base(left.variable),
        op: 'boolean',
        kind: BOOLEAN_OPS[recipe.boolean],
        left: left.variable,
        right: right.variable,
      };
      return { features: [...left.features, ...right.features, feature], variable: left.variable };
    }
    case 'blend':
    case 'brep':
    case 'faceBlend':
    case 'fullRound':
    case 'faceSlab':
    case 'sheetSolid':
    case 'faceOp':
    case 'emboss':
    case 'deform':
      return null;
    case 'fillet':
    case 'chamfer':
    case 'shell': {
      if (recipe.op === 'shell' && recipe.openNear !== undefined && recipe.openNear.length > 0) return null;
      const source = lowerRecipe(recipe.source, lowering);
      if (source === null) return null;
      const base = lowering.base(source.variable);
      const feature = modificationFeature(recipe, base, lowering.kernel, soupOf(lowering.kernel, recipe));
      return feature === null ? null : { features: [...source.features, feature], variable: source.variable };
    }
    case 'place': {
      if (recipe.rotation.some((angle) => angle !== 0)) return null;
      const source = lowerRecipe(recipe.source, lowering);
      if (source === null) return null;
      const delta = recipe.position.map((value) => ({ value })) as [{ value: number }, { value: number }, { value: number }];
      const feature: Feature = { ...lowering.base(source.variable), op: 'translate', delta };
      return { features: [...source.features, feature], variable: source.variable };
    }
    case 'scale':
      return null;
    case 'feature':
      return lowerFeatureNode(recipe, lowering);
  }
}
