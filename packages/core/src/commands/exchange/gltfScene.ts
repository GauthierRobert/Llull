/**
 * glTF 2.0 scene of a document: one node + mesh per exported part (an entity, or each child of an instance) and one deduplicated PBR
 * material per appearance (assigned document material, else the entity colour with the viewport's default metalness/roughness; a material
 * finish embeds its procedural albedo / normal / roughness maps with box-projected UVs). Colours are converted from sRGB hex to the linear
 * factors glTF requires; normals are creased (smooth below CREASE_ANGLE) so curved surfaces shade smoothly in external renderers. A mesh solid's
 * face colours (set_face_color) split it into one part per colour.
 */

import type { CadDocument, Component, Entity, InstanceEntity, MaterialFinish, Vec3 } from '../../model/types';
import { decalPatch } from '../../geometry/decal';
import { decalImage } from '../../geometry/decalImage';
import { entityLocalToWorld } from '../../geometry/entityFrame';
import { ORIGIN, dot3, vec3At } from '../../lib/vec3';
import { parseHexRgb } from '../../lib/isHexColor';
import { boxUv, finishMaps } from '../../geometry/finishMaps';
import { encodePng } from '../../lib/png';
import { GltfBuilder } from './gltfBuilder';
import type { Triangle } from '../../geometry/triangles';
import { facetNormal } from '../../geometry/tessellation';
import { UNIT_SCALE, expandInstance } from '../../geometry/instanceExpansion';
import { localTriangles, solidTriangles } from '../../geometry/solidTriangles';
import { toRadians } from '../../lib/angle';
import { faceColorTriangles } from '../../geometry/faceColors';
import { InstanceTransforms } from './gltfInstancing';
import { indexedMesh, placementMatrix, positionKey, sharedGeometryGroups } from './gltfMeshData';
import { exactShapeKeyOf } from './gltfPrototypes';
import { instanceIdExtras } from './gltfIds';

/** Metalness / roughness of a solid without an assigned material (matches the viewport). */
export const DEFAULT_METALNESS = 0.08;
export const DEFAULT_ROUGHNESS = 0.45;

/** Faces meeting at less than this angle share a smoothed vertex normal. */
const CREASE_ANGLE = toRadians(30);

/** PBR appearance of one exported part. */
export interface PartAppearance {
  readonly name: string;
  readonly color: string;
  readonly metalness: number;
  readonly roughness: number;
  readonly finish?: MaterialFinish;
}

/** One exported part: its world-space triangles and appearance. */
export interface ScenePart {
  readonly name: string;
  readonly entityId: string;
  readonly kind: Entity['kind'];
  /** World-space triangles. A part that reuses the tessellation of an identical placed solid (gpu mode) holds that prototype's `localTris`: same length, never read as world geometry (it is drawn through a shared mesh). */
  readonly tris: Triangle[];
  /** The same triangles in the part's own frame: texture UVs follow the part, as in the viewport. */
  readonly localTris: Triangle[];
  readonly appearance: PartAppearance;
  /** The part frame in world space (local -> world): parts with identical local geometry share one glTF mesh placed by it. */
  readonly placement?: { readonly position: Vec3; readonly rotation: Vec3 };
}

function appearanceOf(doc: CadDocument, entity: Entity, inherited?: string): PartAppearance {
  const material = doc.materials[entity.materialId ?? inherited ?? ''];
  if (material !== undefined) {
    const { name, color, metalness, roughness, finish } = material;
    return { name, color, metalness, roughness, ...(finish !== undefined ? { finish } : {}) };
  }
  return { name: entity.color, color: entity.color, metalness: DEFAULT_METALNESS, roughness: DEFAULT_ROUGHNESS };
}

/** Triangle indices of a mesh solid grouped by face colour (undefined = the part's own appearance); null without face colours. */
function faceColorGroups(solid: Entity): Map<string | undefined, number[]> | null {
  if (solid.kind !== 'mesh' || solid.faceColors === undefined || solid.faceColors.length === 0) return null;
  const groups = new Map<string | undefined, number[]>();
  faceColorTriangles(solid.mesh, solid.faceColors).forEach((color, t) => {
    const group = groups.get(color);
    if (group === undefined) groups.set(color, [t]);
    else group.push(t);
  });
  return groups;
}

