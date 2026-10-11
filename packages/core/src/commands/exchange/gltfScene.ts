/**
 * glTF 2.0 scene of a document: one node + mesh per exported part (an entity, or each child of an
 * instance) and one deduplicated PBR material per appearance (assigned document material, else the
 * entity colour with the viewport's default metalness/roughness). Colours are converted from sRGB
 * hex to the linear factors glTF requires; normals are creased (smooth below CREASE_ANGLE) so
 * curved surfaces shade smoothly in external renderers.
 *
 * @layer core/commands
 * @pure
 */

import type { CadDocument, Entity } from '../../model/types';
import type { Triangle } from '../../geometry/triangles';
import { facetNormal } from '../../geometry/tessellation';
import { expandInstance } from '../../geometry/instanceExpansion';
import { solidTriangles } from '../../geometry/solidTriangles';

/** Metalness / roughness of a solid without an assigned material (matches the viewport). */
export const DEFAULT_METALNESS = 0.08;
export const DEFAULT_ROUGHNESS = 0.45;

/** Faces meeting at less than this angle share a smoothed vertex normal. */
const CREASE_ANGLE = (30 * Math.PI) / 180;

/** PBR appearance of one exported part. */
export interface PartAppearance {
  readonly name: string;
  readonly color: string;
  readonly metalness: number;
  readonly roughness: number;
}

/** One exported part: its world-space triangles and appearance. */
export interface ExportPart {
  readonly name: string;
  readonly entityId: string;
  readonly kind: Entity['kind'];
  readonly tris: Triangle[];
  readonly appearance: PartAppearance;
}

function appearanceOf(doc: CadDocument, entity: Entity, inherited?: string): PartAppearance {
  const material = doc.materials[entity.materialId ?? inherited ?? ''];
  if (material !== undefined) {
    const { name, color, metalness, roughness } = material;
    return { name, color, metalness, roughness };
  }
  return {
    name: `paint ${entity.color.toLowerCase()}`,
    color: entity.color,
    metalness: DEFAULT_METALNESS,
    roughness: DEFAULT_ROUGHNESS,
  };
}

/**
 * Exported parts of the entities named by `ids` (instances expand into one part per child; 2D and
 * empty parts are dropped).
 */
export function collectExportParts(doc: CadDocument, ids: readonly string[]): ExportPart[] {
  const parts: ExportPart[] = [];
  for (const id of ids) {
    const entity = doc.entities[id];
    if (entity === undefined) continue;
    const label = entity.name ?? entity.id;
    if (entity.kind === 'instance') {
      const component = doc.components[entity.componentId];
      if (component === undefined) continue;
      for (const child of expandInstance(entity, component)) {
        const tris = solidTriangles(child);
        if (tris.length === 0) continue;
        parts.push({
          name: `${label}/${child.name ?? child.id}`,
          entityId: entity.id,
          kind: child.kind,
          tris,
          appearance: appearanceOf(doc, child, entity.materialId),
        });
      }
      continue;
    }
    const tris = solidTriangles(entity);
    if (tris.length === 0) continue;
    parts.push({
      name: label,
      entityId: id,
      kind: entity.kind,
      tris,
      appearance: appearanceOf(doc, entity),
    });
  }
  return parts;
}

/** One sRGB channel (0..1) to linear light. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** `#rrggbb` → linear RGBA factor; malformed input falls back to mid grey. */
export function linearColorFactor(hex: string): [number, number, number, number] {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (match === null) return [0.214, 0.214, 0.214, 1];
  const channel = (index: number): number =>
    Number(srgbToLinear(parseInt(match[index] as string, 16) / 255).toFixed(4));
  return [channel(1), channel(2), channel(3), 1];
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
    const own = faceNormals[face] as readonly [number, number, number];
    tri.forEach((v, corner) => {
      let [x, y, z] = [0, 0, 0];
      for (const other of facesAt.get(key(v)) ?? []) {
        const n = faceNormals[other] as readonly [number, number, number];
        if (n[0] * own[0] + n[1] * own[1] + n[2] * own[2] < cosLimit) continue;
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

/** Component-wise min/max of a flat xyz array (all-zero when empty). */
function aabb(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  positions.forEach((value, i) => {
    const axis = i % 3;
    if (value < (min[axis] as number)) min[axis] = value;
    if (value > (max[axis] as number)) max[axis] = value;
  });
  return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

/** glTF JSON (without buffer uri) and its BIN payload for `parts`. */
export function buildGltfScene(parts: readonly ExportPart[]): {
  json: Record<string, unknown>;
  bin: Uint8Array;
} {
  const materials: Array<Record<string, unknown>> = [];
  const materialIndex = new Map<string, number>();
  const chunks: Float32Array[] = [];
  const accessors: Array<Record<string, unknown>> = [];
  const bufferViews: Array<Record<string, unknown>> = [];
  const meshes: Array<Record<string, unknown>> = [];
  const nodes: Array<Record<string, unknown>> = [];
  let byteOffset = 0;
  const pushView = (data: Float32Array, withBounds: boolean): number => {
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.byteLength, target: 34962 });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: data.length / 3,
      type: 'VEC3',
      ...(withBounds ? aabb(data) : {}),
    });
    chunks.push(data);
    byteOffset += data.byteLength;
    return accessors.length - 1;
  };
  for (const part of parts) {
    const { appearance } = part;
    const materialKey = `${appearance.name}|${appearance.color}|${appearance.metalness}|${appearance.roughness}`;
    let material = materialIndex.get(materialKey);
    if (material === undefined) {
      material = materials.length;
      materialIndex.set(materialKey, material);
      materials.push({
        name: appearance.name,
        pbrMetallicRoughness: {
          baseColorFactor: linearColorFactor(appearance.color),
          metallicFactor: appearance.metalness,
          roughnessFactor: appearance.roughness,
        },
      });
    }
    const positions = new Float32Array(part.tris.length * 9);
    part.tris.forEach((tri, t) => tri.forEach((v, k) => positions.set(v, t * 9 + k * 3)));
    const position = pushView(positions, true);
    const normal = pushView(creasedNormals(part.tris), false);
    meshes.push({
      name: part.name,
      primitives: [{ attributes: { POSITION: position, NORMAL: normal }, mode: 4, material }],
    });
    nodes.push({
      name: part.name,
      mesh: meshes.length - 1,
      extras: { llullId: part.entityId, kind: part.kind },
    });
  }
  const bin = new Uint8Array(byteOffset);
  let offset = 0;
  for (const chunk of chunks) {
    bin.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
    offset += chunk.byteLength;
  }
  return {
    json: {
      asset: { version: '2.0', generator: 'llull' },
      scene: 0,
      scenes: [{ nodes: nodes.map((_, i) => i) }],
      nodes,
      meshes,
      materials,
      accessors,
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
    },
    bin,
  };
}
