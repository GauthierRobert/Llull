/**
 * Geometry of the path-traced scene (RV1 §5b): every visible 3D entity as instances of shared meshes. A solid is tessellated once per
 * (shape, uv scale) in its own frame and placed by a 3x4 affine; component instances and instance-array members reuse their children's
 * meshes, so a 4,000,000-member array costs one mesh plus one row per member (traced without expansion).
 * @invariant visible = a 3D entity or a NURBS sheet on a visible layer (`planScene` plus sheets); a mesh without stored UVs gets box-projected UVs, `uvScale` units a tile
 * @invariant collection stops at `limits` (overBudget; the caller refuses the scene) before a buffer grows past them; the ground row is never capped;
 *   nested component instances recurse at most MAX_NESTING deep and pass on the material / appearance they inherited
 */

import type { CadDocument, Component, Entity, InstanceEntity, MeshData, Vec3 } from '../../../model/types';
import { is3D } from '../../../model/types';
import { resolveAppearance } from '../../../model/appearance';
import { isSheet } from '../../../model/curveKinds';
import { DEFAULT_UV_SCALE, meshNormals, meshUvs } from '../../../geometry/meshUvs';
import { localTriangles } from '../../../geometry/solidTriangles';
import { sheetTriangles } from '../../../geometry/nurbsSurface';
import { faceColorMesh, faceColorsOf, faceColorTriangles } from '../../../geometry/faceColors';
import { boxUv } from '../../../geometry/finishMaps';
import { facetNormal } from '../../../geometry/tessellation';
import { decodedTransforms } from '../../../geometry/instanceArrays';
import { INSTANCE_STRIDE } from '../../../model/instanceArray';
import { PATH_TRACE_INSTANCE_STRIDE } from '../../../model/pathTrace';
import type { Triangle } from '../../../geometry/triangles';
import { creasedNormals, DEFAULT_METALNESS, DEFAULT_ROUGHNESS } from '../../exchange/gltfScene';
import { exactShapeKeyOf } from '../../exchange/gltfPrototypes';
import { type Affine, IDENTITY, compose, placement, transformPoint } from './affine';
import type { MaterialBank, SurfaceBase } from './sceneMaterials';
import { growF32, growU32 } from './growBuffer';

const MAX_NESTING = 16;

/** Ground surface: sRGB #757575 is linear 0.18 (photographic mid grey). */
const GROUND_SURFACE = { color: '#757575', metalness: 0, roughness: 0.9 } as const;
/** Ground half-size in multiples of the scene's largest extent. */
const GROUND_EXTENT = 12;

/** Named guards of one scene: placed parts (instance rows, the ground excepted) and unique triangles. */
export interface SceneLimits {
  readonly maxInstances: number;
  readonly maxTriangles: number;
}

/** One drawable piece of a solid in its own frame: all its triangles, or the ones of one face colour. */
interface Piece {
  readonly mesh: number;
  readonly material: number;
}

export interface SceneGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  readonly meshes: { vertexOffset: number; vertexCount: number; indexOffset: number; indexCount: number }[];
  /** `instanceCount` rows of PATH_TRACE_INSTANCE_STRIDE values. */
  readonly instances: Float64Array;
  readonly instanceCount: number;
  readonly triangles: number;
  /** World bounds of every placed vertex (the ground excluded), null for an empty scene. */
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 } | null;
  /** True when `limits` stopped the collection (too many placed parts or unique triangles). */
  readonly overBudget: boolean;
}

class GeometryBuilder {
  readonly positions = growF32();
  readonly normals = growF32();
  readonly uvs = growF32();
  readonly indices = growU32();
  readonly meshes: SceneGeometry['meshes'] = [];
  private rows = new Float64Array(PATH_TRACE_INSTANCE_STRIDE * 64);
  instanceCount = 0;
  overBudget = false;
  private readonly meshIndex = new Map<string, number>();
  private readonly meshCorners: Vec3[][] = [];
  private readonly pieceCache = new WeakMap<Entity, Map<string, Piece[]>>();
  private min: [number, number, number] = [Infinity, Infinity, Infinity];
  private max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  constructor(
    private readonly doc: CadDocument,
    readonly bank: MaterialBank,
    private readonly limits: SceneLimits,
  ) {}

  /** False (and over budget) when `triangles` more unique triangles pass the limit. */
  private roomFor(triangles: number): boolean {
    if (this.indices.length / 3 + triangles <= this.limits.maxTriangles) return true;
    this.overBudget = true;
    return false;
  }