/** The parts of one 3D solid: itself, or one per face colour of a mesh solid; its triangles are in the frame the solid is placed in. */
function partsOfSolid(name: string, entityId: string, solid: Entity, appearance: PartAppearance): ScenePart[] {
  const tris = solidTriangles(solid);
  if (tris.length === 0) return [];
  const localTris = localTriangles(solid);
  const placement = { position: solid.position, rotation: solid.rotation };
  const groups = faceColorGroups(solid);
  if (groups === null) return [{ name, entityId, kind: solid.kind, tris, localTris, appearance, placement }];
  const parts: ScenePart[] = [];
  for (const [color, indices] of groups) {
    const pick = <T>(list: readonly T[]): T[] => indices.map((t) => list[t] as T);
    const { metalness, roughness } = appearance;
    parts.push({
      name: color === undefined ? name : `${name}/face ${color}`,
      entityId,
      kind: solid.kind,
      tris: pick(tris),
      localTris: pick(localTris),
      appearance: color === undefined ? appearance : { name: color, color, metalness, roughness },
      placement,
    });
  }
  return parts;
}

/** One prototype drawn by many instances (EXT_mesh_gpu_instancing): `part.tris` are in the component frame, `transforms` place each copy. */
export interface InstanceBucket {
  readonly part: ScenePart;
  /** Instance entity ids, in transform order. */
  readonly entityIds: string[];
  readonly transforms: InstanceTransforms;
}

/** Where `collectSceneParts` puts the instance entities it keeps unexpanded (gpu instancing); `groupOf` splits buckets by entity group. */
export interface InstancingSink {
  readonly buckets: InstanceBucket[];
  readonly groupOf: GroupOf;
}

/** An instance whose component can be drawn as buckets: it exists and no scale component is zero, negative (mirroring) or non-finite. */
function bucketable(instance: InstanceEntity, component: Component | undefined): component is Component {
  return component !== undefined && (instance.scale ?? UNIT_SCALE).every((c) => Number.isFinite(c) && c > 0);
}

/** Adds `instance` to the buckets of its component's children (a prototype is tessellated once, then reused by every instance). */
function addToBuckets(
  doc: CadDocument,
  instance: InstanceEntity,
  component: Component,
  sink: InstancingSink,
  prototypes: Map<string, InstanceBucket[]>,
): void {
  const label = instance.name ?? instance.id;
  const group = sink.groupOf(instance.id)?.id ?? '';
  for (const childId of component.order) {
    const child = component.entities[childId];
    if (child === undefined) continue;
    const key = `${instance.componentId}|${childId}|${instance.materialId ?? ''}|${group}`;
    let buckets = prototypes.get(key);
    if (buckets === undefined) {
      const name = `${label}/${child.name ?? child.id}`;
      buckets = partsOfSolid(name, instance.id, child, appearanceOf(doc, child, instance.materialId)).map((part) => ({
        part,
        entityIds: [],
        transforms: new InstanceTransforms(),
      }));
      prototypes.set(key, buckets);
      sink.buckets.push(...buckets);
    }
    for (const bucket of buckets) {
      bucket.entityIds.push(instance.id);
      bucket.transforms.add(instance.position, instance.rotation, instance.scale ?? UNIT_SCALE);
    }
  }
}

/**
 * Parts of a placed solid in gpu mode: the first solid of each (shape, appearance) prototype is tessellated, later identical solids reuse its
 * local triangles (a part with face colours is always tessellated on its own).
 */
function placedParts(name: string, solid: Entity, doc: CadDocument, prototypes: Map<string, readonly ScenePart[]>): ScenePart[] {
  const appearance = appearanceOf(doc, solid);
  if (solid.kind === 'mesh' && solid.faceColors !== undefined && solid.faceColors.length > 0)
    return partsOfSolid(name, solid.id, solid, appearance);
  const key = `${exactShapeKeyOf(solid)}|${JSON.stringify(appearance)}`;
  const prototype = prototypes.get(key);
  if (prototype === undefined) {
    const parts = partsOfSolid(name, solid.id, solid, appearance);
    prototypes.set(key, parts);
    return parts;
  }
  const placement = { position: solid.position, rotation: solid.rotation };
  return prototype.map((part) => ({ ...part, name, entityId: solid.id, tris: part.localTris, placement }));
}

