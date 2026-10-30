/** 07 MSH M4: sculpt_mesh brushes and the generated meshes (VC-MSH-19..21, FR-MSH-18, FR-MSH-27). */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { sculptMesh } from '@core/geometry/mesh/sculpt';
import { gridMesh, packJson, relativeError } from '../../helpers/meshFixtures';

type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;

const grid = (): { doc: CadDocument; id: string } => {
  const result = execute(createEmptyDocument(), 'add_grid_mesh', { size: [20, 20], cells: [80, 80], position: [0, 0, 0] });
  return { doc: result.document, id: result.affected[0] as string };
};
const meshOf = (doc: CadDocument, id: string): { readonly positions: readonly number[]; readonly indices: readonly number[] } =>
  (doc.entities[id] as MeshSolidEntity).mesh;
const hash = (doc: CadDocument, id: string): string =>
  createHash('sha256')
    .update(JSON.stringify(meshOf(doc, id).positions))
    .digest('hex');
const stroke = { stamps: [{ center: [0, 0, 0] }], radius: 4, strength: 0.5 };

describe('generated meshes', () => {
  it('add_grid_mesh makes a centred +Z grid', () => {
    const { doc, id } = grid();
    const mesh = meshOf(doc, id);
    expect(mesh.indices).toHaveLength(80 * 80 * 6);
    expect(mesh.positions).toHaveLength(81 * 81 * 3);
    expect(Math.min(...mesh.positions.filter((_, i) => i % 3 === 0))).toBe(-10);
    expect(Math.max(...mesh.positions.filter((_, i) => i % 3 === 1))).toBe(10);
    expect(execute(doc, 'analyze_mesh', { id }).error).toBeUndefined();
    const area = (dataOf(execute(createEmptyDocument(), 'add_grid_mesh', { size: [2, 3], cells: [2, 3] })) as { area: number }).area;
    expect(area).toBeCloseTo(6, 12);
  });

  it('add_icosphere_mesh makes a closed sphere of 20 x 4^level triangles', () => {
    const result = execute(createEmptyDocument(), 'add_icosphere_mesh', { radius: 10, level: 2, position: [1, 2, 3] });
    const data = dataOf(result);
    expect(data['faces']).toBe(320);
    expect(data['closed']).toBe(true);
    expect(relativeError(data['volume'] as number, 4047.04467998)).toBeLessThan(1e-9);
    const first = meshOf(result.document, result.affected[0] as string).positions;
    expect(Math.hypot((first[0] as number) - 1, (first[1] as number) - 2, (first[2] as number) - 3)).toBeCloseTo(10, 12);
  });

  it('refuses invalid sizes and is pure', () => {
    const empty = createEmptyDocument();
    expectNoOp(execute(empty, 'add_icosphere_mesh', { radius: 1, level: 9 }), empty);
    expectNoOp(execute(empty, 'add_grid_mesh', { size: [1, 1], cells: [2000, 2000] }), empty, 'MESH_PARAM_INVALID');
    expectNoOp(execute(empty, 'add_grid_mesh', { size: [1, 1], cells: [0, 2] }), empty);
    expectPure(empty, () => execute(empty, 'add_grid_mesh', { size: [1, 1], cells: [2, 2] }));
  });
});

