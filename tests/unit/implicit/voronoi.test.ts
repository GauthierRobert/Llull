/** add_voronoi_lattice (05 IMP FR-IMP-19, VC-IMP-50): deterministic per seed, bounded by the region box, a graph the beam-lattice export can write. */
import { describe, expect, it } from 'vitest';
import { voronoiGeometry } from '@implicit/voronoi';
import { expectPure } from '../../helpers/expectNoOp';
import { empty, expectRefused, ok, run } from './helpers';

const region = (): ReturnType<typeof ok> =>
  ok(empty(), 'add_field_primitive', { shape: 'box', size: [20, 20, 20], position: [10, 10, 10] });

describe('add_voronoi_lattice', () => {
  it('is deterministic per seed, differs between seeds, and keeps every beam inside the box', () => {
    const box = region();
    // A, B, A: the last result is reused for equal parameters, so the second A is computed again after B replaced it
    const a = ok(box.doc, 'add_voronoi_lattice', { region: box.id, density: 0.02, seed: 7, radius: 0.4 });
    const c = ok(box.doc, 'add_voronoi_lattice', { region: box.id, density: 0.02, seed: 8, radius: 0.4 });
    const b = ok(box.doc, 'add_voronoi_lattice', { region: box.id, density: 0.02, seed: 7, radius: 0.4 });
    expect(a.doc.implicit?.fields[a.id]).toEqual({ ...b.doc.implicit?.fields[b.id], id: a.id });
    expect(a.data['totalLength']).toBe(b.data['totalLength']);
    expect(a.data['totalLength']).not.toBe(c.data['totalLength']);
    expect(a.data['beams'] as number).toBeGreaterThan(50);
    const node = a.doc.implicit?.fields[a.id];
    if (node?.op !== 'voronoi') throw new Error('voronoi node expected');
    const built = voronoiGeometry(node);
    if (!built.ok) throw new Error(built.message);
    for (const p of built.graph.set.nodes)
      for (const axis of [0, 1, 2]) expect([p[axis]! >= -1e-9, p[axis]! <= 20 + 1e-9]).toEqual([true, true]);
    expect(a.result.summary).toContain('seed 7');
  });

  it('realises as a closed body and is written as a beam lattice', () => {
    const small = ok(empty(), 'add_field_primitive', { shape: 'box', size: [6, 6, 6], position: [3, 3, 3] });
    const lattice = ok(small.doc, 'add_voronoi_lattice', { region: small.id, density: 0.05, seed: 3, radius: 0.3 });
    const body = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.2 });
    expect(body.data['closedManifold']).toBe(true);
    const out = ok(body.doc, 'export_3mf', { entityIds: [body.id], beamLattice: true });
    expect((out.data['beamLattice'] as { written: string[] }).written).toEqual([body.id]);
  });

  it('is editable through edit_field and is pure', () => {
    const box = region();
    const lattice = ok(box.doc, 'add_voronoi_lattice', { region: box.id, density: 0.02, seed: 1, radius: 0.4 });
    const edited = ok(lattice.doc, 'edit_field', { id: lattice.id, changes: { seed: 2 } });
    expect((edited.doc.implicit?.fields[lattice.id] as { seed?: number }).seed).toBe(2);
    expectPure(box.doc, () => run(box.doc, 'add_voronoi_lattice', { region: box.id, density: 0.02, seed: 1, radius: 0.4 }));
  });

  it('refuses bad input with stable codes', () => {
    const box = region();
    const base = { region: box.id, density: 0.02, seed: 1, radius: 0.4 };
    expectRefused(box.doc, run(box.doc, 'add_voronoi_lattice', { ...base, region: 'nope' }), 'IMP_FIELD_NOT_FOUND');
    expectRefused(box.doc, run(box.doc, 'add_voronoi_lattice', { ...base, density: 0 }), 'IMP_PARAM_RANGE');
    expectRefused(box.doc, run(box.doc, 'add_voronoi_lattice', { ...base, seed: 1.5 }), 'IMP_PARAM_RANGE');
    expectRefused(box.doc, run(box.doc, 'add_voronoi_lattice', { ...base, radius: 0 }), 'IMP_STRUT_RADIUS_RANGE');
    expectRefused(box.doc, run(box.doc, 'add_voronoi_lattice', { ...base, density: 500 }), 'IMP_GRAPH_TOO_LARGE');
    const plane = ok(empty(), 'add_field_primitive', { shape: 'plane', normal: [0, 0, 1], offset: 0 });
    expectRefused(plane.doc, run(plane.doc, 'add_voronoi_lattice', { ...base, region: plane.id }), 'IMP_FIELD_UNBOUNDED');
  });

  it('reports no beam when the box is far smaller than the cell', () => {
    const built = voronoiGeometry({ min: [0, 0, 0], max: [1e-6, 1e-6, 1e-6], density: 1e-12, seed: 5, radius: 1, cap: 'sphere' });
    expect(built.ok).toBe(false);
  });

  it('pins the beams, nodes and content hash of seeded diagrams (no sliver: unchanged by the exact predicates, 05 IMP 14.14)', () => {
    const geometry = (count: number, seed: number): { beams: number; nodes: number; signature: number } => {
      const side = Math.cbrt(count / 0.1);
      const built = voronoiGeometry({ min: [0, 0, 0], max: [side, side, side], density: 0.1, seed, radius: 0.3, cap: 'sphere' });
      if (!built.ok) throw new Error(built.message);
      const { nodes, beams } = built.graph.set;
      const signature =
        beams.reduce((h, b) => (Math.imul(h, 31) + b.a * 7 + b.b) >>> 0, 17) ^
        nodes.reduce((h, p) => (Math.imul(h, 33) + Math.round(p[0] * 1e6) + Math.round(p[1] * 1e6) * 3) >>> 0, 5);
      return { beams: beams.length, nodes: nodes.length, signature };
    };
    expect(geometry(200, 1)).toEqual({ beams: 3046, nodes: 1949, signature: -110666505 });
    expect(geometry(900, 7)).toEqual({ beams: 13266, nodes: 7812, signature: -75426103 });
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [12, 12, 12], position: [6, 6, 6] });
    const lattice = ok(box.doc, 'add_voronoi_lattice', { region: box.id, density: 0.12, seed: 5, radius: 0.3 });
    expect(lattice.data['beams']).toBe(3296);
    const body = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.4 });
    expect(body.data['contentHash']).toBe('9c0effbbffee37c61d244abe51d926fc0abc6a81d2a893f0cdeee664986faf28');
  });
});
