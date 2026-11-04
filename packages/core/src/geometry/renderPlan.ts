/**
 * Render plan R-BATCH-v1 (plant 09 VIS §5.2 / §5.3): which instances a camera draws, at which level of detail, and in which batch.
 * Used by the viewport and by `render_stats`, so the CLI numbers are the viewport's numbers. No three.js. Deterministic.
 * @invariant drawn + culled.frustum + culled.pixel = componentCount; a bucket is (prototype, material class, LOD) for LOD 0 / 1, one box
 *   bucket per material class for LOD 2, and one batch per material class for unique (single-instance) prototypes
 */

import type { CadDocument, Entity } from '../model/types';
import { is3D } from '../model/types';
import { sha256Hex } from '../lib/sha256';
import { dot3 } from '../lib/vec3';
import type { Bounds } from './bounds';
import { entityBounds, entityBoundsInDoc } from './bounds';
import { assignedMaterialClass, materialClassPlanKey } from './materialClasses';
import { entityToTriangles } from './entityTriangles';
import { type FrustumPlane, type PlanCamera, frustumPlanes, planCameraProblem } from './renderPlanCamera';

const PLAN_VERSION = 'R-BATCH-v1';
/** `lod:llull-v1`: projected bounding-box diagonal (px) from which LOD0, LOD1, LOD2 are used, and below which an instance is culled. */
const LOD_THRESHOLDS_PX = [48, 8, 1] as const;
const LOD_HYSTERESIS = 0.1;
/** Level value of an instance culled by size. */
export const LEVEL_CULLED = 3;
/** Level value of an instance outside the frustum (never an input to hysteresis). */
export const LEVEL_OUTSIDE = 4;
/** InstancedMesh bytes per instance: matrix 64 + colour 12, plus the packed state byte attribute (4). */
const INSTANCE_BYTES = 80;
const GEOMETRY_BYTES_PER_TRIANGLE = 72;
const BOX_TRIANGLES = 12;

export interface PlanInstance {
  readonly id: string;
  /** Index into `PlanScene.prototypeKeys`. */
  readonly prototype: number;
  /** Index into `PlanScene.materialClasses`. */
  readonly materialClass: number;
  readonly aabb: Bounds;
  /** Bounding-box diagonal of the prototype (rotation independent). */
  readonly diagonal: number;
}

export interface PlanScene {
  readonly instances: readonly PlanInstance[];
  readonly prototypeKeys: readonly string[];
  readonly materialClasses: readonly string[];
  /** LOD0 triangle count of each prototype. */
  readonly prototypeTriangles: readonly number[];
  /** Instances per prototype in the whole scene (a prototype with 1 is unique geometry). */
  readonly prototypeCounts: readonly number[];
  /** Entities skipped because their layer is hidden. */
  readonly hiddenCount: number;
}

/** Indices of the instances whose AABB intersects every plane's inside half-space (a BVH slots in here). */
export type InstanceQuery = (planes: readonly FrustumPlane[]) => readonly number[];

interface PlanBucket {
  readonly prototypeKey: string;
  readonly materialClass: string;
  readonly lod: 0 | 1 | 2;
  readonly instances: number;
  /** Indices into `PlanScene.instances`, ascending. */
  readonly members: readonly number[];
}

export interface PlanOptions {
  readonly multiDraw: boolean;
  readonly quality: 'high' | 'medium' | 'low';
  /** Levels of the previous frame (`RenderPlan.levels`) for hysteresis. */
  readonly previousLevels?: Uint8Array;
  readonly query?: InstanceQuery;
}

export interface RenderPlan {
  readonly planVersion: typeof PLAN_VERSION;
  readonly componentCount: number;
  readonly buckets: readonly PlanBucket[];
  readonly uniqueBatches: readonly { readonly materialClass: string; readonly members: readonly number[] }[];
  readonly opaqueModelCalls: number;
  readonly edgeCalls: number;
  readonly shadowCalls: number;
  readonly culled: { readonly frustum: number; readonly pixel: number };
  readonly drawn: number;
  readonly triangles: number;
  readonly gpuBytesEstimate: number;
  /** Per instance: LOD 0..2, `LEVEL_CULLED` (size) or `LEVEL_OUTSIDE` (frustum). */
  readonly levels: Uint8Array;
}

