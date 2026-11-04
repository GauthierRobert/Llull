/**
 * Scene plan of a glTF file for import_gltf: walks the node tree of the default scene composing transforms, bakes plain mesh nodes into
 * world-space bodies, and turns EXT_mesh_gpu_instancing nodes into one prototype (component) per mesh plus one placement per TRS.
 * Every count and index is bounded; a violation throws a `GltfError` (caught in the command).
 */

import { MAX_GLTF_DEPTH, MAX_GLTF_INSTANCES, MAX_GLTF_NODES, MAX_IMPORT_BODIES, MAX_IMPORT_TRIANGLES } from '../limits';
import type { Vec3 } from '../../model/types';
import { GltfAccessors } from './gltfAccessors';
import { GltfBuffers, SUPPORTED_EXTENSION, type GltfFile } from './gltfContainer';
import { GltfError, type Json, indexOf, isRecord, listAt, numbersOf, recordAt } from './gltfJson';
import { IDENTITY, type Mat4, decompose, determinant3, fromTrs, multiply, transformPoint } from './gltfMath';

/** Colour of a primitive without a material colour. */
const DEFAULT_COLOR = '#9aa5b1';

/** One triangle mesh to create: indexed, in the frame of its owner (world for a body, the prototype frame for a component child). */
export interface PlannedBody {
  readonly name: string;
  readonly color: string;
  readonly positions: number[];
  readonly indices: number[];
}

/** A prototype shared by every instance of one glTF mesh. */
export interface PlannedComponent {
  readonly name: string;
  readonly bodies: readonly PlannedBody[];
}

/** What the file places, in scene order. */
export type Placement =
  | { readonly kind: 'body'; readonly body: PlannedBody }
  | {
      readonly kind: 'instance';
      readonly component: PlannedComponent;
      readonly position: Vec3;
      readonly rotation: Vec3;
      readonly scale: Vec3;
    };

export interface ScenePlan {
  readonly placements: readonly Placement[];
  readonly components: readonly PlannedComponent[];
  readonly triangleCount: number;
  /** Primitives that are not triangle lists (points, lines, strips, fans) and instances that cannot be placed (zero scale). */
  readonly skippedPrimitives: number;
  readonly skippedInstances: number;
}

/** A primitive read from the file, in the mesh's own frame. */
interface Primitive {
  readonly color: string;
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
}

const linearToSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const hex2 = (c: number): string =>
  Math.round(Math.max(0, Math.min(1, linearToSrgb(Math.max(0, c)))) * 255)
    .toString(16)
    .padStart(2, '0');

/** `#rrggbb` of a material's linear baseColorFactor (glTF default: white), else the default colour. */
function materialColor(materials: readonly unknown[], index: unknown): string {
  if (index === undefined) return DEFAULT_COLOR;
  const material = materials[indexOf(index, materials.length, 'primitive.material')];
  if (!isRecord(material)) return DEFAULT_COLOR;
  const factor = recordAt(material, 'pbrMetallicRoughness', 'material')?.['baseColorFactor'];
  const [r, g, b] = factor === undefined ? [1, 1, 1] : numbersOf(factor, 4, 'baseColorFactor');
  return `#${hex2(r ?? 1)}${hex2(g ?? 1)}${hex2(b ?? 1)}`;
}

/** Local matrix of a node: `matrix`, else T · R · S from its optional translation / rotation / scale. */
function localMatrix(node: Json, where: string): Mat4 {
  if (node['matrix'] !== undefined) return numbersOf(node['matrix'], 16, `${where}.matrix`);
  const t = node['translation'] === undefined ? [0, 0, 0] : numbersOf(node['translation'], 3, `${where}.translation`);
  const q = node['rotation'] === undefined ? [0, 0, 0, 1] : numbersOf(node['rotation'], 4, `${where}.rotation`);
  const s = node['scale'] === undefined ? [1, 1, 1] : numbersOf(node['scale'], 3, `${where}.scale`);
  return fromTrs(t, q, s);
}

/** The instances of an EXT_mesh_gpu_instancing node: their count and the T · R · S matrix of each (built on demand). */
interface NodeInstances {
  readonly count: number;
  matrix(i: number): Mat4;
}

