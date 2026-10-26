/**
 * Shape recipe: the serializable construction tree of a solid (primitive leaves, boolean / fillet / chamfer / shell / placement / scale
 * nodes). The kernel evaluates it to an exact, kernel-owned shape (`ShapeHandle`); the document stores the recipe on result `mesh` entities
 * (`brep`), never the shape.
 * @invariant `recipeKey` covers every input a kernel reads; presentation fields (id, name, color, layer, tags, material) never reach it, so
 *   a recolored operand reuses the cached shape
 */

import { type Entity, type MeshSolidEntity, type ShapeRecipe, type Vec3, SOLID_KINDS } from '../model/types';
import { SHEET_KINDS } from '../model/curveKinds';
import { PROFILE_FACTOR_MAX, PROFILE_FACTOR_MIN } from '../model/blendTypes';
import { hashText } from '../lib/hash';
import { isRecord } from '../lib/isRecord';
import { isFiniteNumber } from '../lib/isFiniteNumber';
import { isVec3 } from '../lib/vec3';
import { featureError, featureKeyText } from './featureRecipe';
import { loopsProblem, surfaceDataProblem } from './surfaceWire';
import { faceOpParamsOf, faceOpProblem } from './faceOpRecipe';
import { deformKeyText, deformProblem } from './deform/recipe';
import { embossKeyText, embossProblem } from './embossRecipe';

const PRESENTATION_FIELDS = new Set(['id', 'name', 'color', 'layerId', 'tags', 'materialId', 'patternSourceId']);

/** Stable key of an entity's geometry (presentation fields dropped, keys sorted). */
export function geometryKey(entity: Entity): string {
  const kept = Object.entries(entity)
    .filter(([key]) => !PRESENTATION_FIELDS.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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
      return `${recipe.op}(${recipeKey(recipe.source)},${recipe.size}${recipe.sizeEnd === undefined ? '' : `>${recipe.sizeEnd}`},[${recipe.edges.join(',')}]${recipe.radii === undefined ? '' : `,radii${JSON.stringify(recipe.radii)}`}${recipe.faces === undefined ? '' : `,sided[${recipe.faces.join(',')}]${recipe.size2 === undefined ? '' : `,d2=${recipe.size2}`}${recipe.angleDeg === undefined ? '' : `,a=${recipe.angleDeg}`}`}${recipe.profile === undefined ? '' : `,profile${JSON.stringify(recipe.profile)}`}${recipe.corners === undefined ? '' : `,corners${JSON.stringify(recipe.corners)}`})`;
    case 'blend':
      return `blend(${recipe.sources.map(recipeKey).join(',')},${recipe.radius}${recipe.joints === undefined ? '' : `,joints${JSON.stringify(recipe.joints)}`})`;
    case 'shell':
      return `shell(${recipeKey(recipe.source)},${recipe.thickness}${recipe.openNear === undefined ? '' : `,open[${recipe.openNear.map((point) => point.join(',')).join(';')}]`})`;
    case 'place':
      return `place(${recipeKey(recipe.source)},${recipe.position.join(',')},${recipe.rotation.join(',')})`;
    case 'scale':
      return `scale(${recipeKey(recipe.source)},${recipe.factor})`;
    case 'brep':
      return `brep(${recipe.blob})`;
    case 'feature':
      return featureKeyText(recipe, recipeKey(recipe.source));
    case 'faceSlab':
      return `faceSlab(${recipe.surface.type}:${recipe.surface.data.join(',')}|${recipe.loops.join(',')}|${recipe.from},${recipe.to}|${recipe.direction.join(',')}|${recipe.tolerance})`;
    case 'sheetSolid':
      return `sheetSolid(${JSON.stringify([recipe.faces, recipe.bore, recipe.tolerance, recipe.caps, recipe.position, recipe.rotation, recipe.name, recipe.pipeShell])})`;
    case 'deform':
      return deformKeyText(recipe, recipeKey(recipe.source));
    case 'emboss':
      return embossKeyText(recipe, recipeKey(recipe.source));
    case 'faceOp':
      return `faceOp(${recipeKey(recipe.source)},${JSON.stringify(faceOpParamsOf(recipe))})`;
    case 'faceBlend':
      return `faceBlend(${recipeKey(recipe.source)},[${recipe.facesA.join(',')}],[${recipe.facesB.join(',')}],${recipe.radius}${recipe.profile === undefined ? '' : `,profile${JSON.stringify(recipe.profile)}`})`;
    case 'fullRound':
      return `fullRound(${recipeKey(recipe.source)},[${recipe.side1.join(',')}],[${recipe.center.join(',')}],[${recipe.side2.join(',')}])`;
  }
}