const NON_GEOMETRY_KEYS = new Set([
  'id',
  'kind',
  'position',
  'rotation',
  'layerId',
  'color',
  'name',
  'tags',
  'materialId',
  'patternSourceId',
  'decals',
  'faceColors',
]);

/** Locale-independent string order (UTF-16 code units), so plans are identical on every machine. */
export const compareCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sig6 = (value: number): string => String(Number(value.toPrecision(6)));

function canonical(value: unknown): string {
  if (typeof value === 'number') return sig6(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareCodepoint(a, b))
      .map(([k, v]) => `${k}:${canonical(v)}`)
      .join(',')}}`;
  return String(value);
}

/**
 * Prototype key of an entity (TR-VIS-20): shape parameters to 6 significant figures, never position, rotation, colour, layer or name.
 * @invariant two entities share a key iff they have the same kind and shape parameters (meshes: the same vertex / index data)
 */
export function prototypeKeyOf(entity: Entity): string {
  if (entity.kind === 'mesh') return `mesh|${sha256Hex(`${entity.mesh.positions.join(',')}|${entity.mesh.indices.join(',')}`)}`;
  if (entity.kind === 'instance') return `component:${entity.componentId}|${canonical(entity.scale ?? [1, 1, 1])}`;
  const params = Object.entries(entity).filter(([key]) => !NON_GEOMETRY_KEYS.has(key));
  return `${entity.kind}|${params.map(([key, value]) => `${key}=${canonical(value)}`).join(';')}`;
}

/**
 * Material class of an entity by default: its assigned display class as `matclass:<id>` (assign_material_class), else its `materialId`, else
 * `unassigned`. The prefix keeps a `materialId` equal to a class id in its own bucket.
 */
const defaultMaterialClassOf = (doc: CadDocument, entity: Entity): string => {
  const assigned = assignedMaterialClass(doc, entity.id);
  return assigned === undefined ? (entity.materialId ?? 'unassigned') : materialClassPlanKey(assigned.id);
};

const diagonalOf = ({ min, max }: Bounds): number => Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);

/**
 * Every visible 3D entity of the document as a batchable instance.
 * @invariant document order; entities on hidden layers and 2D / curve / sheet entities are skipped; an `instance` entity is one instance
 *   (children are not expanded into the plan)
 */
export function planScene(
  doc: CadDocument,
  materialClassOf: (entity: Entity) => string = (entity) => defaultMaterialClassOf(doc, entity),
): PlanScene {
  const prototypeIndex = new Map<string, number>();
  const classIndex = new Map<string, number>();
  const prototypeTriangles: number[] = [];
  const prototypeCounts: number[] = [];
  const instances: PlanInstance[] = [];
  let hiddenCount = 0;
  for (const id of doc.order) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity === undefined || !is3D(entity)) continue;
    if (doc.layers[entity.layerId]?.visible === false) {
      hiddenCount++;
      continue;
    }
    const key = prototypeKeyOf(entity);
    let prototype = prototypeIndex.get(key);
    if (prototype === undefined) {
      prototype = prototypeIndex.size;
      prototypeIndex.set(key, prototype);
      prototypeTriangles.push(entityToTriangles(entity, doc).length);
      prototypeCounts.push(0);
    }
    prototypeCounts[prototype] = (prototypeCounts[prototype] ?? 0) + 1;
    const className = materialClassOf(entity);
    let materialClass = classIndex.get(className);
    if (materialClass === undefined) {
      materialClass = classIndex.size;
      classIndex.set(className, materialClass);
    }
    const aabb = entityBoundsInDoc(doc, entity);
    const diagonal = entity.kind === 'instance' ? diagonalOf(aabb) : diagonalOf(entityBounds(entity));
    instances.push({ id, prototype, materialClass, aabb, diagonal });
  }
  return {
    instances,
    prototypeKeys: [...prototypeIndex.keys()],
    materialClasses: [...classIndex.keys()],
    prototypeTriangles,
    prototypeCounts,
    hiddenCount,
  };
}

/** True when the box has a point in every plane's inside half-space (a conservative frustum test). */
export function boxInsideAllPlanes({ min, max }: Bounds, planes: readonly FrustumPlane[]): boolean {
  return planes.every(({ normal, offset }) => {
    const far: [number, number, number] = [
      normal[0] >= 0 ? max[0] : min[0],
      normal[1] >= 0 ? max[1] : min[1],
      normal[2] >= 0 ? max[2] : min[2],
    ];
    return dot3(normal, far) + offset >= 0;
  });
}

/** Reference frustum query: tests every AABB, O(N). */
export function bruteForceQuery(instances: readonly PlanInstance[]): InstanceQuery {
  return (planes) => {
    const inside: number[] = [];
    for (let index = 0; index < instances.length; index++) {
      const instance = instances[index];
      if (instance !== undefined && boxInsideAllPlanes(instance.aabb, planes)) inside.push(index);
    }
    return inside;
  };
}

/** Projected size in pixels of a bounding-box diagonal at `distance` (perspective) or in the orthographic view. */
export function projectedPixels(diagonal: number, distance: number, camera: PlanCamera): number {
  if (camera.projection === 'orthographic') return (diagonal * camera.heightPx) / camera.viewHeight;
  return (diagonal * camera.heightPx) / (2 * Math.max(distance, 1e-9) * Math.tan((camera.fovDeg * Math.PI) / 360));
}

/**
 * Switch distances (perspective) for a diagonal: LOD0 -> LOD1, LOD1 -> LOD2, cull, and the distance down to which LOD1 holds when coming
 * from farther away (`d01 (1 - h)`).
 */
export function lodSwitchDistances(
  diagonal: number,
  heightPx: number,
  fovDeg: number,
): { lod0to1: number; lod1to2: number; cull: number; lod1HoldDownTo: number } {
  const k = (diagonal * heightPx) / (2 * Math.tan((fovDeg * Math.PI) / 360));
  const [t0, t1, t2] = LOD_THRESHOLDS_PX;
  return { lod0to1: k / t0, lod1to2: k / t1, cull: k / t2, lod1HoldDownTo: (k / t0) * (1 - LOD_HYSTERESIS) };
}

/**
 * Level (0..2, 3 = culled by size) of projected size `pixels`. With the `previous` level, a finer level is only taken once
 * `pixels (1 - h) >= threshold` (the level holds until d < d_i (1 - h), three `LOD.update`); a coarser level is taken at the threshold.
 */
export function lodLevel(pixels: number, previous?: number): number {
  const thresholds = LOD_THRESHOLDS_PX;
  const coarsen = (from: number): number => {
    let level = from;
    while (level < LEVEL_CULLED && pixels < (thresholds[level] ?? 0)) level++;
    return level;
  };
  if (previous === undefined || previous > LEVEL_CULLED) return coarsen(0);
  let level = coarsen(previous);
  while (level > 0 && pixels * (1 - LOD_HYSTERESIS) >= (thresholds[level - 1] ?? Infinity)) level--;
  return level;
}

const LOD1_TRIANGLE_CAP: Readonly<Record<string, number>> = { cylinder: 32, cone: 24, sphere: 112, torus: 128, revolution: 128 };

const SHADOW_CASCADES = { high: 3, medium: 2, low: 0 } as const;

/**
 * The plan for one camera. Throws RangeError on an invalid camera (`planCameraProblem`); callers validate first.
 * @invariant call bound: opaqueModelCalls <= 2 * (distinct (prototype, material class) pairs drawn) + C + U, with C = material classes and U = unique-geometry
 *   classes; this equals 2P + C + U only when each prototype has one material class (SYN-RACK-v1: 2*13 + 4 + 0 = 30)
 * @invariant pure; `drawn + culled.frustum + culled.pixel = componentCount`; unique prototypes (1 instance) are batched per material class
 *   at LOD0 and only size-culled; `opaqueModelCalls` = instanced buckets + unique calls (1 per class with multi-draw, else 1 per instance)
 */
export function planRender(scene: PlanScene, camera: PlanCamera, options: PlanOptions): RenderPlan {
  const problem = planCameraProblem(camera);
  if (problem !== null) throw new RangeError(`planRender: ${problem}`);
  const { instances } = scene;
  const levels = new Uint8Array(instances.length).fill(LEVEL_OUTSIDE);
  const query = options.query ?? bruteForceQuery(instances);
  const found = query(frustumPlanes(camera));
  const inside = found.every((value, position) => position === 0 || value > (found[position - 1] as number))
    ? found
    : [...new Set(found)].sort((a, b) => a - b);
  const classCount = Math.max(scene.materialClasses.length, 1);
  const bucketMembers = new Map<number, number[]>();
  const uniqueMembers = new Map<number, number[]>();
  const eye = camera.eye;
  let pixelCulled = 0;
  for (const index of inside) {
    const instance = instances[index];
    if (instance === undefined) continue;
    const { min, max } = instance.aabb;
    const distance = Math.hypot((min[0] + max[0]) / 2 - eye[0], (min[1] + max[1]) / 2 - eye[1], (min[2] + max[2]) / 2 - eye[2]);
    const level = lodLevel(projectedPixels(instance.diagonal, distance, camera), options.previousLevels?.[index]);
    levels[index] = level;
    if (level === LEVEL_CULLED) {
      pixelCulled++;
      continue;
    }
    const unique = scene.prototypeCounts[instance.prototype] === 1;
    // LOD2 boxes merge across prototypes (negative key); others key on (prototype, class, level)
    const key = unique
      ? instance.materialClass
      : level === 2
        ? -1 - instance.materialClass
        : (instance.prototype * classCount + instance.materialClass) * 2 + level;
    const target = unique ? uniqueMembers : bucketMembers;
    const list = target.get(key);
    if (list === undefined) target.set(key, [index]);
    else list.push(index);
  }
  const buckets: PlanBucket[] = [];
  let triangles = 0;
  let geometryBytes = 0;
  for (const [key, members] of bucketMembers) {
    const first = instances[members[0] ?? 0];
    if (first === undefined) continue;
    const materialClass = scene.materialClasses[first.materialClass] ?? '';
    if (key < 0) {
      buckets.push({ prototypeKey: '$box', materialClass, lod: 2, instances: members.length, members });
      triangles += members.length * BOX_TRIANGLES;
      continue;
    }
    const lod = (key % 2) as 0 | 1;
    const prototypeKey = scene.prototypeKeys[first.prototype] ?? '';
    const full = scene.prototypeTriangles[first.prototype] ?? 0;
    const perInstance = lod === 0 ? full : Math.min(full, LOD1_TRIANGLE_CAP[prototypeKey.split('|', 1)[0] ?? ''] ?? full);
    buckets.push({ prototypeKey, materialClass, lod, instances: members.length, members });
    triangles += members.length * perInstance;
    geometryBytes += perInstance * GEOMETRY_BYTES_PER_TRIANGLE;
  }
  buckets.sort(
    (a, b) => compareCodepoint(a.prototypeKey, b.prototypeKey) || compareCodepoint(a.materialClass, b.materialClass) || a.lod - b.lod,
  );
  const uniqueBatches = [...uniqueMembers.entries()]
    .map(([materialClassIndex, members]) => ({ materialClass: scene.materialClasses[materialClassIndex] ?? '', members }))
    .sort((a, b) => compareCodepoint(a.materialClass, b.materialClass));
  let uniqueDrawn = 0;
  for (const batch of uniqueBatches) {
    uniqueDrawn += batch.members.length;
    for (const index of batch.members) {
      const full = scene.prototypeTriangles[instances[index]?.prototype ?? 0] ?? 0;
      triangles += full;
      geometryBytes += full * GEOMETRY_BYTES_PER_TRIANGLE;
    }
  }
  const instancedDrawn = buckets.reduce((sum, bucket) => sum + bucket.instances, 0);
  const opaqueModelCalls = buckets.length + (options.multiDraw ? uniqueBatches.length : uniqueDrawn);
  const drawn = instancedDrawn + uniqueDrawn;
  return {
    planVersion: PLAN_VERSION,
    componentCount: instances.length,
    buckets,
    uniqueBatches,
    opaqueModelCalls,
    edgeCalls: options.quality === 'low' ? 0 : buckets.filter((bucket) => bucket.lod === 0).length,
    shadowCalls: SHADOW_CASCADES[options.quality] * opaqueModelCalls,
    culled: { frustum: instances.length - inside.length, pixel: pixelCulled },
    drawn,
    triangles,
    gpuBytesEstimate: drawn * INSTANCE_BYTES + geometryBytes,
    levels,
  };
}
