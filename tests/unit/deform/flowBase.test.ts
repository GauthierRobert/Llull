/** 01 DEF §17.2: `flow_along_curve` with a `baseCurve`, and the frame fix (the curves are read in the body frame), on the mesh path. The native exact warp: server/tests/nativeKernelDeform.test.ts. */

import { afterEach, describe, expect, it } from 'vitest';
import { type CadDocument, type NurbsCurveEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { worldCurveOf } from '@core/commands/solids/loftSectionCurves';
import type { NurbsCurveData } from '@core/lib/nurbs/types';
import { resolveBase } from '@core/commands/deform/flowBase';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { localDeterminant, mapLocal } from '@core/geometry/deform/laws';
import type { DeformLaw, DeformRegion } from '@core/model/deform';
import { packData } from './packPaths';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import {
  type AnalysisData,
  type CheckData,
  type KernelKind,
  type RunData,
  addBox,
  addCylinder,
  dataOf,
  installKernel,
  meshEntity,
  relative,
  volumeOf,
} from './harness';

const KERNELS: KernelKind[] = ['none', 'manifold'];
const WORLD = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] } as const;
const WHOLE: DeformRegion = { start: -Infinity, end: Infinity, falloff: 'none', beyond: 'rigid' };
const QUARTER = (50 * Math.PI) / 2;

afterEach(() => setGeometryKernel(null));

function extentOf(doc: CadDocument, id: string): { min: Vec3; max: Vec3 } {
  const { positions } = meshEntity(doc, id).mesh;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a] as number, positions[i + a] as number);
      max[a] = Math.max(max[a] as number, positions[i + a] as number);
    }
  return { min, max };
}

/** A curve entity: a conic arc (start, apex, end) or a polyline of degree 1. */
function curve(
  doc: CadDocument,
  name: 'create_conic' | 'create_nurbs_curve' | 'interpolate_curve',
  params: Record<string, unknown>,
): { doc: CadDocument; id: string } {
  const made = execute(doc, name, params);
  expect(made.error, made.summary).toBeUndefined();
  return { doc: made.document, id: made.affected[0] as string };
}

/** A cylinder r 5 bent into a quarter circle of R 50 about the world y axis through (50, 0, 0): its centreline is the arc from (0, 0, 0) to (50, 0, 50). */
function bentRod(): { doc: CadDocument; id: string } {
  const rod = addCylinder(5, QUARTER);
  const bent = execute(rod.doc, 'bend_body', { id: rod.id, radius: 50, angleDeg: 90, frame: WORLD, output: { tolerance: 0.01 } });
  expect(bent.error, bent.summary).toBeUndefined();
  return { doc: bent.document, id: bent.affected[0] as string };
}