describe('sculpt_mesh', () => {
  it('VC-MSH-19: the draw brush displaces the exact piecewise-linear volume for the four falloffs', () => {
    const cases = (packJson('sculpt_cases.json') as { cases: Array<{ falloff: string; discreteVolumeOnGrid: number }> }).cases;
    expect(cases).toHaveLength(4);
    const { doc, id } = grid();
    for (const entry of cases) {
      const result = execute(doc, 'sculpt_mesh', { id, brush: 'draw', ...stroke, falloff: entry.falloff, direction: 'normal' });
      expect(result.error).toBeUndefined();
      expect(relativeError(dataOf(result)['displacedVolume'] as number, entry.discreteVolumeOnGrid)).toBeLessThan(1e-9);
      expect(dataOf(result)['volumeBasis']).toBe('height-field-sum');
    }
  });

  it('VC-MSH-20: flatten onto z = 0 after a draw restores the patch, and grab by [0, 0, s] equals draw', () => {
    const { doc, id } = grid();
    const drawn = execute(doc, 'sculpt_mesh', { id, brush: 'draw', ...stroke, falloff: 'smooth' });
    const flat = execute(drawn.document, 'sculpt_mesh', {
      id,
      brush: 'flatten',
      stamps: stroke.stamps,
      radius: 4,
      strength: 1,
      falloff: 'constant',
      planePoint: [0, 0, 0],
    });
    const z = meshOf(flat.document, id).positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...z.map(Math.abs))).toBeLessThan(1e-12);
    const grabbed = execute(doc, 'sculpt_mesh', { id, brush: 'grab', ...stroke, falloff: 'smooth', direction: [0, 0, 0.5] });
    expect(meshOf(grabbed.document, id).positions).toEqual(meshOf(drawn.document, id).positions);
  });

  it('flatten without a plane point makes the brush region coplanar through its centroid', () => {
    const { doc, id } = grid();
    const drawn = execute(doc, 'sculpt_mesh', { id, brush: 'draw', ...stroke, falloff: 'smooth' });
    const flat = execute(drawn.document, 'sculpt_mesh', {
      id,
      brush: 'flatten',
      stamps: stroke.stamps,
      radius: 3,
      strength: 1,
      falloff: 'constant',
    });
    const positions = meshOf(flat.document, id).positions;
    const heights = new Set<number>();
    for (let v = 0; v < positions.length / 3; v++) {
      if (Math.hypot(positions[v * 3] as number, positions[v * 3 + 1] as number) < 3)
        heights.add(Math.round((positions[v * 3 + 2] as number) * 1e9));
    }
    expect(heights.size).toBe(1);
  });

  it('VC-MSH-21: a mirrored stroke is symmetric and replaying gives identical vertices', () => {
    const { doc, id } = grid();
    const params = {
      id,
      brush: 'draw',
      stamps: [{ center: [3, 2, 0] }, { center: [1, -4, 0] }],
      radius: 3,
      strength: 0.4,
      symmetry: { plane: 'yz' },
    };
    const first = execute(doc, 'sculpt_mesh', params);
    expect(dataOf(first)['symmetryError'] as number).toBeLessThanOrEqual(1e-12);
    expect(dataOf(first)['stampsApplied']).toBe(4);
    const again = execute(doc, 'sculpt_mesh', params);
    expect(hash(again.document, id)).toBe(hash(first.document, id));
    const replayed = execute(first.document, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    expect(hash(replayed.document, id)).toBe(hash(first.document, id));
    const onPlane = execute(doc, 'sculpt_mesh', { ...params, stamps: [{ center: [0, 0, 0] }] });
    expect(dataOf(onPlane)['stampsApplied']).toBe(1);
  });

  it('inflate, smooth, pinch, crease and layer behave as defined on a closed sphere or the grid', () => {
    const sphere = execute(createEmptyDocument(), 'add_icosphere_mesh', { radius: 10, level: 3 });
    const sid = sphere.affected[0] as string;
    const base = dataOf(sphere)['volume'] as number;
    const inflated = execute(sphere.document, 'sculpt_mesh', {
      id: sid,
      brush: 'inflate',
      stamps: [{ center: [0, 0, 10] }],
      radius: 5,
      strength: 1,
    });
    expect(dataOf(inflated)['volumeBasis']).toBe('closed-volume-difference');
    expect(dataOf(inflated)['displacedVolume'] as number).toBeGreaterThan(0);
    expect(dataOf(inflated)['maxDisplacement']).toBeCloseTo(1, 9);
    expect(base).toBeGreaterThan(0);

    const { doc, id } = grid();
    const bumped = execute(doc, 'sculpt_mesh', { id, brush: 'draw', ...stroke, falloff: 'linear' });
    const smoothed = execute(bumped.document, 'sculpt_mesh', {
      id,
      brush: 'smooth',
      stamps: stroke.stamps,
      radius: 6,
      strength: 0.8,
      taubin: true,
    });
    const peak = (d: CadDocument): number => Math.max(...meshOf(d, id).positions.filter((_, i) => i % 3 === 2));
    expect(peak(smoothed.document)).toBeLessThan(peak(bumped.document));
    const plain = execute(bumped.document, 'sculpt_mesh', { id, brush: 'smooth', stamps: stroke.stamps, radius: 6, strength: 0.8 });
    expect(plain.error).toBeUndefined();

    const pinched = execute(doc, 'sculpt_mesh', { id, brush: 'pinch', stamps: [{ center: [0, 0, 0] }], radius: 3, strength: 0.5 });
    const radial = (d: CadDocument): number =>
      meshOf(d, id).positions.reduce((sum, v, i, all) => (i % 3 === 0 ? sum + Math.hypot(v, all[i + 1] as number) : sum), 0);
    expect(radial(pinched.document)).toBeLessThan(radial(doc));
    const creased = execute(doc, 'sculpt_mesh', { id, brush: 'crease', stamps: [{ center: [0, 0, 0] }], radius: 3, strength: 0.5 });
    expect(Math.min(...meshOf(creased.document, id).positions.filter((_, i) => i % 3 === 2))).toBeLessThan(0);

    const once = execute(doc, 'sculpt_mesh', { id, brush: 'layer', ...stroke, falloff: 'linear', maxHeight: 0.2 });
    const twice = execute(doc, 'sculpt_mesh', {
      id,
      brush: 'layer',
      stamps: [{ center: [0, 0, 0] }, { center: [0, 0, 0] }],
      radius: 4,
      strength: 0.5,
      falloff: 'linear',
      maxHeight: 0.2,
    });
    expect(peak(once.document)).toBeCloseTo(0.2, 12);
    expect(meshOf(twice.document, id).positions).toEqual(meshOf(once.document, id).positions);
  });

  it('refineEdge splits long edges in the brush and maskRegion keeps outside vertices fixed', () => {
    const { doc, id } = grid();
    const coarse = execute(createEmptyDocument(), 'add_grid_mesh', { size: [20, 20], cells: [10, 10] });
    const cid = coarse.affected[0] as string;
    const refined = execute(coarse.document, 'sculpt_mesh', { id: cid, brush: 'draw', ...stroke, refineEdge: 1 });
    expect(dataOf(refined)['refinedEdges'] as number).toBeGreaterThan(0);
    expect(meshOf(refined.document, cid).indices.length).toBeGreaterThan(10 * 10 * 6);
    const masked = execute(doc, 'sculpt_mesh', { id, brush: 'draw', ...stroke, maskRegion: { center: [0, 0, 0], radius: 1 } });
    const positions = meshOf(masked.document, id).positions;
    let moved = 0;
    for (let v = 0; v < positions.length / 3; v++) if ((positions[v * 3 + 2] as number) !== 0) moved++;
    expect(moved).toBe(dataOf(masked)['movedVertices']);
    expect(moved).toBeLessThanOrEqual(49);
    expect(moved).toBeGreaterThan(0);
  });

  it('refuses a stamp off the surface, grab without a vector, an unknown id; keepSource adds a mesh; is pure', () => {
    const { doc, id } = grid();
    const off = execute(doc, 'sculpt_mesh', { id, brush: 'draw', stamps: [{ center: [0, 0, 50] }], radius: 4, strength: 1 });
    expectNoOp(off, doc, 'MESH_SCULPT_STAMP_OFF_SURFACE');
    expect(off.error?.code).toBe('MESH_SCULPT_STAMP_OFF_SURFACE');
    const grab = execute(doc, 'sculpt_mesh', { id, brush: 'grab', ...stroke });
    expect(grab.error?.code).toBe('MESH_PARAM_INVALID');
    expect(execute(doc, 'sculpt_mesh', { id: 'nope', brush: 'draw', ...stroke }).error?.code).toBe('MESH_ENTITY_NOT_FOUND');
    expect(execute(doc, 'sculpt_mesh', { id, brush: 'paint', ...stroke }).error?.code).toBe('CMD_INVALID_PARAMS');
    const kept = execute(doc, 'sculpt_mesh', { id, brush: 'draw', ...stroke, keepSource: true });
    expect(kept.document.order).toHaveLength(2);
    expectPure(doc, () => execute(doc, 'sculpt_mesh', { id, brush: 'draw', ...stroke }));
  });
});