  /** Mesh of a local triangle soup (creased normals, box UVs), shared by `key`. */
  private soupMesh(key: string, tris: () => Triangle[], uvScale: number): number | null {
    const known = this.meshIndex.get(key);
    if (known !== undefined) return known;
    const soup = tris();
    if (soup.length === 0 || !this.roomFor(soup.length)) return null;
    const normals = creasedNormals(soup);
    const vertexOffset = this.positions.length / 3;
    const corners: Vec3[] = [];
    soup.forEach((tri, t) => {
      const facet = facetNormal(...tri);
      tri.forEach((v, k) => {
        this.positions.push3(v[0], v[1], v[2]);
        this.normals.push3(normals[t * 9 + k * 3] as number, normals[t * 9 + k * 3 + 1] as number, normals[t * 9 + k * 3 + 2] as number);
        const [u, w] = boxUv(v, facet, uvScale);
        this.uvs.push2(u, w);
        this.indices.push(t * 3 + k);
        corners.push(v);
      });
    });
    return this.addMesh(key, vertexOffset, soup.length * 3, soup.length * 3, corners);
  }

  /** Mesh of an indexed `MeshData` with its stored (or derived) normals and UVs. */
  private indexedMesh(key: string, mesh: MeshData, uvScale: number): number | null {
    const known = this.meshIndex.get(key);
    if (known !== undefined) return known;
    if (mesh.indices.length < 3 || !this.roomFor(Math.floor(mesh.indices.length / 3))) return null;
    const vertexOffset = this.positions.length / 3;
    const vertexCount = mesh.positions.length / 3;
    const normals = meshNormals(mesh);
    const uvs = meshUvs(mesh, uvScale);
    const corners: Vec3[] = [];
    for (let v = 0; v < vertexCount; v += 1) {
      const p: Vec3 = [mesh.positions[v * 3] as number, mesh.positions[v * 3 + 1] as number, mesh.positions[v * 3 + 2] as number];
      this.positions.push3(p[0], p[1], p[2]);
      this.normals.push3(normals[v * 3] as number, normals[v * 3 + 1] as number, normals[v * 3 + 2] as number);
      this.uvs.push2(uvs[v * 2] as number, uvs[v * 2 + 1] as number);
      corners.push(p);
    }
    const count = mesh.indices.length - (mesh.indices.length % 3);
    for (let i = 0; i < count; i += 1) this.indices.push(mesh.indices[i] as number);
    return this.addMesh(key, vertexOffset, vertexCount, count, corners);
  }

  private addMesh(key: string, vertexOffset: number, vertexCount: number, indexCount: number, corners: Vec3[]): number {
    const index = this.meshes.length;
    this.meshes.push({ vertexOffset, vertexCount, indexOffset: this.indices.length - indexCount, indexCount });
    this.meshIndex.set(key, index);
    this.meshCorners.push(boxCorners(corners));
    return index;
  }

  /** `arrayColor`: an instance-array member's child without a material takes the array colour (as the viewport draws it). */
  private baseOf(
    entity: Entity,
    inheritedMaterial: string | undefined,
    arrayColor?: string,
  ): SurfaceBase & { readonly materialId?: string } {
    const id = entity.materialId ?? inheritedMaterial;
    const material = id === undefined ? undefined : this.doc.materials[id];
    if (material === undefined) return { color: arrayColor ?? entity.color, metalness: DEFAULT_METALNESS, roughness: DEFAULT_ROUGHNESS };
    return { color: material.color, metalness: material.metalness, roughness: material.roughness, materialId: id as string };
  }