/**
 * Exported parts of the entities named by `ids` (instances expand into one part per child; 2D and empty parts are dropped). With `sink`,
 * instances that can be drawn as buckets go there instead of expanding; the others still expand.
 */
export function collectSceneParts(doc: CadDocument, ids: readonly string[], sink?: InstancingSink): ScenePart[] {
  const parts: ScenePart[] = [];
  const prototypes = new Map<string, InstanceBucket[]>();
  const solidPrototypes = new Map<string, readonly ScenePart[]>();
  for (const id of ids) {
    const entity = doc.entities[id];
    if (entity === undefined) continue;
    const label = entity.name ?? entity.id;
    if (entity.kind !== 'instance') {
      parts.push(
        ...(sink === undefined
          ? partsOfSolid(label, id, entity, appearanceOf(doc, entity))
          : placedParts(label, entity, doc, solidPrototypes)),
      );
      continue;
    }
    const component = doc.components[entity.componentId];
    if (sink !== undefined && bucketable(entity, component)) {
      addToBuckets(doc, entity, component, sink, prototypes);
      continue;
    }
    for (const child of component === undefined ? [] : expandInstance(entity, component))
      parts.push(...partsOfSolid(`${label}/${child.name ?? child.id}`, entity.id, child, appearanceOf(doc, child, entity.materialId)));
  }
  return parts;
}

/** A decal overlay: world-space patch triangles with UVs and its rasterized text image. */
export interface DecalPart {
  readonly name: string;
  readonly entityId: string;
  readonly positions: number[];
  readonly uvs: number[];
  readonly image: { readonly width: number; readonly height: number; readonly rgba: Uint8Array };
}

/** Decal overlays of the entities named by `ids` (patches placed by each entity's transform). */
export function collectDecalParts(doc: CadDocument, ids: readonly string[]): DecalPart[] {
  const parts: DecalPart[] = [];
  for (const id of ids) {
    const entity = doc.entities[id];
    if (entity?.decals === undefined || entity.kind === 'instance') continue;
    const local = localTriangles(entity);
    for (const decal of entity.decals) {
      const patch = decalPatch(decal, local);
      if (patch.positions.length === 0) continue;
      const positions: number[] = [];
      for (let i = 0; i < patch.positions.length; i += 3) positions.push(...entityLocalToWorld(entity, vec3At(patch.positions, i)));
      parts.push({
        name: `${entity.name ?? entity.id}/decal "${decal.text}"`,
        entityId: entity.id,
        positions,
        uvs: patch.uvs,
        image: decalImage(decal),
      });
    }
  }
  return parts;
}

/** One sRGB channel (0..1) to linear light. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** `#rrggbb` → linear RGBA factor; malformed input falls back to mid grey. */
export function linearColorFactor(hex: string): [number, number, number, number] {
  const rgb = parseHexRgb(hex);
  if (rgb === null) return [0.214, 0.214, 0.214, 1];
  const [r, g, b] = rgb.map((c) => Number(srgbToLinear(c / 255).toFixed(4))) as [number, number, number];
  return [r, g, b, 1];
}

/**
 * Per-corner normals of a triangle soup: each corner averages the facet normals of the faces
 * sharing its position whose normal lies within CREASE_ANGLE of its own face (hard edges stay hard).
 */
export function creasedNormals(tris: readonly Triangle[]): Float32Array {
  const faceNormals = tris.map((tri) => facetNormal(...tri));
  const key = positionKey;
  const facesAt = new Map<string, number[]>();
  tris.forEach((tri, face) =>
    tri.forEach((v) => {
      const k = key(v);
      const list = facesAt.get(k);
      if (list) list.push(face);
      else facesAt.set(k, [face]);
    }),
  );
  const cosLimit = Math.cos(CREASE_ANGLE);
  const out = new Float32Array(tris.length * 9);
  tris.forEach((tri, face) => {
    const own = faceNormals[face] as Vec3;
    tri.forEach((v, corner) => {
      let [x, y, z] = [0, 0, 0];
      for (const other of facesAt.get(key(v)) ?? []) {
        const n = faceNormals[other] as Vec3;
        if (dot3(n, own) < cosLimit) continue;
        x += n[0];
        y += n[1];
        z += n[2];
      }
      const length = Math.hypot(x, y, z);
      const normal = length > 1e-12 ? [x / length, y / length, z / length] : own;
      out.set(normal, face * 9 + corner * 3);
    });
  });
  return out;
}

