/**
 * glTF 2.0 scene of a document: one node + mesh per exported part (an entity, or each child of an instance) and one deduplicated PBR
 * material per appearance (assigned document material, else the entity colour with the viewport's default metalness/roughness; a material
 * finish embeds its procedural albedo / normal / roughness maps with box-projected UVs). Colours are converted from sRGB hex to the linear
 * factors glTF requires; normals are creased (smooth below CREASE_ANGLE) so curved surfaces shade smoothly in external renderers.
 */

import type { CadDocument, Entity, MaterialFinish, Vec3 } from '../../model/types';
import { decalPatch } from '../../geometry/decal';
import { rasterizeText } from '../../lib/blockFont';
import { entityLocalToWorld } from '../../geometry/entityFrame';
import { dot3, vec3At } from '../../lib/vec3';
import { parseHexRgb } from '../../lib/isHexColor';
import { boxUv, finishMaps } from '../../geometry/finishMaps';
import { encodePng } from '../../lib/png';
import { GltfBuilder } from './gltfBuilder';
import type { Triangle } from '../../geometry/triangles';
import { facetNormal } from '../../geometry/tessellation';
import { expandInstance } from '../../geometry/instanceExpansion';
import { localTriangles, solidTriangles } from '../../geometry/solidTriangles';
import { toRadians } from '../../lib/angle';

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
  readonly tris: Triangle[];
  /** The same triangles in the part's own frame: texture UVs follow the part, as in the viewport. */
  readonly localTris: Triangle[];
  readonly appearance: PartAppearance;
}

function appearanceOf(doc: CadDocument, entity: Entity, inherited?: string): PartAppearance {
  const material = doc.materials[entity.materialId ?? inherited ?? ''];
  if (material !== undefined) {
    const { name, color, metalness, roughness, finish } = material;
    return { name, color, metalness, roughness, ...(finish !== undefined ? { finish } : {}) };
  }
  return { name: entity.color, color: entity.color, metalness: DEFAULT_METALNESS, roughness: DEFAULT_ROUGHNESS };
}

/** Exported parts of the entities named by `ids` (instances expand into one part per child; 2D and empty parts are dropped). */
export function collectSceneParts(doc: CadDocument, ids: readonly string[]): ScenePart[] {
  const parts: ScenePart[] = [];
  const add = (name: string, entityId: string, solid: Entity, appearance: PartAppearance): void => {
    const tris = solidTriangles(solid);
    if (tris.length > 0) parts.push({ name, entityId, kind: solid.kind, tris, localTris: localTriangles(solid), appearance });
  };
  for (const id of ids) {
    const entity = doc.entities[id];
    if (entity === undefined) continue;
    const label = entity.name ?? entity.id;
    if (entity.kind !== 'instance') add(label, id, entity, appearanceOf(doc, entity));
    else {
      const component = doc.components[entity.componentId];
      for (const child of component === undefined ? [] : expandInstance(entity, component))
        add(`${label}/${child.name ?? child.id}`, entity.id, child, appearanceOf(doc, child, entity.materialId));
    }
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
        image: rasterizeText(decal.text, decal.color, decal.background),
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
  const key = (v: readonly number[]): string => v.map((c) => c.toFixed(5)).join(',');
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
): { json: Record<string, unknown>; bin: Uint8Array; nodeCount: number; materialCount: number } {
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
  for (const part of parts) {
    const { appearance } = part;
    const key = JSON.stringify(appearance);
    const material = builder.material(key, () => materialOf(builder, appearance));
    const positions = new Float32Array(part.tris.length * 9);
    part.tris.forEach((tri, t) => tri.forEach((v, k) => positions.set(v, t * 9 + k * 3)));
    const attributes: Record<string, number> = {
      POSITION: builder.vertexData(positions, 3, true),
      NORMAL: builder.vertexData(creasedNormals(part.tris), 3),
    };
    if (appearance.finish !== undefined) attributes['TEXCOORD_0'] = builder.vertexData(boxUvs(part.localTris, appearance.finish.scale), 2);
    builder.mesh(part.name, attributes, material, { llullId: part.entityId, kind: part.kind }, parentOf(part.entityId));
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
  return builder.result();
}
