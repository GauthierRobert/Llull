/**
 * Shape recipe: the serializable construction tree of a solid (primitive leaves, boolean / fillet /
 * chamfer / shell / placement / scale nodes). The kernel evaluates it to an exact, kernel-owned shape
 * (`ShapeHandle`); the document stores the recipe on result `mesh` entities (`brep`), never the shape.
 *
 * @layer core/geometry
 * @pure
 * @invariant `recipeKey` covers every input a kernel reads; presentation fields (id, name, color,
 *   layer, tags, material) never reach it, so a recolored operand reuses the cached shape
 */

import type { Entity, MeshSolidEntity, Vec3 } from '../model/types';
import { SOLID_KINDS } from '../model/types';
import { hashText } from '../lib/hash';
import { isRecord } from '../lib/isRecord';

export type BooleanOp = 'union' | 'subtract' | 'intersect';

export type ShapeRecipe =
  /** A solid entity as authored (primitive, profile solid, or a plain triangle mesh). */
  | { readonly op: 'solid'; readonly entity: Entity }
  | {
      readonly op: 'boolean';
      readonly boolean: BooleanOp;
      readonly a: ShapeRecipe;
      readonly b: ShapeRecipe;
    }
  /** `edges`: 0-based indices into the source's unique edges (`ShapeTopology.edges`); [] = all. */
  | {
      readonly op: 'fillet' | 'chamfer';
      readonly source: ShapeRecipe;
      readonly edges: readonly number[];
      readonly size: number;
    }
  | { readonly op: 'shell'; readonly source: ShapeRecipe; readonly thickness: number }
  /** Rotate (M = Rx·Ry·Rz, radians) then translate. */
  | {
      readonly op: 'place';
      readonly source: ShapeRecipe;
      readonly position: Vec3;
      readonly rotation: Vec3;
    }
  /** Uniform scale about the world origin. */
  | { readonly op: 'scale'; readonly source: ShapeRecipe; readonly factor: number };

const PRESENTATION_FIELDS = new Set(['id', 'name', 'color', 'layerId', 'tags', 'materialId']);

/** Stable key of an entity's geometry (presentation fields dropped, keys sorted). */
export function geometryKey(entity: Entity): string {
  const record = entity as unknown as Record<string, unknown>;
  const kept = Object.keys(record)
    .filter((key) => !PRESENTATION_FIELDS.has(key))
    .sort()
    .map((key) => [key, record[key]]);
  return JSON.stringify(kept);
}

const keys = new WeakMap<ShapeRecipe, string>();

/** Content hash of a recipe: equal keys ⇔ the kernel would build the same shape. Memoized. */
export function recipeKey(recipe: ShapeRecipe): string {
  const cached = keys.get(recipe);
  if (cached !== undefined) return cached;
  const key = hashText(keyText(recipe));
  keys.set(recipe, key);
  return key;
}

function keyText(recipe: ShapeRecipe): string {
  switch (recipe.op) {
    case 'solid':
      return `solid(${geometryKey(recipe.entity)})`;
    case 'boolean':
      return `${recipe.boolean}(${recipeKey(recipe.a)},${recipeKey(recipe.b)})`;
    case 'fillet':
    case 'chamfer':
      return `${recipe.op}(${recipeKey(recipe.source)},${recipe.size},[${recipe.edges.join(',')}])`;
    case 'shell':
      return `shell(${recipeKey(recipe.source)},${recipe.thickness})`;
    case 'place':
      return `place(${recipeKey(recipe.source)},${recipe.position.join(',')},${recipe.rotation.join(',')})`;
    case 'scale':
      return `scale(${recipeKey(recipe.source)},${recipe.factor})`;
  }
}

const isZero = (v: Vec3): boolean => v.every((component) => component === 0);

/** The recipe of a mesh entity's B-rep, placed by the entity's own position/rotation. */
function placedBrep(entity: MeshSolidEntity, brep: ShapeRecipe): ShapeRecipe {
  if (isZero(entity.position) && isZero(entity.rotation)) return brep;
  return { op: 'place', source: brep, position: entity.position, rotation: entity.rotation };
}

/**
 * Exact recipe of a 3D solid entity: a kernel result (`mesh` with `brep`) resumes its construction
 * tree; any other solid is a leaf.
 */
export function recipeOf(entity: Entity): ShapeRecipe {
  if (entity.kind === 'mesh' && entity.brep !== undefined) return placedBrep(entity, entity.brep);
  return { op: 'solid', entity };
}

