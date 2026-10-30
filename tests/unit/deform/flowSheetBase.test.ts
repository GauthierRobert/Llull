/** 01 DEF §17.5: `flow_on_surface` with a curved base SHEET, on the mesh path, against the shared pack and closed forms. The native exact warp: server/tests/nativeKernelFlowSheet.test.ts. */

import { afterEach, describe, expect, it } from 'vitest';
import { type CadDocument, type Vec3, createEmptyDocument } from '@core/model/types';
import type { DeformLaw } from '@core/model/deform';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { baseSurfaceGrid, flowSurfaceDeterminant, flowSurfaceMap, solveBase, solveBaseChecked } from '@core/geometry/deform/flowSurface';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import {
  type AnalysisData,
  type CheckData,
  type KernelKind,
  type RunData,
  WORLD_Z,
  addBox,
  dataOf,
  installKernel,
  meshEntity,
  relative,
  volumeOf,
} from './harness';
import { packData } from './packPaths';

const KERNELS: KernelKind[] = ['none', 'manifold'];
type SurfaceLaw = Extract<DeformLaw, { kind: 'flowSurface' }>;

afterEach(() => setGeometryKernel(null));

/** Nodes (P then N, i-major) of a sheet on a grid: a cylinder of `radius` along y with the arc from the origin in xz (normal out of it), or the plane z = 0 for radius 0. */
function sheetNodes(radius: number, x0: number, hx: number, nx: number, y0: number, hy: number, ny: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const [x, y] = [x0 + i * hx, y0 + j * hy];
      if (radius === 0) out.push(x, y, 0, 0, 0, 1);
      else out.push(radius * (1 - Math.cos(x / radius)), y, radius * Math.sin(x / radius), -Math.cos(x / radius), 0, Math.sin(x / radius));
    }
  return out;
}

interface Pack {
  readonly laws: Record<string, { params: Record<string, number>; points: Array<{ in: Vec3; out: Vec3; det: number }> }>;
}

describe('flow onto a surface from a base sheet against the validation pack (closed form per point)', () => {
  const pack = packData<Pack>('point_vectors.json');
  it.each(['flow_surface_base_plane', 'flow_surface_base_cylinder'])('%s maps every golden point and matches det J', (name) => {
    const { params, points } = pack.laws[name] as Pack['laws'][string];
    const { step, length, halfWidth, baseRadius, targetRadius } = params as Record<string, number>;
    const [x0, nx, y0, ny] = [
      -0.6,
      Math.round(((length as number) + 1.2) / (step as number)) + 1,
      -(halfWidth as number),
      Math.round((2 * (halfWidth as number)) / (step as number)) + 1,
    ];
    const law: SurfaceLaw = {
      kind: 'flowSurface',
      x0,
      y0,
      hx: step as number,
      hy: step as number,
      nx,
      ny,
      nodes: sheetNodes(targetRadius as number, x0, step as number, nx, y0, step as number, ny),
      baseNodes: sheetNodes(baseRadius as number, x0, step as number, nx, y0, step as number, ny),
    };
    for (const point of points) {
      flowSurfaceMap(law, point.in).forEach((value, axis) => expect(Math.abs(value - (point.out[axis] as number))).toBeLessThan(2e-5));
      expect(Math.abs(flowSurfaceDeterminant(law, point.in) - point.det)).toBeLessThan(2e-4);
    }
    expect(points).toHaveLength(12);
    // the base coordinates of a point on the base cylinder: x = R theta, y, w = r - R
    const [x, y, w] = solveBase(law, points[0]?.in as Vec3);
    expect(x).toBeCloseTo(50 * 0.1, 4);
    expect(y).toBeCloseTo(-6, 6);
    expect(w).toBeCloseTo(-1.5, 5);
  });

  it('the Jacobian grid has two samples per table interval along x, at the body offsets, on the base surface', () => {
    const { params } = pack.laws['flow_surface_base_cylinder'] as Pack['laws'][string];
    const step = params['step'] as number;
    const [x0, nx, y0, ny] = [-0.6, Math.round(((params['length'] as number) + 1.2) / step) + 1, -12, 121];
    const law: SurfaceLaw = {
      kind: 'flowSurface',
      x0,
      y0,
      hx: step,
      hy: step,
      nx,
      ny,
      nodes: sheetNodes(0, x0, step, nx, y0, step, ny),
      baseNodes: sheetNodes(50, x0, step, nx, y0, step, ny),
    };
    const grid = baseSurfaceGrid(law, [0, 10], [-8, 8], [-1.5, 1.8]);
    // 2 (nx - 1) + 1 x samples over [0, 10], 5 y levels, 2 offsets
    expect(grid.length / 3).toBe((2 * (nx - 1) + 1) * 5 * 2);
    const first = solveBase(law, [grid[0] as number, grid[1] as number, grid[2] as number]);
    expect(first[0]).toBeCloseTo(0, 5);
    expect(first[1]).toBeCloseTo(-8, 5);
    expect(first[2]).toBeCloseTo(-1.5, 5);
    const second = solveBase(law, [grid[3] as number, grid[4] as number, grid[5] as number]);
    expect(second[2]).toBeCloseTo(1.8, 5);
    expect(baseSurfaceGrid({ ...law, baseNodes: undefined } as unknown as SurfaceLaw, [0, 10], [-8, 8], [-1, 1])).toEqual([]);
  });

  it('the base solve reports its residual: tiny on the base surface, large far off the table', () => {
    const { params } = pack.laws['flow_surface_base_cylinder'] as Pack['laws'][string];
    const step = params['step'] as number;
    const [x0, nx, y0, ny] = [-0.6, Math.round(((params['length'] as number) + 1.2) / step) + 1, -12, 121];
    const law: SurfaceLaw = {
      kind: 'flowSurface',
      x0,
      y0,
      hx: step,
      hy: step,
      nx,
      ny,
      nodes: sheetNodes(0, x0, step, nx, y0, step, ny),
      baseNodes: sheetNodes(50, x0, step, nx, y0, step, ny),
    };
    expect(solveBaseChecked(law, [50 - 51 * Math.cos(0.5), 2, 51 * Math.sin(0.5)]).residual).toBeLessThan(1e-9);
    expect(solveBaseChecked(law, [5000, 0, 5000]).residual).toBeGreaterThan(1);
    expect(solveBaseChecked({ ...law, baseNodes: undefined } as unknown as SurfaceLaw, [1, 2, 3]).residual).toBe(0);
  });

  it('a recipe node validates baseNodes', () => {
    const node = (patch: Record<string, unknown>): unknown => ({
      op: 'deform',
      source: { op: 'brep', blob: 'a'.repeat(64), format: 'occt-brep-v1' },
      law: { kind: 'flowSurface', x0: 0, y0: 0, hx: 1, hy: 1, nx: 2, ny: 2, nodes: new Array<number>(24).fill(0), ...patch },
      frame: WORLD_Z,
      output: { mode: 'mesh', tolerance: 0.01, preserveAnalytic: false },
    });
    expect(validateShapeRecipe(node({ baseNodes: new Array<number>(24).fill(0) }))).toBeNull();
    expect(validateShapeRecipe(node({ baseNodes: [1, 2, 3] }))).toContain('baseNodes');
  });
});