/** Instances of an EXT_mesh_gpu_instancing node, or null when the node has no instancing data. */
function instanceMatrices(node: Json, accessors: GltfAccessors, where: string): NodeInstances | null {
  const extension = recordAt(recordAt(node, 'extensions', where) ?? {}, SUPPORTED_EXTENSION, `${where}.extensions`);
  if (extension === undefined) return null;
  const attributes = recordAt(extension, 'attributes', `${where}.${SUPPORTED_EXTENSION}`) ?? {};
  const read = (name: string, type: 'VEC3' | 'VEC4'): Float64Array | undefined =>
    attributes[name] === undefined ? undefined : accessors.floats(indexOf(attributes[name], accessors.length, `${where} ${name}`), type);
  const translation = read('TRANSLATION', 'VEC3');
  const rotation = read('ROTATION', 'VEC4');
  const scale = read('SCALE', 'VEC3');
  const counts = [translation && translation.length / 3, rotation && rotation.length / 4, scale && scale.length / 3].filter(
    (count): count is number => count !== undefined,
  );
  const count = counts[0] ?? 0;
  if (counts.length === 0 || counts.some((c) => c !== count))
    throw new GltfError('GLTF_MALFORMED', `${where}: TRANSLATION / ROTATION / SCALE accessors must exist and have the same count`);
  if (count > MAX_GLTF_INSTANCES) throw new GltfError('GLTF_LIMIT', `${where} has ${count} instances (limit ${MAX_GLTF_INSTANCES})`);
  return {
    count,
    matrix: (i) =>
      fromTrs(
        translation ? Array.from(translation.subarray(i * 3, i * 3 + 3)) : [0, 0, 0],
        rotation ? Array.from(rotation.subarray(i * 4, i * 4 + 4)) : [0, 0, 0, 1],
        scale ? Array.from(scale.subarray(i * 3, i * 3 + 3)) : [1, 1, 1],
      ),
  };
}