  /** The pieces of a non-instance solid (cached per entity object and inherited look). */
  private piecesOf(
    solid: Entity,
    inheritedMaterial: string | undefined,
    inheritedLook: Entity['appearance'],
    arrayColor?: string,
  ): Piece[] {
    const lookKey = `${inheritedMaterial ?? ''}|${arrayColor ?? ''}|${inheritedLook === undefined ? '' : JSON.stringify(inheritedLook)}`;
    let byLook = this.pieceCache.get(solid);
    const cached = byLook?.get(lookKey);
    if (cached !== undefined) return cached;
    const base = this.baseOf(solid, inheritedMaterial, arrayColor);
    const material = base.materialId === undefined ? undefined : this.doc.materials[base.materialId];
    const own = solid.appearance ?? inheritedLook;
    const appearance = resolveAppearance(own === undefined ? {} : { appearance: own }, material);
    const uvScale = appearance?.uvScale ?? DEFAULT_UV_SCALE;
    const shapeKey = `${exactShapeKeyOf(solid)}|${uvScale}`;
    const pieces: Piece[] = [];
    const faceColors = faceColorsOf(solid);
    if (faceColors !== undefined) {
      const local = localTriangles(solid);
      const groups = new Map<string | undefined, Triangle[]>();
      faceColorTriangles(faceColorMesh(solid), faceColors).forEach((color, t) => {
        const tri = local[t];
        if (tri === undefined) return;
        const group = groups.get(color);
        if (group === undefined) groups.set(color, [tri]);
        else group.push(tri);
      });
      for (const [color, tris] of groups) {
        const mesh = this.soupMesh(`${shapeKey}|face ${color ?? ''}`, () => tris, uvScale);
        const look = color === undefined ? appearance : { ...appearance, baseColor: { value: color } };
        if (mesh !== null) pieces.push({ mesh, material: this.bank.materialOf(color === undefined ? base : { ...base, color }, look) });
      }
    } else {
      const mesh =
        solid.kind === 'mesh' && solid.mesh.uvs !== undefined
          ? this.indexedMesh(shapeKey, solid.mesh, uvScale)
          : this.soupMesh(shapeKey, () => localTriangles(solid), uvScale);
      if (mesh !== null) pieces.push({ mesh, material: this.bank.materialOf(base, appearance) });
    }
    if (byLook === undefined) {
      byLook = new Map();
      this.pieceCache.set(solid, byLook);
    }
    byLook.set(lookKey, pieces);
    return pieces;
  }

  /** `uncapped`: the ground row, which never makes a scene too large. */
  private emit(piece: Piece, m: Affine, uncapped = false): void {
    if (!uncapped && this.instanceCount >= this.limits.maxInstances) {
      this.overBudget = true;
      return;
    }
    const at = this.instanceCount * PATH_TRACE_INSTANCE_STRIDE;
    if (at + PATH_TRACE_INSTANCE_STRIDE > this.rows.length) {
      const grown = new Float64Array(this.rows.length * 2);
      grown.set(this.rows);
      this.rows = grown;
    }
    this.rows[at] = piece.mesh;
    this.rows[at + 1] = piece.material;
    this.rows.set(m, at + 2);
    this.instanceCount += 1;
    for (const corner of this.meshCorners[piece.mesh] ?? []) {
      const p = transformPoint(m, corner);
      for (let axis = 0; axis < 3; axis += 1) {
        this.min[axis] = Math.min(this.min[axis] as number, p[axis] as number);
        this.max[axis] = Math.max(this.max[axis] as number, p[axis] as number);
      }
    }
  }

  /** Places `entity` under `parent` (component children inherit the instance's material and appearance). */
  place(
    entity: Entity,
    parent: Affine,
    inheritedMaterial?: string,
    inheritedLook?: Entity['appearance'],
    depth = 0,
    arrayColor?: string,
  ): void {
    if (this.overBudget) return;
    if (entity.kind === 'instance') {
      const component = this.doc.components[entity.componentId];
      if (component === undefined || depth >= MAX_NESTING) return;
      const m = compose(parent, placement(entity.position, entity.rotation, entity.scale));
      // a nested instance without its own material / appearance passes on what it inherited
      const look = { materialId: entity.materialId ?? inheritedMaterial, appearance: entity.appearance ?? inheritedLook };
      this.placeChildren(component, m, look, depth);
      return;
    }
    if (isSheet(entity)) {
      const key = `sheet|${entity.id}|${exactShapeKeyOf(entity)}`;
      const mesh = this.soupMesh(key, () => sheetTriangles(entity).map((t) => [t[0], t[1], t[2]] as Triangle), DEFAULT_UV_SCALE);
      const base = this.baseOf(entity, inheritedMaterial);
      const material = base.materialId === undefined ? undefined : this.doc.materials[base.materialId];
      const look = resolveAppearance({ appearance: entity.appearance ?? inheritedLook }, material);
      if (mesh !== null) this.emit({ mesh, material: this.bank.materialOf(base, look) }, parent);
      return;
    }
    const m = compose(parent, placement(entity.position, entity.rotation));
    for (const piece of this.piecesOf(entity, inheritedMaterial, inheritedLook, arrayColor)) this.emit(piece, m);
  }

  private placeChildren(
    component: Component,
    m: Affine,
    instance: { readonly materialId?: string | undefined; readonly appearance?: InstanceEntity['appearance']; readonly color?: string },
    depth: number,
  ): void {
    for (const childId of component.order) {
      const child = component.entities[childId];
      if (child !== undefined) this.place(child, m, instance.materialId, instance.appearance, depth + 1, instance.color);
    }
  }