describe.each(KERNELS)('flow_along_curve, kernel: %s', (kind) => {
  it('reads the target in the body frame: a body away from the world origin lands on the target, not offset by the frame origin', async () => {
    await installKernel(kind);
    const created = execute(addBox([10, 10, 100]).doc, 'add_box', { size: [10, 10, 100], anchor: 'base-center', position: [30, 20, 0] });
    const line = curve(created.document, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, 0],
        [0, 0, 100],
      ],
    });
    const result = execute(line.doc, 'flow_along_curve', { id: created.affected[0], targetId: line.id, output: { tolerance: 0.01 } });
    expect(result.error, result.summary).toBeUndefined();
    const extent = extentOf(result.document, result.affected[0] as string);
    expect(extent.min[0]).toBeCloseTo(-5, 6);
    expect(extent.max[0]).toBeCloseTo(5, 6);
    expect(extent.min[1]).toBeCloseTo(-5, 6);
    expect(extent.max[2]).toBeCloseTo(100, 6);
  });

  it('a straight base on the frame axis is the default: the result is byte-identical', async () => {
    await installKernel(kind);
    const bar = addBox([10, 10, QUARTER], 'base-center');
    const arc = curve(bar.doc, 'create_conic', { start: [100, 0, 0], apex: [100, 0, 50], end: [100, 50, 50], rho: Math.SQRT2 - 1 });
    const axis = curve(arc.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, -20],
        [0, 0, QUARTER + 20],
      ],
    });
    const plain = execute(axis.doc, 'flow_along_curve', { id: bar.id, targetId: arc.id, frame: WORLD, output: { tolerance: 0.01 } });
    const based = execute(axis.doc, 'flow_along_curve', {
      id: bar.id,
      targetId: arc.id,
      baseCurve: axis.id,
      frame: WORLD,
      output: { tolerance: 0.01 },
    });
    expect(plain.error, plain.summary).toBeUndefined();
    const entity = (r: typeof plain): string => JSON.stringify(r.document.entities[r.affected[0] as string]);
    expect(entity(based)).toBe(entity(plain));
    expect(based.summary).toBe(plain.summary);
  });

  it('an arc base onto a straight target straightens a bent bar: length, volume, position, Jacobian and predicted volume', async () => {
    await installKernel(kind);
    const rod = bentRod();
    const base = curve(rod.doc, 'create_conic', { start: [0, 0, 0], apex: [0, 0, 50], end: [50, 0, 50], rho: Math.SQRT2 - 1 });
    const target = curve(base.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [200, 0, 0],
        [200, 0, 100],
      ],
    });
    const params = { id: rod.id, targetId: target.id, baseCurve: base.id, frame: WORLD, output: { tolerance: 0.01 } };
    const result = execute(target.doc, 'flow_along_curve', params);
    expect(result.error, result.summary).toBeUndefined();
    const next = result.affected[0] as string;
    const extent = extentOf(result.document, next);
    expect(extent.min[2]).toBeCloseTo(0, 1);
    expect(extent.max[2]).toBeCloseTo(QUARTER, 1);
    expect(extent.min[0]).toBeCloseTo(195, 1);
    expect(extent.max[0]).toBeCloseTo(205, 1);
    expect(relative(volumeOf(result.document, next), Math.PI * 25 * QUARTER)).toBeLessThan(2e-2);
    const analysis = dataOf<AnalysisData>(execute(result.document, 'analyze_deformation', { id: next }));
    // det J = 1 / (1 - x / 50) for offsets x in [-5, 5] toward the centre of the base arc
    expect(analysis.jacobian.min).toBeCloseTo(1 / 1.1, 2);
    expect(analysis.jacobian.max).toBeCloseTo(1 / 0.9, 2);
    expect(analysis.volume.driftRel).toBeLessThan(2e-2);
    expect(dataOf<CheckData>(execute(result.document, 'check_deformation', { ids: [next] })).status).not.toBe('fail');
    expect(dataOf<RunData>(result).path).toBe('mesh');
    expectPure(target.doc, () => execute(target.doc, 'flow_along_curve', params));
  });

  it('refuses a missing or non-curve base, a base shorter than the body, a degenerate one and one tighter than the body half width', async () => {
    await installKernel(kind);
    const rod = bentRod();
    const target = curve(rod.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [200, 0, 0],
        [200, 0, 100],
      ],
    });
    const run = (baseCurve: string): ReturnType<typeof execute> =>
      execute(target.doc, 'flow_along_curve', { id: rod.id, targetId: target.id, baseCurve, frame: WORLD });
    expectNoOp(run('nope'), target.doc, 'DEF_CURVE_NOT_FOUND');
    expectNoOp(run(rod.id), target.doc, 'DEF_CURVE_NOT_FOUND');
    const short = curve(target.doc, 'create_conic', { start: [0, 0, 0], apex: [0, 0, 20], end: [20, 0, 20], rho: Math.SQRT2 - 1 });
    expect(execute(short.doc, 'flow_along_curve', { id: rod.id, targetId: target.id, baseCurve: short.id, frame: WORLD }).error?.code).toBe(
      'DEF_BASE_CURVE_SHORT',
    );
    const point = curve(target.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, 0],
        [0, 0, 0],
      ],
    });
    expect(execute(point.doc, 'flow_along_curve', { id: rod.id, targetId: target.id, baseCurve: point.id, frame: WORLD }).error?.code).toBe(
      'DEF_CURVE_INVALID',
    );
  });

  it('refuses a body reaching past the centre of curvature of the base as short (its projection leaves the base; the inner-side fold itself is the resolveBase test)', async () => {
    await installKernel(kind);
    const bar = addBox([20, 4, 10], 'base-center');
    const base = curve(bar.doc, 'create_conic', { start: [0, 0, 0], apex: [0, 0, 8], end: [8, 0, 8], rho: Math.SQRT2 - 1 });
    const line = curve(base.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [200, 0, 0],
        [200, 0, 100],
      ],
    });
    const result = execute(line.doc, 'flow_along_curve', { id: bar.id, targetId: line.id, baseCurve: base.id, frame: WORLD });
    expect(result.error?.code).toBe('DEF_BASE_CURVE_SHORT');
  });
});