const isZero = (v: Vec3): boolean => v.every((component) => component === 0);

/** The recipe of a mesh entity's B-rep, placed by the entity's own position/rotation. */
function placedBrep(entity: MeshSolidEntity, brep: ShapeRecipe): ShapeRecipe {
  if (isZero(entity.position) && isZero(entity.rotation)) return brep;
  return { op: 'place', source: brep, position: entity.position, rotation: entity.rotation };
}

/** Entities are immutable (commands are pure): one recipe object per entity object keeps `recipeKey`'s memo effective. */
const recipes = new WeakMap<Entity, ShapeRecipe>();
const meshRecipes = new WeakMap<Entity, ShapeRecipe>();

/**
 * Exact recipe of a 3D solid entity: a kernel result (`mesh` with `brep`) resumes its construction
 * tree; any other solid is a leaf.
 */
export function recipeOf(entity: Entity): ShapeRecipe {
  const cached = recipes.get(entity);
  if (cached !== undefined) return cached;
  const recipe: ShapeRecipe =
    entity.kind === 'mesh' && entity.brep !== undefined ? placedBrep(entity, entity.brep) : { op: 'solid', entity };
  recipes.set(entity, recipe);
  return recipe;
}

/**
 * Leaf recipe of the entity's own triangles (a `mesh` entity's `brep` dropped): the fallback when a
 * kernel cannot rebuild the exact tree (e.g. a fillet recipe loaded under a kernel without fillets).
 */
export function meshRecipeOf(entity: Entity): ShapeRecipe | null {
  if (entity.kind !== 'mesh' || entity.brep === undefined) return null;
  const cached = meshRecipes.get(entity);
  if (cached !== undefined) return cached;
  const plain: MeshSolidEntity = { ...entity };
  delete plain.brep;
  const recipe: ShapeRecipe = { op: 'solid', entity: plain };
  meshRecipes.set(entity, recipe);
  return recipe;
}

/** Max nesting accepted from a loaded document (a deeper tree is rejected, not evaluated). */
export const MAX_RECIPE_DEPTH = 256;

/** Checks one leaf entity of an untrusted recipe; returns an error text or null. */
export type LeafValidator = (entity: Record<string, unknown>) => string | null;

const isIndexArray = (v: unknown, vertexCount: number): boolean =>
  Array.isArray(v) && v.every((i) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < vertexCount);

/** Absent, or a list of finite [x, y, z] points. */
const isPointList = (v: unknown): boolean =>
  v === undefined || (Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 3 && p.every(isFiniteNumber)));

/** A leaf must be a 3D solid (not an instance); a mesh leaf needs well-formed triangle arrays. */
function leafError(entity: Record<string, unknown>, validateLeaf: LeafValidator): string | null {
  const kind = entity['kind'];
  if (typeof kind !== 'string' || !([...SOLID_KINDS, ...SHEET_KINDS] as readonly string[]).includes(kind))
    return `solid leaf has kind '${String(kind)}', expected a 3D solid kind or a surface sheet`;
  if (kind === 'mesh') {
    const mesh = entity['mesh'];
    const positions = isRecord(mesh) ? mesh['positions'] : undefined;
    if (!Array.isArray(positions) || positions.length % 3 !== 0 || !positions.every(isFiniteNumber))
      return 'mesh leaf positions must be finite xyz triples';
    if (!isIndexArray(isRecord(mesh) ? mesh['indices'] : undefined, positions.length / 3))
      return 'mesh leaf indices must be integers within the vertex range';
  }
  return validateLeaf(entity);
}

const isNumberList = (v: unknown): boolean => Array.isArray(v) && v.every(isFiniteNumber);

/** Checks a `faceSlab` node; returns an error text or null. */
function slabError(node: Record<string, unknown>): string | null {
  const surface = node['surface'];
  if (!isRecord(surface) || !['bspline', 'plane', 'cylinder', 'cone'].includes(String(surface['type'])))
    return 'faceSlab: surface.type must be bspline, plane, cylinder or cone';
  if (!isNumberList(surface['data'])) return 'faceSlab: surface.data must be a list of finite numbers';
  if (!isNumberList(node['loops'])) return 'faceSlab: loops must be a list of finite numbers';
  const layout = surfaceDataProblem(surface['type'] as 'plane', surface['data'] as number[]) ?? loopsProblem(node['loops'] as number[]);
  if (layout !== null) return `faceSlab: ${layout}`;
  const { from, to } = node;
  if (!isFiniteNumber(from) || !isFiniteNumber(to) || !(to > from)) return 'faceSlab: from and to must be finite with to > from';
  if (!isVec3(node['direction'])) return 'faceSlab: direction must be a finite Vec3';
  const tolerance = node['tolerance'];
  return isFiniteNumber(tolerance) && tolerance > 0 ? null : 'faceSlab: tolerance must be > 0';
}