  /**
   * A lower bound of the rows the visible arrays will add (members x direct 3D children that are not instances: each places at least one
   * row): over the limit, the scene is refused before any member is placed.
   */
  arraysSurelyOverBudget(): boolean {
    let rows = this.instanceCount;
    for (const array of Object.values(this.doc.instanceArrays ?? {})) {
      if (this.doc.layers[array.layerId]?.visible === false) continue;
      const component = this.doc.components[array.componentId];
      const solids = (component?.order ?? []).filter((id) => {
        const child = component?.entities[id];
        return child !== undefined && child.kind !== 'instance' && (is3D(child) || isSheet(child));
      }).length;
      rows += array.count * solids;
    }
    return rows > this.limits.maxInstances;
  }

  placeArrays(): void {
    if (this.arraysSurelyOverBudget()) {
      this.overBudget = true;
      return;
    }
    for (const array of Object.values(this.doc.instanceArrays ?? {})) {
      if (this.overBudget) return;
      if (this.doc.layers[array.layerId]?.visible === false) continue;
      const component = this.doc.components[array.componentId];
      const table = decodedTransforms(array);
      if (component === undefined || table === null) continue;
      const look = { materialId: array.materialId, color: array.color };
      for (let index = 0; index < array.count && !this.overBudget; index += 1) {
        const at = index * INSTANCE_STRIDE;
        const position: Vec3 = [table[at] as number, table[at + 1] as number, table[at + 2] as number];
        const rotation: Vec3 = [table[at + 3] as number, table[at + 4] as number, table[at + 5] as number];
        this.placeChildren(component, placement(position, rotation, array.scale), look, 0);
      }
    }
  }

  /** A square ground of side 2 `half` at height `z` under `center` (a matte grey, radiance-neutral albedo 0.18). */
  placeGround(z: number, center: Vec3, half: number): void {
    const [x0, x1, y0, y1] = [center[0] - half, center[0] + half, center[1] - half, center[1] + half];
    const tris: Triangle[] = [
      [
        [x0, y0, z],
        [x1, y0, z],
        [x1, y1, z],
      ],
      [
        [x0, y0, z],
        [x1, y1, z],
        [x0, y1, z],
      ],
    ];
    const mesh = this.soupMesh(`ground|${z}|${center.join(',')}|${half}`, () => tris, DEFAULT_UV_SCALE);
    const material = this.bank.materialOf(GROUND_SURFACE, undefined);
    if (mesh !== null) this.emit({ mesh, material }, IDENTITY, true);
  }

  instanceRows(): Float64Array {
    return this.rows.slice(0, this.instanceCount * PATH_TRACE_INSTANCE_STRIDE);
  }

  bounds(): SceneGeometry['bounds'] {
    return this.min[0] <= this.max[0] ? { min: [...this.min], max: [...this.max] } : null;
  }
}

function boxCorners(points: readonly Vec3[]): Vec3[] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis] as number, p[axis] as number);
      max[axis] = Math.max(max[axis] as number, p[axis] as number);
    }
  const [x0, y0, z0] = min as [number, number, number];
  const [x1, y1, z1] = max as [number, number, number];
  return [
    [x0, y0, z0],
    [x1, y0, z0],
    [x0, y1, z0],
    [x1, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x0, y1, z1],
    [x1, y1, z1],
  ];
}

/** Every visible 3D entity and instance-array member of `doc`, in document order. */
export function collectSceneGeometry(
  doc: CadDocument,
  bank: MaterialBank,
  limits: SceneLimits,
  ground?: { readonly elevation: number | null },
): SceneGeometry {
  const builder = new GeometryBuilder(doc, bank, limits);
  for (const id of doc.order) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity === undefined || !(is3D(entity) || isSheet(entity)) || doc.layers[entity.layerId]?.visible === false) continue;
    builder.place(entity, IDENTITY);
  }
  builder.placeArrays();
  const bounds = builder.bounds();
  if (ground !== undefined && bounds !== null) {
    const extent = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2], 1e-6);
    const center: Vec3 = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, 0];
    builder.placeGround(ground.elevation ?? bounds.min[2], center, extent * GROUND_EXTENT);
  }
  return {
    positions: builder.positions.view(),
    normals: builder.normals.view(),
    uvs: builder.uvs.view(),
    indices: builder.indices.view(),
    meshes: builder.meshes,
    instances: builder.instanceRows(),
    instanceCount: builder.instanceCount,
    triangles: builder.indices.length / 3,
    bounds,
    overBudget: builder.overBudget,
  };
}
