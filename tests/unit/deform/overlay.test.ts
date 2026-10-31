/** 01 DEF M4: `deform_overlay`, the read-only geometry the viewport draws for a deformed body (frame, region, lattice net, flow curves, flow sheets, reference wire). Mesh path. */

import { afterEach, describe, expect, it } from 'vitest';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { DeformLaw } from '@core/model/deform';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { resolveFrame } from '@core/geometry/deform/frame';
import { deformOverlay } from '@core/geometry/deform/overlay';
import { referenceWire } from '@core/geometry/deform/referenceWire';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { WORLD_Z, addBox, dataOf, installKernel } from './harness';

afterEach(() => setGeometryKernel(null));

interface Overlay {
  readonly frame: { origin: Vec3; x: Vec3; y: Vec3; z: Vec3; length: number };
  readonly region: { start: number; end: number; infinite: boolean; startCentre: Vec3; endCentre: Vec3; radius: number } | null;
  readonly lattice: {
    degrees: number[];
    splineDegrees: number[] | null;
    oriented: boolean;
    rest: Vec3[];
    moved: Vec3[];
    box: Vec3[];
    displaced: number;
  } | null;
  readonly flow: { target: Vec3[]; base: Vec3[] | null } | null;
  readonly sheet: { nx: number; ny: number; target: Vec3[]; base: Vec3[] | null } | null;
  readonly reference: Vec3[][] | null;
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const curve = (doc: CadDocument, name: string, params: Record<string, unknown>): { doc: CadDocument; id: string } => {
  const made = execute(doc, name, params);
  expect(made.error, made.summary).toBeUndefined();
  return { doc: made.document, id: made.affected[0] as string };
};

describe('deform_overlay of a deformed body', () => {
  it('an infinite twist region: the frame axes, the planes at the region ends on the axis, no lattice, flow, sheet or reference', async () => {
    await installKernel('none');
    const { doc, id } = addBox();
    const twisted = execute(doc, 'twist_body', {
      id,
      angleDeg: 36,
      frame: WORLD_Z,
      region: { start: 0, end: 20, infinite: true },
      output: { tolerance: 0.01 },
    });
    const next = twisted.affected[0] as string;
    const result = execute(twisted.document, 'deform_overlay', { id: next });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf<Overlay>(result);
    expect(data.frame.origin).toEqual([0, 0, 0]);
    expect(data.frame.z).toEqual([0, 0, 1]);
    expect(data.frame.x).toEqual([1, 0, 0]);
    expect(data.frame.length).toBeGreaterThan(0);
    expect(data.region).toMatchObject({ start: 0, end: 20, infinite: true, startCentre: [0, 0, 0], endCentre: [0, 0, 20] });
    expect(data.region?.radius).toBeGreaterThan(50);
    expect([data.lattice, data.flow, data.sheet, data.reference]).toEqual([null, null, null, null]);
    expect(result.summary).toContain('infinite region');
    expectPure(twisted.document, () => execute(twisted.document, 'deform_overlay', { id: next }));
  });

  it('a B-spline lattice: the net at rest on the Greville abscissae, the moved control point displaced by its offset (world), the box corners', async () => {
    await installKernel('none');
    const { doc, id } = addBox([10, 10, 100]);
    const made = execute(doc, 'deform_lattice', {
      id,
      degrees: [2, 2, 6],
      box: { min: [-5, -5, 0], max: [5, 5, 100] },
      splineDegrees: [2, 2, 2],
      frame: WORLD_Z,
      moves: [{ index: [1, 1, 3], delta: [2, 0, 0] }],
      output: { tolerance: 0.01 },
    });
    expect(made.error, made.summary).toBeUndefined();
    const { lattice } = dataOf<Overlay>(execute(made.document, 'deform_overlay', { id: made.affected[0] }));
    expect(lattice).toMatchObject({ degrees: [2, 2, 6], splineDegrees: [2, 2, 2], oriented: false, displaced: 1 });
    expect(lattice?.rest).toHaveLength(3 * 3 * 7);
    // control point (1, 1, 3): the middle of the box on a symmetric clamped net, moved by 2 along x
    const slot = (1 * 3 + 1) * 7 + 3;
    expect(lattice?.rest[slot]).toEqual([0, 0, 50]);
    expect(lattice?.moved[slot]).toEqual([2, 0, 50]);
    expect(lattice?.moved.filter((p, i) => distance(p, (lattice?.rest as Vec3[])[i] as Vec3) > 0)).toHaveLength(1);
    expect(lattice?.box).toHaveLength(8);
    expect(lattice?.box[0]).toEqual([-5, -5, 0]);
    expect(lattice?.box[7]).toEqual([5, 5, 100]);
  });

  it('an oriented lattice reports its box corners rotated into the world', async () => {
    await installKernel('none');
    const { doc, id } = addBox([10, 10, 100]);
    const made = execute(doc, 'deform_lattice', {
      id,
      degrees: [2, 2, 2],
      box: { min: [-8, -1, -8], max: [8, 101, 8] },
      orientation: { uAxis: [1, 1, 0], vAxis: [0, 0, 1] },
      frame: WORLD_Z,
      moves: [{ index: [1, 1, 1], delta: [0, 0, 1] }],
      fixedLayers: 0,
      output: { tolerance: 0.01 },
    });
    expect(made.error, made.summary).toBeUndefined();
    const { lattice } = dataOf<Overlay>(execute(made.document, 'deform_overlay', { id: made.affected[0] }));
    expect(lattice?.oriented).toBe(true);
    // the first corner is (-8, -1, -8) in box coordinates: u = (1, 1, 0) / sqrt 2 and w = (1, -1, 0) / sqrt 2 put it at x = (-8 - 8) / sqrt 2, y = (-8 + 8) / sqrt 2
    const corner = lattice?.box[0] as Vec3;
    expect(corner[0]).toBeCloseTo(-16 * Math.SQRT1_2, 9);
    expect(corner[1]).toBeCloseTo(0, 9);
    expect(corner[2]).toBeCloseTo(-1, 9);
  });

  it('a flow with a base curve: the target curve stations and the base curve stations, starting on the curves', async () => {
    await installKernel('none');
    const bar = addBox([10, 10, 78.5], 'base-center');
    const arc = curve(bar.doc, 'create_conic', { start: [100, 0, 0], apex: [100, 0, 50], end: [100, 50, 50], rho: Math.SQRT2 - 1 });
    const base = curve(arc.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, -20],
        [0, 0, 100],
      ],
    });
    const flowed = execute(base.doc, 'flow_along_curve', { id: bar.id, targetId: arc.id, baseCurve: base.id, frame: WORLD_Z, output: { tolerance: 0.01 } });
    expect(flowed.error, flowed.summary).toBeUndefined();
    const { flow, region } = dataOf<Overlay>(execute(flowed.document, 'deform_overlay', { id: flowed.affected[0] }));
    expect(region).toBeNull();
    expect(flow?.target.length).toBeGreaterThan(10);
    expect(flow?.base?.length).toBeGreaterThan(10);
    expect(distance((flow?.target as Vec3[])[0] as Vec3, [100, 0, 0])).toBeLessThan(1e-6);
    expect(distance((flow?.base as Vec3[])[0] as Vec3, [0, 0, -20])).toBeLessThan(1e-6);
    // without a base curve there is none to draw
    const plain = execute(arc.doc, 'flow_along_curve', { id: bar.id, targetId: arc.id, frame: WORLD_Z, output: { tolerance: 0.01 } });
    expect(dataOf<Overlay>(execute(plain.document, 'deform_overlay', { id: plain.affected[0] })).flow?.base).toBeNull();
  });

  it('a flow onto a surface: the nodes of the target sheet and of the base sheet in world coordinates (pure overlay of the tabulated law)', () => {
    const frame = resolveFrame({ origin: [10, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] });
    if (frame === null) throw new Error('frame');
    const law: DeformLaw = {
      kind: 'flowSurface',
      x0: 0,
      y0: 0,
      hx: 1,
      hy: 1,
      nx: 2,
      ny: 2,
      nodes: [0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 0, 2, 0, 0, 1, 1, 1, 2, 0, 0, 1],
      baseNodes: [0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1],
    };
    const overlay = deformOverlay(law, undefined, frame, 10);
    expect(overlay.sheet).toMatchObject({ nx: 2, ny: 2 });
    expect(overlay.sheet?.target).toEqual([
      [10, 0, 0],
      [10, 1, 0],
      [11, 0, 2],
      [11, 1, 2],
    ]);
    expect(overlay.sheet?.base?.[2]).toEqual([11, 0, 0]);
    expect(overlay.region).toBeNull();
  });

  it('compareTo draws the wire of the reference shape around the body: a torus rings at distance R +- r from its axis', async () => {
    await installKernel('none');
    const { doc, id } = addBox();
    const twisted = execute(doc, 'twist_body', { id, angleDeg: 30, frame: WORLD_Z, output: { tolerance: 0.01 } });
    const next = twisted.affected[0] as string;
    const torus = { kind: 'torus', majorRadius: 60, minorRadius: 5, center: [0, 0, 0], axis: [0, 0, 1] };
    const { reference } = dataOf<Overlay>(execute(twisted.document, 'deform_overlay', { id: next, compareTo: torus }));
    expect(reference?.length).toBe(14);
    const outer = reference?.[0] as Vec3[];
    for (const p of outer) expect(Math.hypot(p[0], p[1])).toBeCloseTo(65, 9);
    const inner = reference?.[1] as Vec3[];
    for (const p of inner) expect(Math.hypot(p[0], p[1])).toBeCloseTo(55, 9);
  });

  it('every reference kind has a wire; a missing field is refused by name', () => {
    const extent = { centre: [0, 0, 50] as Vec3, radius: 60 };
    const shapes = [
      { kind: 'sphere', center: [0, 0, 0], radius: 10 },
      { kind: 'spheroid', center: [0, 0, 0], semiAxes: [10, 20, 30] },
      { kind: 'cylinder', radius: 6, point: [0, 0, 0], axis: [0, 0, 1] },
      { kind: 'ellipticCylinder', point: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0], radii: [6, 3] },
      { kind: 'cone', apex: [0, 0, 0], axis: [0, 0, 1], halfAngleDeg: 20 },
      { kind: 'plane', point: [0, 0, 0], normal: [0, 0, 1] },
      { kind: 'helicoid', point: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0], rate: 0.05, offset: 1 },
    ] as const;
    for (const shape of shapes) {
      const wire = referenceWire(shape as never, extent);
      expect(wire, shape.kind).not.toBeNull();
      expect((wire as Vec3[][]).length, shape.kind).toBeGreaterThan(3);
      expect((wire as Vec3[][]).flat().every((p) => p.every(Number.isFinite)), shape.kind).toBe(true);
    }
    expect(referenceWire({ kind: 'torus', majorRadius: 5 }, extent)).toBeNull();
    // the plane is drawn through the foot of the body centre
    const plane = referenceWire({ kind: 'plane', point: [0, 0, 10], normal: [0, 0, 1] }, extent) as Vec3[][];
    expect(plane.flat().every((p) => Math.abs(p[2] - 10) < 1e-9)).toBe(true);
  });
});

describe('deform_overlay refusals', () => {
  it('an unknown id, an entity that was not deformed, and a compareTo with a missing field are named no-ops', async () => {
    await installKernel('none');
    const { doc, id } = addBox();
    const missing = execute(doc, 'deform_overlay', { id: 'nope' });
    expect(missing.error?.code).toBe('DEF_ENTITY_NOT_FOUND');
    expectNoOp(doc, missing);
    const plain = execute(doc, 'deform_overlay', { id });
    expect(plain.error?.code).toBe('DEF_NOT_DEFORMED');
    const twisted = execute(doc, 'twist_body', { id, angleDeg: 30, frame: WORLD_Z, output: { tolerance: 0.01 } });
    const invalid = execute(twisted.document, 'deform_overlay', { id: twisted.affected[0], compareTo: { kind: 'torus', majorRadius: 5 } });
    expect(invalid.error?.code).toBe('DEF_COMPARE_INVALID');
    expect(invalid.summary).toContain('minorRadius');
  });
});
