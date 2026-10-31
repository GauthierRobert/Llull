/** 01 DEF M4: `deform_overlay`, the read-only geometry the viewport draws for a deformed body (frame, region, lattice net, flow curves, flow sheets, reference wire). Mesh path. */

import { afterEach, describe, expect, it } from 'vitest';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { DeformLaw } from '@core/model/deform';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { resolveFrame } from '@core/geometry/deform/frame';
import { buildDeformOverlay } from '@core/geometry/deform/overlay';
import { referenceWire } from '@core/geometry/deform/referenceWire';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { WORLD_Z, addBox, addCylinder, dataOf, installKernel } from './harness';

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
    // the 10 x 10 bar twisted by 36 degrees per 20 units: its widest point is its corner at 7.07 from the axis, the planes reach 1.3 times that
    expect(data.region?.radius).toBeGreaterThan(8);
    expect(data.region?.radius).toBeLessThan(15);
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

  it('a flow with a curved base: the stations of the target curve and of the base curve, starting on the curves; a flow without a base has none to draw', async () => {
    await installKernel('none');
    const rod = addCylinder(5, (50 * Math.PI) / 2);
    const bent = execute(rod.doc, 'bend_body', { id: rod.id, radius: 50, angleDeg: 90, frame: WORLD_Z, output: { tolerance: 0.01 } });
    expect(bent.error, bent.summary).toBeUndefined();
    const base = curve(bent.document, 'create_conic', { start: [0, 0, 0], apex: [0, 0, 50], end: [50, 0, 50], rho: Math.SQRT2 - 1 });
    const target = curve(base.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [200, 0, 0],
        [200, 0, 100],
      ],
    });
    const flowed = execute(target.doc, 'flow_along_curve', {
      id: bent.affected[0],
      targetId: target.id,
      baseCurve: base.id,
      frame: WORLD_Z,
      output: { tolerance: 0.01 },
    });
    expect(flowed.error, flowed.summary).toBeUndefined();
    const { flow, region } = dataOf<Overlay>(execute(flowed.document, 'deform_overlay', { id: flowed.affected[0] }));
    expect(region).toBeNull();
    expect(flow?.target.length).toBeGreaterThan(10);
    expect(flow?.base?.length).toBeGreaterThan(10);
    expect(distance((flow?.target as Vec3[])[0] as Vec3, [200, 0, 0])).toBeLessThan(1e-6);
    expect(distance((flow?.base as Vec3[])[0] as Vec3, [0, 0, 0])).toBeLessThan(1e-6);
    const other = addCylinder(5, 78.5);
    const line = curve(other.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [200, 0, 0],
        [200, 0, 100],
      ],
    });
    const straight = execute(line.doc, 'flow_along_curve', {
      id: other.id,
      targetId: line.id,
      frame: WORLD_Z,
      output: { tolerance: 0.01 },
    });
    expect(straight.error, straight.summary).toBeUndefined();
    expect(dataOf<Overlay>(execute(straight.document, 'deform_overlay', { id: straight.affected[0] })).flow?.base).toBeNull();
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
    const overlay = buildDeformOverlay(law, undefined, frame, 10, 5);
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
      expect((wire as Vec3[][]).length, shape.kind).toBeGreaterThanOrEqual(3);
      expect(
        (wire as Vec3[][]).flat().every((p) => p.every(Number.isFinite)),
        shape.kind,
      ).toBe(true);
    }
    expect(referenceWire({ kind: 'torus', majorRadius: 5 }, extent)).toBeNull();
    // the plane is drawn through the foot of the body centre
    const plane = referenceWire({ kind: 'plane', point: [0, 0, 10], normal: [0, 0, 1] }, extent) as Vec3[][];
    expect(plane.flat().every((p) => Math.abs(p[2] - 10) < 1e-9)).toBe(true);
  });
});

describe('deform_overlay region planes', () => {
  it('a bend: the planes are sized from the REST body (1.3 x its cross-section reach), not from the bent mesh that moved ~55 off the axis', async () => {
    await installKernel('none');
    const rod = addCylinder(5, (50 * Math.PI) / 2);
    const bent = execute(rod.doc, 'bend_body', { id: rod.id, radius: 50, angleDeg: 90, frame: WORLD_Z, output: { tolerance: 0.01 } });
    expect(bent.error, bent.summary).toBeUndefined();
    const radius = dataOf<Overlay>(execute(bent.document, 'deform_overlay', { id: bent.affected[0] })).region?.radius as number;
    expect(radius).toBeGreaterThan(1.3 * 5 * 0.97);
    expect(radius).toBeLessThanOrEqual(1.3 * 5 * 1.001);
  });
});

describe('deform_overlay refusals', () => {
  it('an unknown id, an entity that was not deformed, a degenerate recorded frame and every unusable compareTo are named no-ops', async () => {
    await installKernel('none');
    const { doc, id } = addBox();
    const missing = execute(doc, 'deform_overlay', { id: 'nope' });
    expect(missing.error?.code).toBe('DEF_ENTITY_NOT_FOUND');
    expectNoOp(missing, doc);
    const plain = execute(doc, 'deform_overlay', { id });
    expect(plain.error?.code).toBe('DEF_NOT_DEFORMED');
    expectNoOp(plain, doc);
    const twisted = execute(doc, 'twist_body', { id, angleDeg: 30, frame: WORLD_Z, output: { tolerance: 0.01 } });
    const deformedId = twisted.affected[0] as string;
    const invalidCases: Array<[Record<string, unknown>, string]> = [
      [{ kind: 'torus', majorRadius: 5 }, 'minorRadius'],
      [{ kind: 'torus', majorRadius: 5, minorRadius: 5, center: [0, 0, 0], axis: [0, 0, 1] }, 'minorRadius'],
      [{ kind: 'torus', majorRadius: 5, minorRadius: 1, center: [0, 0, 0], axis: [0, 0, 0] }, 'axis'],
      [{ kind: 'sphere', center: [0, 0, 0], radius: -2 }, 'radius'],
      [{ kind: 'cone', apex: [0, 0, 0], axis: [0, 0, 1], halfAngleDeg: 90 }, 'halfAngleDeg'],
      [{ kind: 'plane', point: [0, 0, 0], normal: [0, 0, 0] }, 'normal'],
    ];
    for (const [compareTo, field] of invalidCases) {
      const invalid = execute(twisted.document, 'deform_overlay', { id: deformedId, compareTo });
      expect(invalid.error?.code, JSON.stringify(compareTo)).toBe('DEF_COMPARE_INVALID');
      expect(invalid.summary).toContain(field);
      expectNoOp(invalid, twisted.document);
    }
    const entity = twisted.document.entities[deformedId];
    if (entity?.kind !== 'mesh' || entity.brep?.op !== 'deform') throw new Error('a deformed mesh is expected');
    const broken: CadDocument = {
      ...twisted.document,
      entities: {
        ...twisted.document.entities,
        [deformedId]: { ...entity, brep: { ...entity.brep, frame: { ...entity.brep.frame, axis: [0, 0, 0] } } },
      },
    };
    const degenerate = execute(broken, 'deform_overlay', { id: deformedId });
    expect(degenerate.error?.code).toBe('DEF_FRAME_DEGENERATE');
    expectNoOp(degenerate, broken);
  });
});
