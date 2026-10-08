/**
 * Lower a kernel result's exact construction (`mesh.brep`) — or one fillet / chamfer / shell step —
 * to feature-program ops, so generated code rebuilds the B-rep instead of a triangle soup.
 *
 * @layer core/codegen
 * @pure the kernel is only queried (edge mid points, display triangles), never asked to change
 * @failure a node no program op expresses (a rotated placement, a scale) -> null (caller falls back)
 */

import type { Entity, Vec3 } from '../model/types';
import type { GeometryKernel, MeshData } from '../geometry/kernel';
import type { ShapeRecipe } from '../geometry/shapeRecipe';
import type { Feature, FeatureBase, Term } from './program';

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

/** Mid points of the selected edges of `source`, when the kernel has exact topology. */
export function edgeMidPoints(
  kernel: GeometryKernel | null,
  source: ShapeRecipe,
  edges: readonly number[],
): Vec3[] | undefined {
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

/** One fillet / chamfer / shell op applied in place to `variable`. */
export function modificationFeature(
  recipe: Extract<ShapeRecipe, { op: 'fillet' | 'chamfer' | 'shell' }>,
  base: FeatureBase,
  kernel: GeometryKernel | null,
  mesh: number[] | undefined,
  size: Term = { value: recipe.op === 'shell' ? recipe.thickness : recipe.size },
): Feature {
  const fallback = mesh === undefined ? {} : { mesh };
  if (recipe.op === 'shell') return { ...base, op: 'shell', thickness: size, ...fallback };
  const near = edgeMidPoints(kernel, recipe.source, recipe.edges);
  return {
    ...base,
    op: recipe.op,
    edges: recipe.edges,
    size,
    ...(near === undefined ? {} : { near }),
    ...fallback,
  };
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
    case 'fillet':
    case 'chamfer':
    case 'shell': {
      const source = lowerRecipe(recipe.source, lowering);
      if (source === null) return null;
      const base = lowering.base(source.variable);
      const feature = modificationFeature(
        recipe,
        base,
        lowering.kernel,
        soupOf(lowering.kernel, recipe),
      );
      return { features: [...source.features, feature], variable: source.variable };
    }
    case 'place': {
      if (recipe.rotation.some((angle) => angle !== 0)) return null;
      const source = lowerRecipe(recipe.source, lowering);
      if (source === null) return null;
      const delta = recipe.position.map((value) => ({ value })) as [
        { value: number },
        { value: number },
        { value: number },
      ];
      const feature: Feature = { ...lowering.base(source.variable), op: 'translate', delta };
      return { features: [...source.features, feature], variable: source.variable };
    }
    case 'scale':
      return null;
  }
}