/** Plans the import of `file`: `scale` multiplies every length (glTF is in metres). */
export function planGltfScene(file: GltfFile, scale: number): ScenePlan {
  const { json } = file;
  const accessors = new GltfAccessors(json, new GltfBuffers(json, file.bin));
  const nodes = listAt(json, 'nodes', 'glTF');
  const meshes = listAt(json, 'meshes', 'glTF');
  const materials = listAt(json, 'materials', 'glTF');
  const primitiveCache = new Map<number, { primitives: Primitive[]; skipped: number }>();
  const componentCache = new Map<number, PlannedComponent | null>();
  const placements: Placement[] = [];
  const components: PlannedComponent[] = [];
  let triangleCount = 0;
  let skippedPrimitives = 0;
  let skippedInstances = 0;
  let visited = 0;
  let bodies = 0;

  const readMesh = (meshIndex: number): { primitives: Primitive[]; skipped: number } => {
    const known = primitiveCache.get(meshIndex);
    if (known !== undefined) return known;
    const mesh = meshes[meshIndex];
    if (!isRecord(mesh)) throw new GltfError('GLTF_MALFORMED', `meshes[${meshIndex}] must be an object`);
    const primitives: Primitive[] = [];
    let skipped = 0;
    for (const [p, primitive] of listAt(mesh, 'primitives', `meshes[${meshIndex}]`).entries()) {
      const where = `meshes[${meshIndex}].primitives[${p}]`;
      if (!isRecord(primitive)) throw new GltfError('GLTF_MALFORMED', `${where} must be an object`);
      if (primitive['mode'] !== undefined && primitive['mode'] !== 4) {
        skipped++;
        continue;
      }
      const attributes = recordAt(primitive, 'attributes', where) ?? {};
      if (attributes['POSITION'] === undefined) throw new GltfError('GLTF_MALFORMED', `${where} has no POSITION attribute`);
      const positions = accessors.floats(indexOf(attributes['POSITION'], accessors.length, `${where} POSITION`), 'VEC3');
      const vertexCount = positions.length / 3;
      const indices =
        primitive['indices'] === undefined
          ? Uint32Array.from({ length: vertexCount }, (_, i) => i)
          : accessors.indices(indexOf(primitive['indices'], accessors.length, `${where}.indices`));
      if (indices.length % 3 !== 0)
        throw new GltfError('GLTF_BAD_ACCESSOR', `${where} has ${indices.length} indices (not a multiple of 3)`);
      for (const index of indices)
        if (index >= vertexCount) throw new GltfError('GLTF_BAD_ACCESSOR', `${where} index ${index} is outside 0..${vertexCount - 1}`);
      if (indices.length > 0) primitives.push({ color: materialColor(materials, primitive['material']), positions, indices });
    }
    const read = { primitives, skipped };
    primitiveCache.set(meshIndex, read);
    return read;
  };

  const countTriangles = (n: number): void => {
    triangleCount += n;
    if (triangleCount > MAX_IMPORT_TRIANGLES)
      throw new GltfError('GLTF_LIMIT', `more than MAX_IMPORT_TRIANGLES (${MAX_IMPORT_TRIANGLES}) triangles`);
  };

  /** A primitive baked through `m` (winding flipped when `m` mirrors). */
  const bake = (name: string, primitive: Primitive, m: Mat4): PlannedBody => {
    const positions: number[] = [];
    for (let i = 0; i < primitive.positions.length; i += 3)
      positions.push(...transformPoint(m, primitive.positions[i] ?? 0, primitive.positions[i + 1] ?? 0, primitive.positions[i + 2] ?? 0));
    const indices = Array.from(primitive.indices);
    if (determinant3(m) < 0)
      for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2] as number, indices[i + 1] as number];
    return { name, color: primitive.color, positions, indices };
  };

  const placeBodies = (name: string, meshIndex: number, m: Mat4): void => {
    const { primitives, skipped } = readMesh(meshIndex);
    skippedPrimitives += skipped;
    for (const [k, primitive] of primitives.entries()) {
      bodies++;
      if (bodies > MAX_IMPORT_BODIES) throw new GltfError('GLTF_LIMIT', `more than MAX_IMPORT_BODIES (${MAX_IMPORT_BODIES}) mesh bodies`);
      countTriangles(primitive.indices.length / 3);
      placements.push({ kind: 'body', body: bake(primitives.length > 1 ? `${name}/${k}` : name, primitive, m) });
    }
  };

  const componentOf = (name: string, meshIndex: number): PlannedComponent | null => {
    if (componentCache.has(meshIndex)) return componentCache.get(meshIndex) ?? null;
    const { primitives, skipped } = readMesh(meshIndex);
    skippedPrimitives += skipped;
    let component: PlannedComponent | null = null;
    if (primitives.length > 0) {
      for (const primitive of primitives) countTriangles(primitive.indices.length / 3);
      component = {
        name,
        bodies: primitives.map((primitive, k) => bake(primitives.length > 1 ? `${name}/${k}` : name, primitive, IDENTITY)),
      };
      components.push(component);
    }
    componentCache.set(meshIndex, component);
    return component;
  };

  const visit = (nodeIndex: number, parent: Mat4, depth: number): void => {
    visited++;
    if (visited > MAX_GLTF_NODES) throw new GltfError('GLTF_LIMIT', `the scene expands to more than ${MAX_GLTF_NODES} nodes`);
    if (depth > MAX_GLTF_DEPTH) throw new GltfError('GLTF_LIMIT', `node tree deeper than ${MAX_GLTF_DEPTH} levels (or a cycle)`);
    const where = `nodes[${nodeIndex}]`;
    const node = nodes[nodeIndex];
    if (!isRecord(node)) throw new GltfError('GLTF_MALFORMED', `${where} must be an object`);
    const world = multiply(parent, localMatrix(node, where));
    if (node['mesh'] !== undefined) {
      const meshIndex = indexOf(node['mesh'], meshes.length, `${where}.mesh`);
      const meshName = (meshes[meshIndex] as Json)['name'];
      const name =
        typeof node['name'] === 'string' && node['name'] !== ''
          ? node['name']
          : typeof meshName === 'string' && meshName !== ''
            ? meshName
            : `mesh ${meshIndex}`;
      const instances = instanceMatrices(node, accessors, where);
      if (instances === null) placeBodies(name, meshIndex, world);
      else {
        const component = componentOf(name, meshIndex);
        for (let i = 0; component !== null && i < instances.count; i++) {
          if (placements.length >= MAX_GLTF_INSTANCES)
            throw new GltfError('GLTF_LIMIT', `more than ${MAX_GLTF_INSTANCES} placed instances / bodies`);
          const placed = decompose(multiply(world, instances.matrix(i)));
          if (placed === 'degenerate') skippedInstances++;
          else if (typeof placed === 'string') placeBodies(name, meshIndex, multiply(world, instances.matrix(i)));
          else placements.push({ kind: 'instance', component, ...placed });
        }
      }
    }
    for (const child of listAt(node, 'children', where)) visit(indexOf(child, nodes.length, `${where}.children[]`), world, depth + 1);
  };

  const sceneRoots = (): number[] => {
    const scenes = listAt(json, 'scenes', 'glTF');
    if (scenes.length > 0) {
      const scene = scenes[json['scene'] === undefined ? 0 : indexOf(json['scene'], scenes.length, 'glTF.scene')];
      if (!isRecord(scene)) throw new GltfError('GLTF_MALFORMED', 'the default scene must be an object');
      return listAt(scene, 'nodes', 'scene').map((n) => indexOf(n, nodes.length, 'scene.nodes[]'));
    }
    const children = new Set(nodes.flatMap((node) => (isRecord(node) ? listAt(node, 'children', 'node') : [])));
    return nodes.flatMap((_, i) => (children.has(i) ? [] : [i]));
  };

  const root = scale === 1 ? IDENTITY : fromTrs([0, 0, 0], [0, 0, 0, 1], [scale, scale, scale]);
  for (const nodeIndex of sceneRoots()) visit(nodeIndex, root, 0);
  return { placements, components, triangleCount, skippedPrimitives, skippedInstances };
}