const positiveNumber = (value: unknown): boolean => isFiniteNumber(value) && value > 0;

/** Why a face list of an untrusted `sheetSolid` node is unusable (a non-empty list of consistent B-spline surface descriptions), or null. */
function sheetFacesError(faces: unknown, field: string): string | null {
  if (!Array.isArray(faces) || faces.length === 0) return `sheetSolid: ${field} must be a non-empty list of encoded surfaces`;
  for (const face of faces) {
    const problem = isNumberList(face) ? surfaceDataProblem('bspline', face as number[]) : 'must be a list of finite numbers';
    if (problem !== null) return `sheetSolid: ${field} surface ${problem}`;
  }
  return null;
}

/** Why the `pipeShell` attempt of an untrusted `sheetSolid` node is unusable, or null. */
function pipeShellError(shell: unknown): string | null {
  if (!isRecord(shell)) return 'sheetSolid: pipeShell must be an object';
  if (!isNumberList(shell['spine']) || !isNumberList(shell['probes']))
    return 'sheetSolid: pipeShell spine and probes must be lists of finite numbers';
  if (shell['chain'] !== undefined && !isNumberList(shell['chain'])) return 'sheetSolid: pipeShell chain must be a list of finite numbers';
  if (shell['law'] !== undefined && !isNumberList(shell['law'])) return 'sheetSolid: pipeShell law must be a list of finite numbers';
  if (!Number.isInteger(shell['mode']) || !Number.isInteger(shell['transition']))
    return 'sheetSolid: pipeShell mode and transition must be integers';
  if (!isVec3(shell['direction'])) return 'sheetSolid: pipeShell direction must be a finite Vec3';
  return positiveNumber(shell['tolerance']) && positiveNumber(shell['check'])
    ? null
    : 'sheetSolid: pipeShell tolerance and check must be > 0';
}

/** Checks a `sheetSolid` node; returns an error text or null. */
function sheetSolidError(node: Record<string, unknown>): string | null {
  const facesProblem =
    sheetFacesError(node['faces'], 'faces') ?? (node['bore'] === undefined ? null : sheetFacesError(node['bore'], 'bore'));
  if (facesProblem !== null) return facesProblem;
  if (!positiveNumber(node['tolerance'])) return 'sheetSolid: tolerance must be > 0';
  if (node['caps'] !== 0 && node['caps'] !== 1 && node['caps'] !== 2) return 'sheetSolid: caps must be 0, 1 or 2';
  if (!isVec3(node['position']) || !isVec3(node['rotation'])) return 'sheetSolid: position and rotation must be finite Vec3';
  if (node['name'] !== undefined && typeof node['name'] !== 'string') return 'sheetSolid: name must be a string';
  return node['pipeShell'] === undefined ? null : pipeShellError(node['pipeShell']);
}

/** Why the `radii` of an untrusted fillet node are unusable (a chamfer has none; one law per edge; sizes > 0; interior `t` increasing in (0, 1)), or null. */
function radiiError(node: Record<string, unknown>, edgeCount: number): string | null {
  const radii = node['radii'];
  if (radii === undefined) return null;
  if (node['op'] !== 'fillet') return 'chamfer: radii apply to fillets only';
  if (!Array.isArray(radii) || radii.length === 0 || radii.length !== edgeCount) return 'fillet: radii needs one entry per listed edge';
  for (const law of radii) {
    if (!isRecord(law) || !positiveNumber(law['size'])) return 'fillet: every radii entry needs size > 0';
    if (law['sizeEnd'] !== undefined && !positiveNumber(law['sizeEnd'])) return 'fillet: radii sizeEnd must be > 0';
    if (law['interpolation'] !== undefined && law['interpolation'] !== 'smooth' && law['interpolation'] !== 'linear')
      return 'fillet: radii interpolation must be "smooth" or "linear"';
    if (law['size2'] !== undefined && !positiveNumber(law['size2'])) return 'fillet: radii size2 must be > 0';
    const sideFace = law['sideFace'];
    if (
      (law['size2'] === undefined) !== (sideFace === undefined) ||
      (sideFace !== undefined && !(Number.isInteger(sideFace) && (sideFace as number) >= 0))
    )
      return 'fillet: radii size2 and sideFace go together (sideFace a non-negative face index)';
    const sizes = law['sizes'];
    if (sizes === undefined) continue;
    if (!Array.isArray(sizes)) return 'fillet: radii sizes must be a list of { t, size }';
    let previous = 0;
    for (const point of sizes) {
      const t = isRecord(point) ? point['t'] : undefined;
      if (!isRecord(point) || !isFiniteNumber(t) || !(t > previous) || !(t < 1) || !positiveNumber(point['size']))
        return 'fillet: radii sizes need t strictly increasing inside (0, 1) and size > 0';
      previous = t;
    }
  }
  return null;
}