describe('a flow law with a base in a recipe', () => {
  it('is validated: the base needs a positive step and 12-number stations', () => {
    const law = { kind: 'flowCurve', z0: 0, ratio: 1, step: 1, stations: new Array<number>(24).fill(1) };
    const node = (patch: Record<string, unknown>): unknown => ({
      op: 'deform',
      source: { op: 'brep', blob: 'a'.repeat(64), format: 'occt-brep-v1' },
      law: { ...law, ...patch },
      frame: WORLD,
      output: { mode: 'mesh', tolerance: 0.01, preserveAnalytic: false },
    });
    expect(validateShapeRecipe(node({ base: { step: 1, stations: new Array<number>(24).fill(1) } }))).toBeNull();
    expect(validateShapeRecipe(node({ base: { step: 0, stations: new Array<number>(24).fill(1) } }))).toContain('base');
    expect(validateShapeRecipe(node({ base: { step: 1, stations: [1, 2, 3] } }))).toContain('base');
  });
});

interface BasePack {
  readonly laws: Record<string, { params: Record<string, number>; points: Array<{ in: Vec3; out: Vec3; det: number }> }>;
}

/** Stations (P, T, N, B) every `step` of arc length along an arc of `radius` in the xz plane (centre (R, 0, 0), normal toward it), or a line along +z when radius is 0. */
function arcStations(radius: number, length: number, step: number): number[] {
  const out: number[] = [];
  for (let k = 0; k <= Math.round(length / step); k++) {
    const s = k * step;
    if (radius === 0) out.push(0, 0, s, 0, 0, 1, 1, 0, 0, 0, 1, 0);
    else {
      const t = s / radius;
      out.push(radius * (1 - Math.cos(t)), 0, radius * Math.sin(t), Math.sin(t), 0, Math.cos(t), Math.cos(t), 0, -Math.sin(t), 0, 1, 0);
    }
  }
  return out;
}

describe('flow along a curve with a base curve against the validation pack (closed form per point)', () => {
  const pack = packData<BasePack>('point_vectors.json');
  it.each(['flow_base_line', 'flow_base_arc', 'flow_base_line_stretch'])('%s maps every golden point and matches det J', (name) => {
    const { params, points } = pack.laws[name] as BasePack['laws'][string];
    const { baseRadius, targetRadius, ratio, baseLength, step } = params as Record<string, number>;
    const law: DeformLaw = {
      kind: 'flowCurve',
      z0: 0,
      ratio: ratio as number,
      step: step as number,
      stations: arcStations(targetRadius as number, (ratio as number) * (baseLength as number), step as number),
      base: { step: step as number, stations: arcStations(baseRadius as number, baseLength as number, step as number) },
    };
    for (const point of points) {
      const image = mapLocal(law, WHOLE, point.in);
      image.forEach((value, axis) => expect(Math.abs(value - (point.out[axis] as number))).toBeLessThan(1e-8));
      expect(Math.abs(localDeterminant(law, WHOLE, point.in) - point.det)).toBeLessThan(1e-6);
    }
    expect(points).toHaveLength(12);
  });
});

