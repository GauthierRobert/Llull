/**
 * import_mesh — create mesh solids from world-space triangle data (STEP import, code import fallback).
 *
 * @layer core/commands
 */

import type { CadDocument, Entity } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { nextId } from '../lib/id';
import { MAX_IMPORT_BODIES, MAX_IMPORT_TRIANGLES } from './limits';
import { noop } from './noop';

interface MeshBodyParams {
  positions: number[];
  indices?: number[];
  name?: string;
  color?: string;
}

const DEFAULT_MESH_COLOR = '#9aa5b1';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Expand to a triangle soup (positions per corner, indices 0..n-1) so every consumer agrees. */
function toTriangleSoup(body: MeshBodyParams): number[] | string {
  const { positions, indices } = body;
  if (!Array.isArray(positions) || positions.length % 3 !== 0) {
    return 'positions must be a flat [x,y,z, ...] number array';
  }
  if (!positions.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return 'positions must be finite numbers';
  }
  if (indices === undefined) {
    if (positions.length % 9 !== 0 || positions.length === 0) {
      return 'without indices, positions must hold whole triangles (9 numbers each)';
    }
    return positions;
  }
  const vertexCount = positions.length / 3;
  if (!Array.isArray(indices) || indices.length === 0 || indices.length % 3 !== 0) {
    return 'indices must be a non-empty multiple of 3';
  }
  const soup: number[] = [];
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
      return `index ${String(index)} is outside 0..${vertexCount - 1}`;
    }
    soup.push(
      positions[index * 3] ?? 0,
      positions[index * 3 + 1] ?? 0,
      positions[index * 3 + 2] ?? 0,
    );
  }
  return soup;
}

function fail(doc: CadDocument, reason: string): CommandResult {
  return noop(doc, `import_mesh: ${reason}; no-op.`);
}

/**
 * @command import_mesh
 * @pure
 * @layer core/commands
 * @affects creates 1 mesh entity per body, in body order
 * @invariant stored mesh is a world-space triangle soup: indices = 0..n-1, position = [0,0,0]
 * @failure empty bodies / malformed positions or indices / over limits -> no-op, affected:[]
 */
export const importMesh = defineCommand({
  name: 'import_mesh',
  description:
    'Create mesh solids from world-space triangle data — the landing point for STEP import and for ' +
    'code-imported shapes that have no analytic llull primitive. Each body becomes one mesh entity ' +
    '(optionally named and coloured). Meshes render, measure and export but have no editable dimensions.',
  params: z.object({
    bodies: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Bodies to create. Each: { positions: [x,y,z, ...] world-space numbers, indices?: [i0,i1,i2, ...] ' +
          '(omit for a triangle soup of 9 numbers per triangle), name?: string, color?: "#rrggbb" }.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const bodies = params.bodies as unknown as MeshBodyParams[];
    if (bodies.length === 0) return fail(doc, 'bodies must be a non-empty array');
    if (bodies.length > MAX_IMPORT_BODIES) {
      return fail(doc, `${bodies.length} bodies exceeds MAX_IMPORT_BODIES (${MAX_IMPORT_BODIES})`);
    }
    const entities: Record<string, Entity> = { ...doc.entities };
    const order = [...doc.order];
    const affected: string[] = [];
    let triangleCount = 0;
    for (const [i, body] of bodies.entries()) {
      const soup = toTriangleSoup(body);
      if (typeof soup === 'string') return fail(doc, `body ${i}: ${soup}`);
      triangleCount += soup.length / 9;
      if (triangleCount > MAX_IMPORT_TRIANGLES) {
        return fail(doc, `more than MAX_IMPORT_TRIANGLES (${MAX_IMPORT_TRIANGLES}) triangles`);
      }
      const id = nextId('mesh');
      const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name : undefined;
      const entity: Entity = {
        id,
        kind: 'mesh',
        mesh: { positions: soup, indices: Array.from({ length: soup.length / 3 }, (_, n) => n) },
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        layerId: DEFAULT_LAYER_ID,
        color:
          typeof body.color === 'string' && HEX_COLOR.test(body.color)
            ? body.color
            : DEFAULT_MESH_COLOR,
        ...(name !== undefined ? { name } : {}),
      };
      entities[id] = entity;
      order.push(id);
      affected.push(id);
    }
    return {
      document: { ...doc, entities, order },
      summary: `Imported ${affected.length} mesh bod${affected.length === 1 ? 'y' : 'ies'} (${triangleCount} triangles): ${affected.join(', ')}.`,
      affected,
    };
  },
});