/** Why the `profile` of an untrusted fillet node is unusable (type circular / conic / curvature, rho / shape inside 0.05..0.95), or null. */
function profileError(node: Record<string, unknown>): string | null {
  const profile = node['profile'];
  if (profile === undefined) return null;
  if (node['op'] !== 'fillet') return 'chamfer: profile applies to fillets only';
  if (!isRecord(profile)) return 'fillet: profile must be an object';
  const factor = (value: unknown): boolean => isFiniteNumber(value) && value >= PROFILE_FACTOR_MIN && value <= PROFILE_FACTOR_MAX;
  switch (profile['type']) {
    case 'circular':
      return null;
    case 'conic':
      return factor(profile['rho']) ? null : 'fillet: profile conic needs rho inside 0.05..0.95';
    case 'curvature':
      return factor(profile['shape']) ? null : 'fillet: profile curvature needs shape inside 0.05..0.95';
    default:
      return 'fillet: profile type must be circular, conic or curvature';
  }
}

/** Why the `corners` of an untrusted fillet node are unusable (setback corners with a vertex point and a positive distance for edges), or null. */
function cornersError(node: Record<string, unknown>): string | null {
  const corners = node['corners'];
  if (corners === undefined) return null;
  if (node['op'] !== 'fillet') return 'chamfer: corners apply to fillets only';
  if (!Array.isArray(corners)) return 'fillet: corners must be a list';
  for (const corner of corners) {
    const distances = isRecord(corner) ? corner['distances'] : undefined;
    if (!isRecord(corner) || corner['type'] !== 'setback' || !isVec3(corner['vertex']) || !Array.isArray(distances) || distances.length < 3)
      return 'fillet: a corner needs type "setback", a vertex [x, y, z] and distances for 3 or more edges';
    for (const entry of distances)
      if (!isRecord(entry) || !Number.isInteger(entry['edge']) || (entry['edge'] as number) < 0 || !positiveNumber(entry['distance']))
        return 'fillet: corner distances need a non-negative edge index and a distance > 0';
  }
  return null;
}

/** Why a face-set field of an untrusted face-blend node is unusable (a non-empty list of non-negative face indices), or null. */
function faceSetError(node: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const set = node[field];
    if (!Array.isArray(set) || set.length === 0 || !set.every((face) => Number.isInteger(face) && (face as number) >= 0))
      return `${String(node['op'])}: ${field} must be a non-empty list of non-negative face indices`;
  }
  return null;
}

const radiusProblem = (node: Record<string, unknown>): string | null =>
  positiveNumber(node['radius']) ? null : `${String(node['op'])}: radius must be > 0`;

/** Why the sided-chamfer fields of an untrusted chamfer node are unusable (faces per edge with exactly one of size2 / angleDeg in (0, 90)), or null. */
function sidedChamferError(node: Record<string, unknown>, edgeCount: number): string | null {
  const { faces, size2, angleDeg } = node;
  if (node['op'] === 'chamfer' && node['sizeEnd'] !== undefined && faces !== undefined)
    return 'chamfer: sizeEnd (a variable distance) is symmetric and takes no faces';
  if (faces === undefined) return size2 === undefined && angleDeg === undefined ? null : 'chamfer: size2 / angleDeg need faces';
  if (node['op'] !== 'chamfer') return 'fillet: faces apply to chamfers only';
  if (!Array.isArray(faces) || faces.length !== edgeCount || !faces.every((face) => Number.isInteger(face) && (face as number) >= 0))
    return 'chamfer: faces needs one non-negative face index per listed edge';
  if ((size2 === undefined) === (angleDeg === undefined)) return 'chamfer: give exactly one of size2 or angleDeg with faces';
  if (size2 !== undefined && !positiveNumber(size2)) return 'chamfer: size2 must be > 0';
  if (angleDeg !== undefined && !(isFiniteNumber(angleDeg) && angleDeg > 0 && angleDeg < 90))
    return 'chamfer: angleDeg must be inside (0, 90)';
  return null;
}