/** Box-projected TEXCOORD_0 of a local-frame triangle soup (one finish tile per `scale` units). */
function boxUvs(tris: readonly Triangle[], scale: number): Float32Array {
  const uvs = new Float32Array(tris.length * 6);
  tris.forEach((tri, t) => {
    const normal = facetNormal(...tri);
    tri.forEach((v, k) => uvs.set(boxUv(v, normal, scale), t * 6 + k * 2));
  });
  return uvs;
}

/** Per part: the instanced group (members in part order) it belongs to — parts of one shared mesh in the same entity group, 2 or more. */
function instancedGroups(
  parts: readonly ScenePart[],
  shareGroup: readonly (number | undefined)[],
  groupOf: GroupOf,
): ({ members: number[] } | undefined)[] {
  const keyOf = (p: number): string | undefined => {
    const part = parts[p];
    const share = shareGroup[p];
    return share === undefined || part === undefined || part.placement === undefined
      ? undefined
      : `${share}|${part.kind}|${groupOf(part.entityId)?.id ?? ''}`;
  };
  const byKey = new Map<string, { members: number[] }>();
  parts.forEach((_, p) => {
    const key = keyOf(p);
    if (key === undefined) return;
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, { members: [p] });
    else bucket.members.push(p);
  });
  return parts.map((_, p) => {
    const key = keyOf(p);
    const bucket = key === undefined ? undefined : byKey.get(key);
    return bucket !== undefined && bucket.members.length >= 2 ? bucket : undefined;
  });
}

/** glTF material of an appearance; a finish embeds its maps (+ clearcoat extension). */
function materialOf(builder: GltfBuilder, appearance: PartAppearance): Record<string, unknown> {
  const maps = finishMaps(appearance);
  if (maps === null || appearance.finish === undefined)
    return {
      name: appearance.name,
      pbrMetallicRoughness: {
        baseColorFactor: linearColorFactor(appearance.color),
        metallicFactor: appearance.metalness,
        roughnessFactor: appearance.roughness,
      },
    };
  const png = (rgba: Uint8Array): Uint8Array => encodePng(maps.size, maps.size, rgba);
  const clearcoat = appearance.finish.clearcoat ?? 0;
  if (clearcoat > 0) builder.useExtension('KHR_materials_clearcoat');
  return {
    name: appearance.name,
    pbrMetallicRoughness: {
      baseColorTexture: { index: builder.texture(png(maps.albedo)) },
      metallicRoughnessTexture: { index: builder.texture(png(maps.metallicRoughness)) },
      metallicFactor: 1,
      roughnessFactor: 1,
    },
    normalTexture: { index: builder.texture(png(maps.normal)) },
    ...(clearcoat > 0 ? { extensions: { KHR_materials_clearcoat: { clearcoatFactor: clearcoat, clearcoatRoughnessFactor: 0.04 } } } : {}),
  };
}

/** The group an entity belongs to (its glTF parent node), when any. */
export type GroupOf = (entityId: string) => { readonly id: string; readonly name: string } | undefined;

/**
 * glTF JSON (without buffer uri) and its BIN payload for `parts`; an entity in a group (`groupOf`)
 * hangs under a node named after the group.
 */