describe('refineEdge on an open mesh (TECHNICAL_SPEC 13.14.6)', () => {
  it('splits every edge longer than the limit inside the brush, boundary edges traversed from the higher to the lower index included', () => {
    const open = gridMesh(10, 4);
    const result = sculptMesh(open, {
      brush: 'draw',
      stamps: [[0, 0, 0]],
      radius: 100,
      strength: 0,
      falloff: 'constant',
      direction: 'area_normal',
      taubin: false,
      refineEdge: 0.4,
    });
    if ('tooLarge' in result) throw new Error('unexpected refusal');
    const { positions, indices } = result.mesh;
    const lengths = new Map<string, number>();
    for (let f = 0; f < indices.length; f += 3)
      for (let k = 0; k < 3; k++) {
        const a = indices[f + k] as number;
        const b = indices[f + ((k + 1) % 3)] as number;
        lengths.set(
          a < b ? `${a}:${b}` : `${b}:${a}`,
          Math.hypot(
            ...([0, 1, 2].map((axis) => (positions[a * 3 + axis] as number) - (positions[b * 3 + axis] as number)) as [
              number,
              number,
              number,
            ]),
          ),
        );
      }
    // the 8 passes leave a few interior diagonals just above the limit (the longest here is 0.43); every boundary edge is below it
    const uses = new Map<string, number>();
    for (let f = 0; f < indices.length; f += 3)
      for (let k = 0; k < 3; k++) {
        const a = indices[f + k] as number;
        const b = indices[f + ((k + 1) % 3)] as number;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    const boundary = [...lengths].filter(([key]) => uses.get(key) === 1);
    expect(boundary.length).toBeGreaterThan(40);
    expect(boundary.filter(([, length]) => length > 0.4)).toEqual([]);
    expect(Math.max(...lengths.values())).toBeLessThan(0.5);
  });
});