function nodeError(node: Record<string, unknown>, depth: number, validateLeaf: LeafValidator): string | null {
  const child = (value: unknown): string | null => check(value, depth + 1, validateLeaf);
  switch (node['op']) {
    case 'solid':
      return isRecord(node['entity']) ? leafError(node['entity'], validateLeaf) : 'solid leaf needs an entity';
    case 'boolean':
      if (!['union', 'subtract', 'intersect'].includes(String(node['boolean']))) return `unknown boolean '${String(node['boolean'])}'`;
      return child(node['a']) ?? child(node['b']);
    case 'fillet':
    case 'chamfer': {
      const edges = node['edges'];
      if (!Array.isArray(edges) || !edges.every((e) => Number.isInteger(e) && (e as number) >= 0))
        return `${String(node['op'])}: edges must be non-negative integers`;
      const radiiProblem =
        radiiError(node, edges.length) ?? sidedChamferError(node, edges.length) ?? profileError(node) ?? cornersError(node);
      if (radiiProblem !== null) return radiiProblem;
      if (node['radii'] === undefined && (!isFiniteNumber(node['size']) || node['size'] <= 0))
        return `${String(node['op'])}: size must be > 0`;
      const sizeEnd = node['sizeEnd'];
      if (sizeEnd !== undefined && (!isFiniteNumber(sizeEnd) || sizeEnd <= 0)) return `${String(node['op'])}: sizeEnd must be > 0`;
      if (!isPointList(node['near'])) return `${String(node['op'])}: near must be a list of finite [x, y, z] points`;
      return child(node['source']);
    }
    case 'blend': {
      const sources = node['sources'];
      if (!Array.isArray(sources) || sources.length < 2) return 'blend: needs >= 2 sources';
      if (!isFiniteNumber(node['radius']) || node['radius'] <= 0) return 'blend: radius must be > 0';
      const joints = node['joints'];
      if (
        joints !== undefined &&
        (!Array.isArray(joints) ||
          !joints.every((joint) => isRecord(joint) && isVec3(joint['near']) && isFiniteNumber(joint['radius']) && joint['radius'] > 0))
      )
        return 'blend: joints must be a list of { near: [x, y, z], radius > 0 }';
      for (const source of sources) {
        const problem = child(source);
        if (problem !== null) return problem;
      }
      return null;
    }
    case 'shell':
      if (!isFiniteNumber(node['thickness']) || node['thickness'] <= 0) return 'shell: thickness must be > 0';
      if (!isPointList(node['openNear'])) return 'shell: openNear must be a list of finite [x, y, z] points';
      return child(node['source']);
    case 'place':
      if (!isVec3(node['position']) || !isVec3(node['rotation'])) return 'place: position and rotation must be finite Vec3';
      return child(node['source']);
    case 'faceOp':
      return faceOpProblem(node) ?? child(node['source']);
    case 'faceBlend':
      return (
        faceSetError(node, ['facesA', 'facesB']) ?? radiusProblem(node) ?? profileError({ ...node, op: 'fillet' }) ?? child(node['source'])
      );
    case 'fullRound':
      return faceSetError(node, ['side1', 'center', 'side2']) ?? child(node['source']);
    case 'emboss':
      return embossProblem(node) ?? child(node['source']);
    case 'deform':
      return deformProblem(node) ?? child(node['source']);
    case 'scale':
      if (!isFiniteNumber(node['factor']) || node['factor'] <= 0) return 'scale: factor must be > 0';
      return child(node['source']);
    case 'brep':
      if (typeof node['blob'] !== 'string' || !/^[0-9a-f]{64}$/.test(node['blob']))
        return 'brep: blob must be a lowercase sha256 hex string';
      if (node['format'] !== 'occt-brep-v1') return `brep: unsupported format '${String(node['format'])}'`;
      return node['label'] === undefined || typeof node['label'] === 'string' ? null : 'brep: label must be a string';
    case 'feature':
      return featureError(node) ?? child(node['source']);
    case 'faceSlab':
      return slabError(node);
    case 'sheetSolid':
      return sheetSolidError(node);
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
export function validateShapeRecipe(value: unknown, validateLeaf: LeafValidator = () => null): string | null {
  return check(value, 0, validateLeaf);
}