/** A rational quarter-circle sheet of radius `radius` (arc from the origin in the xz plane, centre (R, 0, 0), normal out), `halfWidth` either side of y = 0. */
function cylinderSheet(doc: CadDocument, radius: number, halfWidth: number): { doc: CadDocument; id: string } {
  const w = Math.SQRT1_2;
  const made = execute(doc, 'create_nurbs_surface', {
    degreeU: 2,
    degreeV: 1,
    poles: [
      [
        [0, -halfWidth, 0],
        [0, halfWidth, 0],
      ],
      [
        [0, -halfWidth, radius],
        [0, halfWidth, radius],
      ],
      [
        [radius, -halfWidth, radius],
        [radius, halfWidth, radius],
      ],
    ],
    weights: [
      [1, 1],
      [w, w],
      [1, 1],
    ],
  });
  expect(made.error, made.summary).toBeUndefined();
  return { doc: made.document, id: made.affected[0] as string };
}

/** A rational full-circle sheet of radius 50 (centre (50, 0, 0), arc from the origin up, normal out), y within +-15. */
function fullCircleSheet(doc: CadDocument): ReturnType<typeof execute> {
  // the full base circle: four quarter spans, centre (50, 0, 0), from the origin up
  const w = Math.SQRT1_2;
  const ring: Vec3[] = [
    [0, 0, 0],
    [0, 0, 50],
    [50, 0, 50],
    [100, 0, 50],
    [100, 0, 0],
    [100, 0, -50],
    [50, 0, -50],
    [0, 0, -50],
    [0, 0, 0],
  ];
  return execute(doc, 'create_nurbs_surface', {
    degreeU: 2,
    degreeV: 1,
    poles: ring.map((pole) => [
      [pole[0], -15, pole[2]],
      [pole[0], 15, pole[2]],
    ]),
    weights: [1, w, 1, w, 1, w, 1, w, 1].map((weight) => [weight, weight]),
    knotsU: [0, 0.25, 0.5, 0.75, 1],
    multiplicitiesU: [3, 2, 2, 2, 3],
  });
}

