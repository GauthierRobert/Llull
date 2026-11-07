import { describe, it, expect } from 'vitest';
import { type ExtrusionEntity, type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp } from '../helpers/expectNoOp';
import { docWith, volumeOf as massVolume } from '../helpers/fixtureDocument';
import { manifoldSuite, meshOf, volumeOf } from '../helpers/featureSupport';

const plate = { id: 'plate', kind: 'rectangle', width: 100, height: 60 };
const hole = { id: 'hole', kind: 'circle', center: [50, 30], radius: 10 };

describe('extrude_profile of a region without a kernel', () => {
  it('a region without holes is an exact extrusion: the outer loop, curves kept, region kept', () => {
    const doc = execute(docWith(hole), 'hatch_region', { ids: ['hole'] }).document;
    const regionId = doc.order[1] as string;
    const result = execute(doc, 'extrude_profile', { id: regionId, depth: 7 });
    expect(result.affected).toHaveLength(1);
    const solid = result.document.entities[result.affected[0] as string] as ExtrusionEntity;
    expect(solid.kind).toBe('extrusion');
    expect(solid.depth).toBe(7);
    expect(solid.curves).toHaveLength(2);
    expect(result.document.entities[regionId]?.kind).toBe('region');
    expect(result.summary).toContain(`region "${regionId}"`);
    // pi r^2 h = 100 pi * 7, exact kernel-free mass properties integrate the 32-gon (0.64 % low)
    expect(massVolume(result.document, solid.id) / (700 * Math.PI)).toBeCloseTo(1, 1);
  });

  it('holes need a kernel: REGION_NEEDS_KERNEL, unchanged document', () => {
    const doc = execute(docWith(plate, hole), 'hatch_region', { ids: ['plate', 'hole'] }).document;
    const result = execute(doc, 'extrude_profile', { id: doc.order[2] as string, depth: 10 });
    expectNoOp(result, doc, 'REGION_NEEDS_KERNEL');
    expect(result.error?.code).toBe('REGION_NEEDS_KERNEL');
  });

  it('refuses depth <= 0 on a region', () => {
    const doc = execute(docWith(plate), 'hatch_region', { ids: ['plate'] }).document;
    expectNoOp(execute(doc, 'extrude_profile', { id: doc.order[1] as string, depth: 0 }), doc, 'depth must be > 0');
  });
});

describe('extrude_profile of a region with a kernel', () => {
  manifoldSuite();

  it('plate with a diameter-20 hole, 10 deep: (6000 - 100 pi) x 10 = 56858.4 (polygon hole within 0.5 %)', () => {
    const doc = execute(docWith(plate, hole), 'hatch_region', { ids: ['plate', 'hole'] }).document;
    const regionId = doc.order[2] as string;
    const result = execute(doc, 'extrude_profile', { id: regionId, depth: 10 });
    expect(result.affected, result.summary).toHaveLength(1);
    const id = result.affected[0] as string;
    expect(meshOf(result.document, id).kind).toBe('mesh');
    expect(volumeOf(result.document, id) / ((6000 - 100 * Math.PI) * 10)).toBeCloseTo(1, 2);
    expect(result.summary).toContain('1 hole loop(s) subtracted');
    expect(result.document.entities[regionId]?.kind).toBe('region');
  });

  it('an island inside a hole is united back: 100x100 - 60x60 + 20x20, 5 deep = 6800 x 5', () => {
    const rect = (id: string, size: number, at: number): Record<string, unknown> => ({
      id,
      kind: 'rectangle',
      width: size,
      height: size,
      position: [at, at, 0],
    });
    const doc = execute(docWith(rect('o', 100, 0), rect('h', 60, 20), rect('i', 20, 40)), 'hatch_region', {
      ids: ['o', 'h', 'i'],
    }).document;
    const result = execute(doc, 'extrude_profile', { id: doc.order[3] as string, depth: 5 });
    expect(result.affected).toHaveLength(1);
    expect(volumeOf(result.document, result.affected[0] as string)).toBeCloseTo(6800 * 5, 3);
  });

  it('honours position and axis overrides', () => {
    const doc = execute(docWith(plate, hole), 'hatch_region', { ids: ['plate', 'hole'] }).document;
    const result = execute(doc, 'extrude_profile', { id: doc.order[2] as string, depth: 2, position: [0, 0, 5] });
    const mesh = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    const zs = mesh.mesh.positions.filter((_, k) => k % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(5, 6);
    expect(Math.max(...zs)).toBeCloseTo(7, 6);
  });

  it('empty document stays empty without a region id', () => {
    const empty = createEmptyDocument();
    expectNoOp(execute(empty, 'extrude_profile', { id: 'nope', depth: 1 }), empty);
  });
});
