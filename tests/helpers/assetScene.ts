/** Asset-backed fixtures: a display cube of edge 1 standing for a stored mesh (a cube of edge 10 by default). USE IN TESTS ONLY. */

import { createHash } from 'node:crypto';
import { defaultContext } from '@core/commands/context';
import { newEntity } from '@core/commands/entity/newEntity';
import type { ExecutionContext } from '@core/commands/types';
import { type CadDocument, createEmptyDocument, type Entity, type MeshData } from '@core/model/types';
import { memoryMeshAssets } from './memoryMeshAssets';

function extentOf(mesh: MeshData): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  mesh.positions.forEach((value, index) => {
    min[index % 3] = Math.min(min[index % 3] as number, value);
    max[index % 3] = Math.max(max[index % 3] as number, value);
  });
  return { min, max };
}

export function cube(size: number): MeshData {
  const positions: number[] = [];
  for (let corner = 0; corner < 8; corner++) positions.push((corner & 1) * size, ((corner >> 1) & 1) * size, ((corner >> 2) & 1) * size);
  // prettier-ignore
  const indices = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  return { positions, indices };
}

export interface Backed {
  readonly id: string;
  /** Edge of the stored (full-resolution) cube; the display cube has edge 1. */
  readonly full?: number;
  /** The stored mesh itself (default: a cube of edge `full`). */
  readonly fullMesh?: MeshData;
  /** Triangle count the asset reference claims (the cap tests inflate it). */
  readonly claimed?: number;
  /** False: this machine does not hold the asset. */
  readonly held?: boolean;
}

export function scene(items: readonly Backed[], extra: readonly Entity[] = []): { doc: CadDocument; ctx: ExecutionContext } {
  const assets = memoryMeshAssets();
  const entities: Record<string, Entity> = {};
  for (const item of items) {
    const key = createHash('sha256').update(item.id).digest('hex');
    const full = item.fullMesh ?? cube(item.full ?? 10);
    if (item.held !== false) assets.meshes.set(key, full);
    const asset = { key, triangles: item.claimed ?? 12, vertices: 8, bounds: extentOf(full) };
    entities[item.id] = newEntity('mesh', item.id, { mesh: cube(1), asset }, [0, 0, 0], '#cccccc');
  }
  for (const entity of extra) entities[entity.id] = entity;
  const doc: CadDocument = { ...createEmptyDocument(), units: 'm', entities, order: Object.keys(entities) };
  return { doc, ctx: { ...defaultContext(), meshAssets: assets } };
}