export function buildGltfScene(
  parts: readonly ScenePart[],
  decals: readonly DecalPart[] = [],
  groupOf: GroupOf = () => undefined,
  gpu?: { readonly buckets: readonly InstanceBucket[] },
): { json: Record<string, unknown>; bin: Uint8Array; nodeCount: number; materialCount: number; instanceCount: number } {
  const builder = new GltfBuilder();
  const groupNodes = new Map<string, number>();
  const parentOf = (entityId: string): number | undefined => {
    const group = groupOf(entityId);
    if (group === undefined) return undefined;
    const existing = groupNodes.get(group.id);
    if (existing !== undefined) return existing;
    const node = builder.node(group.name);
    groupNodes.set(group.id, node);
    return node;
  };
  const appearanceKeys = parts.map((part) => JSON.stringify(part.appearance));
  const shareGroup = sharedGeometryGroups(
    parts.map((part, p) => ({ localTris: part.localTris, key: appearanceKeys[p] ?? '', placed: part.placement !== undefined })),
  );
  const sharedMeshes = new Map<number, number>();
  /** Indexed mesh of `tris` (world, or local for a shared mesh); UVs always follow the part frame. */
  const partMesh = (part: ScenePart, tris: readonly Triangle[], material: number): number => {
    const { finish } = part.appearance;
    const data = indexedMesh(tris, creasedNormals(tris), finish === undefined ? undefined : boxUvs(part.localTris, finish.scale));
    const attributes: Record<string, number> = {
      POSITION: builder.vertexData(data.positions, 3, true),
      NORMAL: builder.vertexData(data.normals, 3),
    };
    if (data.uvs !== undefined) attributes['TEXCOORD_0'] = builder.vertexData(data.uvs, 2);
    return builder.addMesh(part.name, attributes, material, builder.indexData(data.indices));
  };
  /** gpu: parts sharing a mesh (and entity group) become one instanced node; the first member emits it, the others are skipped. */
  const bucketOf = gpu === undefined ? [] : instancedGroups(parts, shareGroup, groupOf);
  let instanceCount = 0;
  parts.forEach((part, p) => {
    const { appearance } = part;
    const material = builder.material(appearanceKeys[p] ?? '', () => materialOf(builder, appearance));
    const extras = { llullId: part.entityId, kind: part.kind };
    const group = shareGroup[p];
    const bucket = bucketOf[p];
    if (bucket !== undefined) {
      if (bucket.members[0] !== p) return;
      const transforms = new InstanceTransforms();
      for (const m of bucket.members) {
        const { position, rotation } = parts[m]?.placement ?? { position: ORIGIN, rotation: ORIGIN };
        transforms.add(position, rotation);
      }
      instanceCount += bucket.members.length;
      const ids = bucket.members.map((m) => parts[m]?.entityId ?? '');
      builder.instancedNode(
        part.name,
        partMesh(part, part.localTris, material),
        { ...instanceIdExtras(ids), kind: part.kind, instanceCount: ids.length },
        transforms.packed(),
        parentOf(part.entityId),
      );
      return;
    }
    if (group === undefined || part.placement === undefined) {
      builder.meshNode(part.name, partMesh(part, part.tris, material), extras, parentOf(part.entityId));
      return;
    }
    const mesh = sharedMeshes.get(group) ?? partMesh(part, part.localTris, material);
    sharedMeshes.set(group, mesh);
    builder.meshNode(part.name, mesh, extras, parentOf(part.entityId), placementMatrix(part.placement.position, part.placement.rotation));
  });
  for (const { part, entityIds, transforms } of gpu?.buckets ?? []) {
    const material = builder.material(JSON.stringify(part.appearance), () => materialOf(builder, part.appearance));
    instanceCount += entityIds.length;
    builder.instancedNode(
      part.name,
      partMesh(part, part.tris, material),
      { ...instanceIdExtras(entityIds), kind: part.kind, instanceCount: entityIds.length },
      transforms.packed(),
      parentOf(part.entityId),
    );
  }
  decals.forEach((decal, index) => {
    const material = builder.material(`decal:${index}`, () => ({
      name: decal.name,
      alphaMode: 'BLEND',
      pbrMetallicRoughness: {
        baseColorTexture: { index: builder.texture(encodePng(decal.image.width, decal.image.height, decal.image.rgba)) },
        metallicFactor: 0,
        roughnessFactor: 0.6,
      },
    }));
    const tris: Triangle[] = [];
    for (let i = 0; i < decal.positions.length; i += 9) {
      const at = (k: number): Vec3 => [
        decal.positions[i + k * 3] ?? 0,
        decal.positions[i + k * 3 + 1] ?? 0,
        decal.positions[i + k * 3 + 2] ?? 0,
      ];
      tris.push([at(0), at(1), at(2)]);
    }
    builder.mesh(
      decal.name,
      {
        POSITION: builder.vertexData(new Float32Array(decal.positions), 3, true),
        NORMAL: builder.vertexData(creasedNormals(tris), 3),
        TEXCOORD_0: builder.vertexData(new Float32Array(decal.uvs), 2),
      },
      material,
      { llullId: decal.entityId, kind: 'decal' },
      parentOf(decal.entityId),
    );
  });
  return { ...builder.result(), instanceCount };
}