describe.each(KERNELS)('flow_along_curve review round 1, kernel: %s', (kind) => {
  it('fixed_up without an up vector means world +z, whatever the default frame (the bar runs along x here)', async () => {
    await installKernel(kind);
    const bar = addBox([100, 10, 10]);
    const curveOf = curve(bar.doc, 'create_nurbs_curve', {
      degree: 3,
      poles: [
        [0, 0, 0],
        [30, 0, 0],
        [40, 30, 0],
        [70, 30, 0],
      ],
    });
    const call = (extra: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(curveOf.doc, 'flow_along_curve', {
        id: bar.id,
        targetId: curveOf.id,
        orientation: 'fixed_up',
        output: { tolerance: 0.02 },
        ...extra,
      });
    const [omitted, given] = [call({}), call({ up: [0, 0, 1] })];
    expect(omitted.error, omitted.summary).toBeUndefined();
    const entity = (r: typeof omitted): string => JSON.stringify(r.document.entities[r.affected[0] as string]);
    expect(entity(omitted)).toBe(entity(given));
  });

  it('flow_on_surface reads the sheet in the base frame: a base plane away from the origin and a tilted one land on the sheet', async () => {
    await installKernel(kind);
    const sheet = curveSheet();
    for (const oz of [0, 1]) {
      const made = execute(sheet.document, 'add_box', { size: [60, 20, 2], position: [0, 0, oz], anchor: 'min' });
      const flowed = execute(made.document, 'flow_on_surface', {
        id: made.affected[0],
        base: { plane: { origin: [0, 0, oz], normal: [0, 0, 1], uDirection: [1, 0, 0] } },
        target: { sheetId: sheet.affected[0] },
        targetOrigin: [0, 0, 5],
        targetUDirection: [1, 0, 0],
        output: { tolerance: 0.01 },
      });
      expect(flowed.error, flowed.summary).toBeUndefined();
      const extent = extentOf(flowed.document, flowed.affected[0] as string);
      expect(extent.min[2]).toBeCloseTo(5, 6);
      expect(extent.max[2]).toBeCloseTo(7, 6);
      expect(extent.min[0]).toBeCloseTo(0, 6);
      expect(extent.max[0]).toBeCloseTo(60, 6);
    }
    // a plane with its normal along +y (the plate's thickness along y): w goes along the sheet normal, the plate's z becomes the second sheet direction
    const wall = execute(sheet.document, 'add_box', { size: [60, 2, 20], position: [0, 0, 0], anchor: 'min' });
    const tilted = execute(wall.document, 'flow_on_surface', {
      id: wall.affected[0],
      base: { plane: { origin: [0, 0, 0], normal: [0, 1, 0], uDirection: [1, 0, 0] } },
      target: { sheetId: sheet.affected[0] },
      targetOrigin: [0, 20, 5],
      targetUDirection: [1, 0, 0],
      output: { tolerance: 0.01 },
    });
    expect(tilted.error, tilted.summary).toBeUndefined();
    const extent = extentOf(tilted.document, tilted.affected[0] as string);
    expect(extent.min[2]).toBeCloseTo(5, 6);
    expect(extent.max[2]).toBeCloseTo(7, 6);
    expect(extent.max[0] - extent.min[0]).toBeCloseTo(60, 6);
    expect(extent.max[1] - extent.min[1]).toBeCloseTo(20, 6);
  });

  it('refuses a target fold that falls between the body vertices (base grid), as without a base', async () => {
    await installKernel(kind);
    const bar = addBox([10, 10, 100], 'base-center');
    const base = curve(bar.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, 0],
        [0, 0.001, 100],
      ],
    });
    const corner = curve(base.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, 0],
        [0, 0, 50],
        [50, 0, 50],
      ],
    });
    const plain = execute(corner.doc, 'flow_along_curve', { id: bar.id, targetId: corner.id, frame: WORLD });
    expect(plain.error?.code).toBe('DEF_FOLDOVER');
    const based = execute(corner.doc, 'flow_along_curve', { id: bar.id, targetId: corner.id, baseCurve: base.id, frame: WORLD });
    expect(based.error?.code).toBe('DEF_FOLDOVER');
  });

  it('accepts a plate wider than the base radius across the plane of the arc and one on the outer side (signed guard)', async () => {
    await installKernel(kind);
    const plate = execute(createEmptyDocument(), 'add_box', { size: [4, 50, 20], position: [-4, -25, 0], anchor: 'min' });
    const arc = curve(plate.document, 'create_conic', { start: [0, 0, 0], apex: [0, 0, 20], end: [20, 0, 20], rho: Math.SQRT2 - 1 });
    const line = curve(arc.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [200, 0, 0],
        [200, 0, 100],
      ],
    });
    const result = execute(line.doc, 'flow_along_curve', { id: plate.affected[0], targetId: line.id, baseCurve: arc.id, frame: WORLD });
    expect(result.error, result.summary).toBeUndefined();
    const extent = extentOf(result.document, result.affected[0] as string);
    expect(extent.max[1] - extent.min[1]).toBeCloseTo(50, 6);
  });

  it.skipIf(kind !== 'none')(
    'a base turning 270 degrees: the predicted volume counts each section once',
    { timeout: 180_000 },
    async () => {
      await installKernel(kind);
      const radius = 50;
      const length = 1.5 * Math.PI * radius;
      const rod = addCylinder(5, length);
      const bent = execute(rod.doc, 'bend_body', { id: rod.id, radius, angleDeg: 270, frame: WORLD, output: { tolerance: 0.1 } });
      expect(bent.error, bent.summary).toBeUndefined();
      const points = Array.from({ length: 61 }, (_, k) => {
        const t = (1.5 * Math.PI * k) / 60;
        return [radius * (1 - Math.cos(t)), 0, radius * Math.sin(t)];
      });
      const base = curve(bent.document, 'interpolate_curve', { points, degree: 3 });
      const line = curve(base.doc, 'create_nurbs_curve', {
        degree: 1,
        poles: [
          [300, 0, 0],
          [300, 0, 300],
        ],
      });
      const flowed = execute(line.doc, 'flow_along_curve', {
        id: bent.affected[0],
        targetId: line.id,
        baseCurve: base.id,
        frame: WORLD,
        output: { tolerance: 0.1 },
      });
      expect(flowed.error, flowed.summary).toBeUndefined();
      const analysis = dataOf<AnalysisData>(execute(flowed.document, 'analyze_deformation', { id: flowed.affected[0] as string }));
      expect(analysis.volume.driftRel).toBeLessThan(0.02);
    },
  );
});