function flatSheet(doc: CadDocument, x: [number, number], y: [number, number], z: number): { doc: CadDocument; id: string } {
  const made = execute(doc, 'create_nurbs_surface', {
    degreeU: 1,
    degreeV: 1,
    poles: [
      [
        [x[0], y[0], z],
        [x[0], y[1], z],
      ],
      [
        [x[1], y[0], z],
        [x[1], y[1], z],
      ],
    ],
  });
  expect(made.error, made.summary).toBeUndefined();
  return { doc: made.document, id: made.affected[0] as string };
}

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

describe.each(KERNELS)('flow_on_surface with a base sheet, kernel: %s', (kind) => {
  const QUARTER = (50 * Math.PI) / 2;

  /** A plate of thickness 2 bent on R 50 (its middle surface on the base cylinder) and the sheets: the base cylinder and a flat target. */
  async function scene(): Promise<{ doc: CadDocument; plate: string; base: string; target: string }> {
    await installKernel(kind);
    const box = addBox([2, 20, QUARTER], 'base-center');
    const bent = execute(box.doc, 'bend_body', { id: box.id, radius: 50, angleDeg: 90, frame: WORLD_Z, output: { tolerance: 0.02 } });
    expect(bent.error, bent.summary).toBeUndefined();
    const base = cylinderSheet(bent.document, 50, 15);
    const target = flatSheet(base.doc, [-10, 100], [-30, 30], 0);
    return { doc: target.doc, plate: bent.affected[0] as string, base: base.id, target: target.id };
  }

  it('unrolls a bent plate: arc lengths kept, thickness along the normal, volume, Jacobian range and predicted volume', async () => {
    const { doc, plate, base, target } = await scene();
    const params = {
      id: plate,
      base: { sheetId: base, origin: [0, 0, 0], uDirection: [0, 0, 1] },
      target: { sheetId: target },
      targetOrigin: [0, 0, 0],
      targetUDirection: [1, 0, 0],
      output: { tolerance: 0.02 },
    };
    const result = execute(doc, 'flow_on_surface', params);
    expect(result.error, result.summary).toBeUndefined();
    const next = result.affected[0] as string;
    const extent = extentOf(result.document, next);
    expect(extent.min[0]).toBeCloseTo(0, 1);
    expect(extent.max[0]).toBeCloseTo(QUARTER, 1);
    expect(extent.min[1]).toBeCloseTo(-10, 6);
    expect(extent.max[1]).toBeCloseTo(10, 6);
    expect(extent.min[2]).toBeCloseTo(-1, 2);
    expect(extent.max[2]).toBeCloseTo(1, 2);
    // the bent plate has the volume of the flat one (symmetric thickness about the neutral surface): 78.54 x 20 x 2
    expect(relative(volumeOf(result.document, next), QUARTER * 20 * 2)).toBeLessThan(2e-2);
    const analysis = dataOf<AnalysisData>(execute(result.document, 'analyze_deformation', { id: next }));
    // det J = R / (R + w) for w in [-1, 1]
    expect(analysis.jacobian.min).toBeCloseTo(50 / 51, 2);
    expect(analysis.jacobian.max).toBeCloseTo(50 / 49, 2);
    expect(analysis.volume.driftRel).toBeLessThan(2e-2);
    expect(dataOf<CheckData>(execute(result.document, 'check_deformation', { ids: [next] })).status).not.toBe('fail');
    expect(dataOf<RunData>(result).path).toBe('mesh');
    expectPure(doc, () => execute(doc, 'flow_on_surface', params));
  }, 120_000);

  it('a 300 degree wrap: the predicted volume does not depend on a fan apex (the bounding-box centre is at the axis of curvature, where det J of the base blows up)', async () => {
    await installKernel(kind);
    const length = (50 * 5 * Math.PI) / 3;
    const box = addBox([2, 20, length], 'base-center');
    const bent = execute(box.doc, 'bend_body', { id: box.id, radius: 50, angleDeg: 300, frame: WORLD_Z, output: { tolerance: 0.1 } });
    expect(bent.error, bent.summary).toBeUndefined();
    const made = fullCircleSheet(bent.document);
    expect(made.error, made.summary).toBeUndefined();
    const target = flatSheet(made.document, [-10, 400], [-30, 30], 0);
    const result = execute(target.doc, 'flow_on_surface', {
      id: bent.affected[0],
      base: { sheetId: made.affected[0], origin: [0, 0, 0], uDirection: [0, 0, 1] },
      target: { sheetId: target.id },
      targetOrigin: [0, 0, 0],
      targetUDirection: [1, 0, 0],
      output: { tolerance: 0.1 },
    });
    expect(result.error, result.summary).toBeUndefined();
    const analysis = dataOf<AnalysisData>(execute(result.document, 'analyze_deformation', { id: result.affected[0] as string }));
    expect(relative(analysis.volume.predicted, length * 20 * 2)).toBeLessThan(5e-2);
  });

  it('a flat base sheet is the base plane: the same extents as base.plane', async () => {
    await installKernel(kind);
    const plate = execute(createEmptyDocument(), 'add_box', { size: [60, 20, 2], position: [0, 0, 0], anchor: 'min' });
    const target = flatSheet(plate.document, [0, 80], [0, 40], 5);
    const flat = flatSheet(target.doc, [-10, 100], [-30, 30], 0);
    const common = {
      id: plate.affected[0],
      target: { sheetId: target.id },
      targetOrigin: [0, 0, 5],
      targetUDirection: [1, 0, 0],
      output: { tolerance: 0.01 },
    };
    const onPlane = execute(flat.doc, 'flow_on_surface', {
      ...common,
      base: { plane: { origin: [0, 0, 0], normal: [0, 0, 1], uDirection: [1, 0, 0] } },
    });
    const onSheet = execute(flat.doc, 'flow_on_surface', {
      ...common,
      base: { sheetId: flat.id, origin: [0, 0, 0], uDirection: [1, 0, 0] },
    });
    expect(onPlane.error, onPlane.summary).toBeUndefined();
    expect(onSheet.error, onSheet.summary).toBeUndefined();
    const [a, b] = [extentOf(onPlane.document, onPlane.affected[0] as string), extentOf(onSheet.document, onSheet.affected[0] as string)];
    for (let k = 0; k < 3; k++) {
      expect(b.min[k]).toBeCloseTo(a.min[k] as number, 5);
      expect(b.max[k]).toBeCloseTo(a.max[k] as number, 5);
    }
  });

  it('refuses a target fold with a base sheet (the body reaches inside the radius of curvature of the target)', async () => {
    await installKernel(kind);
    const plate = execute(createEmptyDocument(), 'add_box', { size: [3, 10, 6], position: [0, -5, -3], anchor: 'min' });
    const flat = flatSheet(plate.document, [-5, 10], [-10, 10], 0);
    const tight = cylinderSheet(flat.doc, 2, 15);
    const result = execute(tight.doc, 'flow_on_surface', {
      id: plate.affected[0],
      base: { sheetId: flat.id, origin: [0, 0, 0], uDirection: [1, 0, 0] },
      target: { sheetId: tight.id },
      targetOrigin: [0, 0, 0],
      targetUDirection: [0, 0, 1],
    });
    expect(result.error?.code).toBe('DEF_FOLDOVER');
  });

  it('refuses a body that contains the axis of a closed base (the centre of curvature of the sheet), by name', async () => {
    await installKernel(kind);
    const plate = execute(createEmptyDocument(), 'add_box', { size: [60, 20, 10], position: [20, -10, -5], anchor: 'min' });
    const ring = fullCircleSheet(plate.document);
    expect(ring.error, ring.summary).toBeUndefined();
    const target = flatSheet(ring.document, [-10, 400], [-30, 30], 0);
    const result = execute(target.doc, 'flow_on_surface', {
      id: plate.affected[0],
      base: { sheetId: ring.affected[0], origin: [0, 0, 0], uDirection: [0, 0, 1] },
      target: { sheetId: target.id },
      targetOrigin: [0, 0, 0],
      targetUDirection: [1, 0, 0],
    });
    expect(result.error?.code).toBe('DEF_FOLDOVER');
    expect(result.summary).toContain('centre of curvature');
  });

  it('refuses a base given twice or not at all, a non-sheet base, a body off the base sheet, and a target fold, by name', async () => {
    const { doc, plate, base, target } = await scene();
    const common = { id: plate, target: { sheetId: target }, targetOrigin: [0, 0, 0], targetUDirection: [1, 0, 0] };
    const plane = { origin: [0, 0, 0], normal: [0, 0, 1], uDirection: [1, 0, 0] };
    expectNoOp(execute(doc, 'flow_on_surface', { ...common, base: { plane, sheetId: base } }), doc, 'DEF_FLOW_BASE_INVALID');
    expect(execute(doc, 'flow_on_surface', { ...common, base: {} }).error?.code).toBe('DEF_FLOW_BASE_INVALID');
    expect(execute(doc, 'flow_on_surface', { ...common, base: { sheetId: 'nope' } }).error?.code).toBe('DEF_FLOW_BASE_INVALID');
    expect(execute(doc, 'flow_on_surface', { ...common, base: { sheetId: plate } }).error?.code).toBe('DEF_FLOW_BASE_INVALID');
    // a base sheet narrower than the plate (y within +-5 against the plate's +-10)
    const narrow = cylinderSheet(doc, 50, 5);
    const off = execute(narrow.doc, 'flow_on_surface', {
      ...common,
      base: { sheetId: narrow.id, origin: [0, 0, 0], uDirection: [0, 0, 1] },
    });
    expect(off.error?.code).toBe('DEF_FLOW_BASE_OUTSIDE');
  });
});