/**
 * Leaf recipe of the entity's own triangles (a `mesh` entity's `brep` dropped): the fallback when a
 * kernel cannot rebuild the exact tree (e.g. a fillet recipe loaded under a kernel without fillets).
 */
export function meshRecipeOf(entity: Entity): ShapeRecipe | null {
  if (entity.kind !== 'mesh' || entity.brep === undefined) return null;
  const plain: MeshSolidEntity = { ...entity };
  delete plain.brep;
  return { op: 'solid', entity: plain };
}

/** Max nesting accepted from a loaded document (a deeper tree is rejected, not evaluated). */
const MAX_RECIPE_DEPTH = 256;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec3Ok = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(finite);

/** Checks one leaf entity of an untrusted recipe; returns an error text or null. */
export type LeafValidator = (entity: Record<string, unknown>) => string | null;

const isIndexArray = (v: unknown, vertexCount: number): boolean =>
  Array.isArray(v) &&
  v.every((i) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < vertexCount);

/** A leaf must be a 3D solid (not an instance); a mesh leaf needs well-formed triangle arrays. */
function leafError(entity: Record<string, unknown>, validateLeaf: LeafValidator): string | null {
  const kind = entity['kind'];
  if (typeof kind !== 'string' || !(SOLID_KINDS as readonly string[]).includes(kind))
    return `solid leaf has kind '${String(kind)}', expected a 3D solid kind`;
  if (kind === 'mesh') {
    const mesh = entity['mesh'];
    const positions = isRecord(mesh) ? mesh['positions'] : undefined;
    if (!Array.isArray(positions) || positions.length % 3 !== 0 || !positions.every(finite))
      return 'mesh leaf positions must be finite xyz triples';
    if (!isIndexArray(isRecord(mesh) ? mesh['indices'] : undefined, positions.length / 3))
      return 'mesh leaf indices must be integers within the vertex range';
  }
  return validateLeaf(entity);
}

function nodeError(
  node: Record<string, unknown>,
  depth: number,
  validateLeaf: LeafValidator,
): string | null {
  const child = (value: unknown): string | null => check(value, depth + 1, validateLeaf);
  switch (node['op']) {
    case 'solid':
      return isRecord(node['entity'])
        ? leafError(node['entity'], validateLeaf)
        : 'solid leaf needs an entity';
    case 'boolean':
      if (!['union', 'subtract', 'intersect'].includes(String(node['boolean'])))
        return `unknown boolean '${String(node['boolean'])}'`;
      return child(node['a']) ?? child(node['b']);
    case 'fillet':
    case 'chamfer': {
      const edges = node['edges'];
      if (!Array.isArray(edges) || !edges.every((e) => Number.isInteger(e) && (e as number) >= 0))
        return `${String(node['op'])}: edges must be non-negative integers`;
      if (!finite(node['size']) || node['size'] <= 0)
        return `${String(node['op'])}: size must be > 0`;
      return child(node['source']);
    }
    case 'shell':
      if (!finite(node['thickness']) || node['thickness'] <= 0)
        return 'shell: thickness must be > 0';
      return child(node['source']);
    case 'place':
      if (!vec3Ok(node['position']) || !vec3Ok(node['rotation']))
        return 'place: position and rotation must be finite Vec3';
      return child(node['source']);
    case 'scale':
      if (!finite(node['factor']) || node['factor'] <= 0) return 'scale: factor must be > 0';
      return child(node['source']);
    default:
      return `unknown recipe op '${String(node['op'])}'`;
  }
}

function check(value: unknown, depth: number, validateLeaf: LeafValidator): string | null {
  if (depth > MAX_RECIPE_DEPTH) return `recipe nested deeper than ${MAX_RECIPE_DEPTH}`;
  if (!isRecord(value)) return 'recipe node is not an object';
  return nodeError(value, depth, validateLeaf);
}

/**
 * Check of an untrusted recipe (loaded file, live snapshot) before any kernel sees it: every node,
 * every leaf a 3D solid (mesh arrays well-formed), plus `validateLeaf` (the persistence entity check).
 * @failure malformed node / leaf / depth > MAX_RECIPE_DEPTH -> error text, else null
 */
export function validateShapeRecipe(
  value: unknown,
  validateLeaf: LeafValidator = () => null,
): string | null {
  return check(value, 0, validateLeaf);
}
