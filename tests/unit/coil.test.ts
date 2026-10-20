import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity, type SweepEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { idOf, manifoldSuite, volumeOf } from '../helpers/featureSupport';

manifoldSuite();

const EMPTY = createEmptyDocument();
const coil = (params: Record<string, unknown>, doc: CadDocument = EMPTY): ReturnType<typeof execute> => execute(doc, 'add_coil', params);

/** Volume of a sweep or mesh entity measured by mass_properties (kernel / tessellation). */
function measured(result: ReturnType<typeof execute>): number {
  const mass = execute(result.document, 'mass_properties', { entityId: idOf(result) });
  return (mass.data as { volume: number }).volume;
}

describe('add_coil: round wire', () => {
  const spec = { radius: 10, pitch: 5, turns: 6, sectionDiameter: 2 };

  it('sweeps a circle along the helix: Pappus volume pi r^2 L within the tessellation envelope', () => {
    const doc = createEmptyDocument();
    const result = coil(spec, doc);
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toEqual(result.affected);
    const entity = result.document.entities[idOf(result)] as SweepEntity;
    expect(entity.kind).toBe('sweep');
    expect(entity.section).toEqual({ shape: 'circle', radius: 1 });
    const length = 6 * Math.hypot(2 * Math.PI * 10, 5);
    const data = result.data as { centreLineLength: number; analyticVolume: number; height: number; sectionArea: number };
    expect(data.centreLineLength).toBeCloseTo(length, 6);
    expect(data.analyticVolume).toBeCloseTo(Math.PI * length, 6);
    expect(data.sectionArea).toBeCloseTo(Math.PI, 12);
    expect(data.height).toBeCloseTo(32, 12);
    expect(Math.abs(measured(result) - data.analyticVolume) / data.analyticVolume).toBeLessThan(0.03);
    const bounds = rotatedEntityBounds(entity);
    expect(bounds.min[2]).toBeCloseTo(0, 1);
    expect(bounds.max[2]).toBeCloseTo(32, 0);
    expect(bounds.max[0]).toBeGreaterThan(10.8);
    expectPure(doc, () => coil(spec, doc));
  });

  it('left hand mirrors the helix; axis and position place it', () => {
    const right = coil(spec).document.entities;
    const left = coil({ ...spec, handedness: 'left' }).document.entities;
    const [rightPath, leftPath] = [Object.values(right)[0] as SweepEntity, Object.values(left)[0] as SweepEntity];
    expect(leftPath.path[2]?.points[1]?.[1]).toBeCloseTo(-(rightPath.path[2]?.points[1]?.[1] as number), 9);
    const placed = coil({ ...spec, axis: [1, 0, 0], position: [10, 0, 0] });
    const bounds = rotatedEntityBounds(placed.document.entities[idOf(placed)] as SweepEntity);
    expect(bounds.min[0]).toBeCloseTo(10, 0);
    expect(bounds.max[0]).toBeCloseTo(42, 0);
  });

  it('a conical coil integrates the centre-line length', () => {
    const result = coil({ radius: 12, endRadius: 6, pitch: 4, turns: 5, sectionRadius: 0.8 });
    const data = result.data as { centreLineLength: number };
    let numeric = 0;
    const steps = 100000;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const r = 12 - 6 * t;
      numeric += Math.hypot(r, -6 / (2 * Math.PI * 5), 4 / (2 * Math.PI)) * ((2 * Math.PI * 5) / steps);
    }
    expect(data.centreLineLength).toBeCloseTo(numeric, 4);
  });
});

describe('add_coil: rectangular (flat) wire', () => {
  const flat = { sectionShape: 'rectangle', sectionWidth: 2, sectionHeight: 1.5, radius: 10, pitch: 3, turns: 4 };

  it('screws a radial x axial rectangle: volume = w h 2 pi R turns', () => {
    const result = coil(flat);
    expect(result.affected).toHaveLength(1);
    const mesh = result.document.entities[idOf(result)] as MeshSolidEntity;
    expect(mesh.kind).toBe('mesh');
    const analytic = 2 * 1.5 * 2 * Math.PI * 10 * 4;
    expect((result.data as { analyticVolume: number }).analyticVolume).toBeCloseTo(analytic, 9);
    expect(Math.abs(volumeOf(result.document, idOf(result)) - analytic) / analytic).toBeLessThan(0.005);
    const ys = mesh.mesh.positions.filter((_, i) => i % 3 === 2);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(3 * 4 + 1.5, 6);
  });

  it('keeps the width radial on a conical flat coil and honours the axis', () => {
    const result = coil({ ...flat, endRadius: 6, axis: [0, 1, 0] });
    const analytic = 2 * 1.5 * 2 * Math.PI * ((10 + 6) / 2) * 4;
    expect(Math.abs(volumeOf(result.document, idOf(result)) - analytic) / analytic).toBeLessThan(0.01);
    const mesh = result.document.entities[idOf(result)] as MeshSolidEntity;
    const rise = mesh.mesh.positions.filter((_, i) => i % 3 === 1);
    expect(Math.min(...rise)).toBeCloseTo(0, 6);
    expect(Math.max(...rise)).toBeCloseTo(13.5, 6);
  });
});

describe('add_coil: refusals', () => {
  it('refuses a self-intersecting coil (section as large as the pitch) and an over-wide section', () => {
    const doc = EMPTY;
    expectNoOp(coil({ radius: 10, pitch: 2, turns: 3, sectionDiameter: 2 }), doc, 'neighbouring turns overlap');
    expectNoOp(coil({ radius: 10, pitch: 1.5, turns: 3, sectionDiameter: 2 }), doc, 'neighbouring turns overlap');
    expectNoOp(
      coil({ radius: 10, pitch: 2, turns: 3, sectionShape: 'rectangle', sectionWidth: 1, sectionHeight: 2 }),
      doc,
      'neighbouring turns overlap',
    );
    expectNoOp(coil({ radius: 1, pitch: 5, turns: 3, sectionDiameter: 2.5 }), doc, 'smallest coil radius');
    expectNoOp(coil({ radius: 10, endRadius: 1, pitch: 5, turns: 3, sectionDiameter: 3 }), doc, 'smallest coil radius');
  });

  it('refuses bad dimensions, missing section sizes and a zero axis', () => {
    const doc = EMPTY;
    const base = { radius: 10, pitch: 5, turns: 3, sectionDiameter: 2 };
    expectNoOp(coil({ ...base, turns: 0.01 }), doc, 'turns must be in');
    expectNoOp(coil({ ...base, turns: 500 }), doc, 'turns must be in');
    expectNoOp(coil({ ...base, radius: -1 }), doc, 'finite and > 0');
    expectNoOp(coil({ ...base, endRadius: 0 }), doc, 'finite and > 0');
    expectNoOp(coil({ radius: 10, pitch: 5, turns: 3 }), doc, 'sectionRadius or sectionDiameter');
    expectNoOp(coil({ radius: 10, pitch: 5, turns: 3, sectionShape: 'rectangle', sectionWidth: 1 }), doc, 'sectionWidth and sectionHeight');
    expectNoOp(coil({ ...base, axis: [0, 0, 0] }), doc, 'axis');
  });
});