describe('resolveBase', () => {
  const identity = { origin: [0, 0, 0] as Vec3, x: [1, 0, 0] as Vec3, y: [0, 1, 0] as Vec3, z: [0, 0, 1] as Vec3 };
  const options = { tolerance: 0.01, lateral: 1, firstNormal: (): Vec3 => [1, 0, 0] };
  // a quarter circle of radius 8 in the xz plane from the origin, centre (8, 0, 0)
  const arc = (): NurbsCurveData => {
    const made = curve(createEmptyDocument(), 'create_conic', { start: [0, 0, 0], apex: [0, 0, 8], end: [8, 0, 8], rho: Math.SQRT2 - 1 });
    return worldCurveOf(made.doc.entities[made.id] as NurbsCurveEntity);
  };

  it('is DEF_FOLDOVER where the body reaches the centre of curvature on its inner side', () => {
    const near = resolveBase(arc(), identity, [0, 0, 0, 8 - 1e-7, 0, 1e-7], options);
    expect('code' in near && near.code).toBe('DEF_FOLDOVER');
  });

  it('accepts the same arc for points on its outer side and for offsets across the plane of the arc', () => {
    const outer = resolveBase(arc(), identity, [0, 0, 0, -3, 0, 4, -2, 30, 6, -2, -30, 6], options);
    expect('code' in outer).toBe(false);
  });

  it('is DEF_BASE_CURVE_SHORT for a point whose projection leaves the base', () => {
    const past = resolveBase(arc(), identity, [0, 0, 0, 8 + 3, 0, 4], options);
    expect('code' in past && past.code).toBe('DEF_BASE_CURVE_SHORT');
  });
});

/** A flat sheet z = 5 over [0, 80] x [0, 40]. */
function curveSheet(): ReturnType<typeof execute> {
  return execute(createEmptyDocument(), 'create_nurbs_surface', {
    degreeU: 1,
    degreeV: 1,
    poles: [
      [
        [0, 0, 5],
        [0, 40, 5],
      ],
      [
        [80, 0, 5],
        [80, 40, 5],
      ],
    ],
  });
}
