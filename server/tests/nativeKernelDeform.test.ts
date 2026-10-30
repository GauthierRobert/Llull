/**
 * 01 DEF on the native kernel: an affine `deform` node is lowered by the host to the sidecar's `gtransform` op (BRepBuilderAPI_GTransform), exact up to
 * the kernel's own mass-property integration; every other law goes to the exact warp (M2, capability `deform`: each face and edge becomes a B-spline
 * fitted to the deformed geometry within `output.tolerance`). The analytic suite of the validation pack (VC-DEF-01/02/05/06/08/10/11/12/20/22/36)
 * runs here. Skipped without the binary / the capabilities.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeformNode } from '@core/geometry/deform/laws';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type Entity, type ShapeRecipe } from '@core/model/types';
import { nativeRecipe } from '../src/native/kernelProtocol';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { common, createNativeTestKernel, describeNativeWhen, leaf } from './kernelTestSupport';

const SOURCE: ShapeRecipe = leaf({
  id: 'b',
  kind: 'box',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  size: [10, 20, 30],
  ...common,
} as Entity);
const FRAME = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] } as const;
const OUTPUT = { mode: 'auto', tolerance: 0.01, preserveAnalytic: false } as const;

const affine = (rows: [number, number, number][], translation: [number, number, number] = [0, 0, 0]): DeformNode => ({
  op: 'deform',
  source: SOURCE,
  law: { kind: 'affine', matrix: [rows[0] ?? [1, 0, 0], rows[1] ?? [0, 1, 0], rows[2] ?? [0, 0, 1]], translation },
  frame: FRAME,
  output: OUTPUT,
});

describe('native recipe lowering of deform nodes (no sidecar needed)', () => {
  it('an affine law becomes one gtransform node in world coordinates', () => {
    const lowered = nativeRecipe(
      affine(
        [
          [2, 0, 0],
          [0, 1, 0],
          [0, 0, 3],
        ],
        [1, 2, 3],
      ),
    ) as unknown as { op: string; matrix: number[]; translation: number[]; source: ShapeRecipe };
    expect(lowered.op).toBe('gtransform');
    expect(lowered.matrix).toEqual([2, 0, 0, 0, 1, 0, 0, 0, 3]);
    expect(lowered.translation).toEqual([1, 2, 3]);
    expect(lowered.source.op).toBe('solid');
  });

  it('a frame is composed into the world matrix: a scale along the frame z axis acts along the world x axis', () => {
    const node: DeformNode = {
      ...affine([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 5],
      ]),
      frame: { origin: [0, 0, 0], axis: [1, 0, 0], reference: [0, 1, 0] },
    };
    const lowered = nativeRecipe(node) as unknown as { matrix: number[] };
    expect(lowered.matrix).toEqual([5, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('other laws stay deform nodes (the sidecar warps them) with their source lowered', () => {
    const twist: DeformNode = {
      ...affine([]),
      law: { kind: 'twist', angleRad: 1 },
      region: { start: 0, end: 10, falloff: 'smooth', beyond: 'rigid' },
    };
    const lowered = nativeRecipe(twist);
    expect(lowered.op).toBe('deform');
  });
});

describeNativeWhen({ capabilities: ['gtransform', 'deform'], label: 'nativeKernelDeform' })('01 DEF on the native kernel', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    kernel.dispose();
    setGeometryKernel(null);
  });

  const box = (size: [number, number, number], anchor: 'center' | 'base-center' = 'center'): { doc: CadDocument; id: string } => {
    const created = execute(createEmptyDocument(), 'add_box', { size, anchor });
    return { doc: created.document, id: created.affected[0] as string };
  };

  it('supports the affine maps and the exact warp laws, and builds an affine map as an exact solid', () => {
    expect(
      kernel.supportsDeform?.({
        kind: 'affine',
        matrix: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        translation: [0, 0, 0],
      }),
    ).toBe(true);
    expect(kernel.supportsDeform?.({ kind: 'twist', angleRad: 1 })).toBe(true);
    expect(kernel.supportsDeform?.({ kind: 'bend', radius: 5, symmetric: false })).toBe(true);
    const shape = kernel.evaluate(
      affine([
        [2, 0, 0],
        [0, 1, 0],
        [0, 0, 0.5],
      ]),
    );
    expect(shape).not.toBeNull();
    const mass = shape === null ? undefined : kernel.massProperties?.(shape);
    expect(mass?.volume).toBeCloseTo(6000, 6);
    expect(shape === null ? null : kernel.topology(shape)).not.toBeNull();
  });

  it('a twist node is built by the exact warp and reported', () => {
    const twist: DeformNode = {
      ...affine([]),
      law: { kind: 'twist', angleRad: 1 },
      region: { start: -15, end: 15, falloff: 'smooth', beyond: 'rigid' },
    };
    const shape = kernel.evaluate(twist);
    expect(shape).not.toBeNull();
    expect(Math.abs((kernel.massProperties?.(shape!)?.volume ?? 0) - 6000) / 6000).toBeLessThan(1e-4);
    expect(kernel.deformReport?.(twist)).toMatchObject({ ok: true, code: '', faces: 6, edges: 12 });
    expect(kernel.deformReport?.(SOURCE)).toBeNull();
    const refused: DeformNode = { ...twist, frame: { ...FRAME, reference: [0, 0, 1] } };
    expect(kernel.evaluate(refused)).toBeNull();
    expect(kernel.deformReport?.(refused)).toMatchObject({ ok: false, code: 'DEF_KERNEL_REFUSED' });
  });

  it('scale_nonuniform is exact on a box and a mirror stays an outward solid (VC-DEF-12)', () => {
    const { doc, id } = box([10, 20, 30]);
    const mirrored = execute(doc, 'scale_nonuniform', { id, factors: [-1, 1, 1], output: { mode: 'exact' } });
    const next = mirrored.affected[0] as string;
    expect(mirrored.summary).toContain('exact path');
    const shape = kernel.evaluate(
      mirrored.document.entities[next]?.kind === 'mesh' ? (mirrored.document.entities[next] as { brep: ShapeRecipe }).brep : SOURCE,
    );
    expect(shape).not.toBeNull();
    expect(kernel.massProperties?.(shape!)?.volume).toBeCloseTo(6000, 6);
    expect(kernel.analyze?.(shape!)?.valid).toBe(true);
    const flat = execute(doc, 'scale_nonuniform', { id, factors: [1, 0, 1] });
    expect(flat.error?.code).toBe('DEF_SCALE_SINGULAR');
  });

  it('a sphere scaled [1, 1, 2] is an exact spheroid (VC-DEF-11)', () => {
    const created = execute(createEmptyDocument(), 'add_sphere', { radius: 10 });
    const result = execute(created.document, 'scale_nonuniform', {
      id: created.affected[0] as string,
      factors: [1, 1, 2],
      output: { mode: 'exact' },
    });
    expect(result.rejected).toBeUndefined();
    const data = result.data as { path: string; volume: { value: number; method: string } };
    expect(data.path).toBe('exact');
    expect(data.volume.method).toBe('exact');
    // the adaptive mass rule recovers what the fixed Gauss rule loses on the rational B-spline faces (4.4e-4 relative volume before)
    expect(Math.abs(data.volume.value - 8377.58040957) / 8377.58040957).toBeLessThan(1e-6);
    const check = execute(result.document, 'check_deformation', {});
    expect((check.data as { status: string }).status).not.toBe('fail');
  });

  const run = (doc: CadDocument, name: string, params: Record<string, unknown>): ReturnType<typeof execute> => execute(doc, name, params);
  const rel = (measured: number, expected: number): number => Math.abs(measured - expected) / Math.abs(expected);
  const volumeOfEntity = (doc: CadDocument, id: string): number => {
    const mass = execute(doc, 'mass_properties', { entityId: id }).data as { volume: number; area: number; method: string };
    expect(mass.method).toBe('exact');
    return mass.volume;
  };
  const areaOfEntity = (doc: CadDocument, id: string): number =>
    (execute(doc, 'mass_properties', { entityId: id }).data as { area: number }).area;

  it('twist_body is exact on the native kernel: volume kept, asinh area, 6 faces / 12 edges / 8 vertices (VC-DEF-01, 02, 20)', () => {
    const { doc, id } = box([10, 10, 100], 'base-center');
    for (const [angleDeg, area] of [
      [90, 4204.10854],
      [120, 4207.29884],
      [360, 4264.85605],
    ] as const) {
      const result = run(doc, 'twist_body', {
        id,
        angleDeg,
        frame: FRAME,
        region: { start: 0, end: 100, falloff: 'linear' },
        output: { mode: 'exact', tolerance: 1e-4 },
      });
      expect(result.error).toBeUndefined();
      const next = result.affected[0] as string;
      expect((result.data as { path: string }).path).toBe('exact');
      expect(rel(volumeOfEntity(result.document, next), 10000)).toBeLessThan(1e-6);
      expect(rel(areaOfEntity(result.document, next), area)).toBeLessThan(1e-5);
      const topology = execute(result.document, 'inspect_topology', { id: next }).data as {
        faces: unknown[];
        edges: unknown[];
        vertices: number;
      };
      expect([topology.faces.length, topology.edges.length, topology.vertices]).toEqual([6, 12, 8]);
      const check = execute(result.document, 'check_deformation', {});
      expect((check.data as { status: string }).status).not.toBe('fail');
    }
  });

  it('a taper turns a cylinder into the cone frustum, and the result survives a STEP round trip (VC-DEF-05, 06, 22)', () => {
    const cylinder = execute(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 40, anchor: 'base-center' });
    const result = run(cylinder.document, 'taper_body', {
      id: cylinder.affected[0],
      scaleEnd: 0.4,
      frame: FRAME,
      region: { start: 0, end: 40, falloff: 'linear' },
      output: { mode: 'exact', tolerance: 1e-4 },
    });
    const next = result.affected[0] as string;
    expect(rel(volumeOfEntity(result.document, next), 1633.62818)).toBeLessThan(1e-5);
    expect(rel(areaOfEntity(result.document, next), 882.116478 + Math.PI * 29)).toBeLessThan(1e-5);
    const shape = kernel.evaluate((result.document.entities[next] as { brep: ShapeRecipe }).brep);
    const step = shape === null ? null : kernel.exportStep([shape]);
    expect(step).toContain('B_SPLINE_SURFACE');
    const box5 = box([10, 10, 100], 'base-center');
    const tapered = run(box5.doc, 'taper_body', {
      id: box5.id,
      scaleEnd: 0.5,
      frame: FRAME,
      region: { start: 0, end: 100, falloff: 'linear' },
      output: { mode: 'exact', tolerance: 1e-4 },
    });
    expect(rel(volumeOfEntity(tapered.document, tapered.affected[0] as string), (10 * 10 * 100 * (1 + 0.5 + 0.25)) / 3)).toBeLessThan(1e-4);
  });

  it('a stretch of a region adds its share of the volume exactly (VC-DEF-10)', () => {
    const { doc, id } = box([10, 10, 100], 'base-center');
    const result = run(doc, 'stretch_body', {
      id,
      factor: 1.5,
      frame: FRAME,
      region: { start: 20, end: 60, falloff: 'none' },
      output: { mode: 'exact' },
    });
    expect(result.error).toBeUndefined();
    expect(rel(volumeOfEntity(result.document, result.affected[0] as string), 12000)).toBeLessThan(1e-9);
  });

  it('a cylinder bends onto a torus segment and, at 360 degrees, into a closed ring (VC-DEF-08, 36)', () => {
    const arc = execute(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 25 * Math.PI, anchor: 'base-center' });
    const quarter = run(arc.document, 'bend_body', {
      id: arc.affected[0],
      radius: 50,
      angleDeg: 90,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] },
      output: { mode: 'exact', tolerance: 1e-4 },
    });
    expect(quarter.error).toBeUndefined();
    const next = quarter.affected[0] as string;
    expect(rel(volumeOfEntity(quarter.document, next), 6168.50275)).toBeLessThan(1e-5);
    expect(rel(areaOfEntity(quarter.document, next), 2467.4011 + 2 * Math.PI * 25)).toBeLessThan(1e-5);
    const rod = execute(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 314.159265, anchor: 'base-center' });
    const ring = run(rod.document, 'bend_body', {
      id: rod.affected[0],
      radius: 50,
      angleDeg: 360,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] },
      output: { mode: 'exact', tolerance: 1e-4 },
    });
    expect(ring.error).toBeUndefined();
    const ringId = ring.affected[0] as string;
    expect(rel(volumeOfEntity(ring.document, ringId), 24674.011)).toBeLessThan(1e-5);
    expect(rel(areaOfEntity(ring.document, ringId), 9869.6044)).toBeLessThan(1e-5);
    const analysis = execute(ring.document, 'analyze_deformation', {
      id: ringId,
      compareTo: { kind: 'torus', majorRadius: 50, minorRadius: 5, center: [0, 50, 0], axis: [1, 0, 0] },
    }).data as { compareTo: { maxDeviation: number }; approximation: { ring: boolean } };
    expect(analysis.compareTo.maxDeviation).toBeLessThan(1e-3);
    expect(analysis.approximation.ring).toBe(true);
    expect(run(rod.document, 'bend_body', { id: rod.affected[0], radius: 50, angleDeg: 400 }).error?.code).toBe('DEF_SELF_INTERSECTION');
  });

  it('a partial region splits the faces it crosses and stays a valid solid', () => {
    const { doc, id } = box([10, 10, 100], 'base-center');
    const result = run(doc, 'twist_body', {
      id,
      angleDeg: 85,
      frame: { origin: [0, 0, 50], axis: [0, 0, 1], reference: [1, 0, 0] },
      region: { start: -30, end: 10, falloff: 'smooth' },
      output: { mode: 'exact', tolerance: 1e-3 },
    });
    expect(result.error).toBeUndefined();
    expect(rel(volumeOfEntity(result.document, result.affected[0] as string), 10000)).toBeLessThan(1e-5);
    const analysis = execute(result.document, 'analyze_deformation', { id: result.affected[0] }).data as {
      approximation: { facesSplit: number; maxError: number };
    };
    expect(analysis.approximation.facesSplit).toBeGreaterThan(0);
    expect(analysis.approximation.maxError).toBeLessThanOrEqual(1e-3);
  });

  it('refuses what the exact warp cannot honour with the kernel code, and never returns a wrong solid', () => {
    const { doc, id } = box([10, 10, 100], 'base-center');
    const impossible = run(doc, 'twist_body', { id, angleDeg: 20000, output: { mode: 'exact', tolerance: 1e-9 } });
    expect(impossible.affected).toEqual([]);
    expect(['DEF_APPROX_TOLERANCE', 'DEF_BUDGET_EXCEEDED']).toContain(impossible.error?.code);
    const tooTight = run(doc, 'bend_body', { id, radius: 3, angleDeg: 30, frame: { ...FRAME, reference: [0, 1, 0] } });
    expect(['DEF_BEND_RADIUS_TOO_SMALL', 'DEF_FOLDOVER']).toContain(tooTight.error?.code);
  });

  it('deform_lattice builds the pack barrels exactly (VC-DEF-13) and refuses a folding lattice (VC-DEF-27)', () => {
    for (const [m, volume] of [
      [1.5, 1.3666666667],
      [0.5, 0.7],
      [2, 1.8],
    ] as const) {
      const cube = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1], anchor: 'min' });
      const d = (m - 1) / 2;
      const result = run(cube.document, 'deform_lattice', {
        id: cube.affected[0],
        degrees: [1, 1, 2],
        box: 'bounds',
        moves: [
          { index: [0, 0, 1], delta: [-d, -d, 0] },
          { index: [1, 0, 1], delta: [d, -d, 0] },
          { index: [0, 1, 1], delta: [-d, d, 0] },
          { index: [1, 1, 1], delta: [d, d, 0] },
        ],
        output: { mode: 'exact', tolerance: 1e-4 },
      });
      expect(result.error, result.summary).toBeUndefined();
      expect(rel(volumeOfEntity(result.document, result.affected[0] as string), volume)).toBeLessThan(1e-5);
      const data = execute(result.document, 'analyze_deformation', { id: result.affected[0] }).data as {
        jacobian: { bound: { min: number; max: number } };
        volume: { driftRel: number };
      };
      expect(data.volume.driftRel).toBeLessThan(1e-4);
      expect(data.jacobian.bound.max).toBeGreaterThanOrEqual(((1 + m) / 2) ** 2 - 1e-9);
    }
    const bar = box([10, 10, 100], 'base-center');
    const folded = run(bar.doc, 'deform_lattice', {
      id: bar.id,
      degrees: [1, 1, 1],
      moves: [
        { index: [1, 0, 0], delta: [-15, 0, 0] },
        { index: [1, 0, 1], delta: [-15, 0, 0] },
        { index: [1, 1, 0], delta: [-15, 0, 0] },
        { index: [1, 1, 1], delta: [-15, 0, 0] },
      ],
    });
    expect(folded.error?.code).toBe('DEF_FOLDOVER');
  });

  it('deform_by_point raises the pack bump: dV = d pi r^2 / 4 (VC-DEF-15) and refuses past the fold limit (VC-DEF-16)', () => {
    const slab = box([40, 40, 10], 'base-center');
    const params = { id: slab.id, point: [0, 0, 10], direction: [0, 0, 1], radius: 10, falloff: 'smooth_c2' };
    const result = run(slab.doc, 'deform_by_point', { ...params, distance: 2, output: { mode: 'exact', tolerance: 1e-3 } });
    expect(result.error, result.summary).toBeUndefined();
    const delta = volumeOfEntity(result.document, result.affected[0] as string) - 16000;
    expect(rel(delta, 157.079633)).toBeLessThan(1e-3);
    const refused = run(slab.doc, 'deform_by_point', { ...params, distance: 5.88132 });
    expect(refused.error?.code).toBe('DEF_FOLDOVER');
    expect(refused.summary).toContain('5.823094');
  });

  it('flow_along_curve onto a quarter circle equals bend_body (VC-DEF-18) and is exact', () => {
    const length = (50 * Math.PI) / 2;
    const bar = execute(createEmptyDocument(), 'add_box', { size: [10, 10, length], anchor: 'base-center' });
    const arc = execute(bar.document, 'create_conic', { start: [0, 0, 0], apex: [0, 0, 50], end: [0, 50, 50], rho: Math.SQRT2 - 1 });
    const frame = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] };
    const flowed = run(arc.document, 'flow_along_curve', {
      id: bar.affected[0],
      targetId: arc.affected[0],
      frame,
      output: { mode: 'exact', tolerance: 1e-4 },
    });
    expect(flowed.error, flowed.summary).toBeUndefined();
    const bent = run(bar.document, 'bend_body', {
      id: bar.affected[0],
      radius: 50,
      angleDeg: 90,
      frame: { ...frame, reference: [0, 1, 0] },
      output: { mode: 'exact', tolerance: 1e-4 },
    });
    const [a, b] = [flowed.affected[0] as string, bent.affected[0] as string];
    expect(rel(volumeOfEntity(flowed.document, a), volumeOfEntity(bent.document, b))).toBeLessThan(1e-5);
    expect(rel(areaOfEntity(flowed.document, a), areaOfEntity(bent.document, b))).toBeLessThan(1e-4);
  });

  it('flow_on_surface wraps a plate onto the face of a solid drum: V = 2480 outside, 2400 centred, overlap refused (VC-DEF-17)', () => {
    const drum = execute(createEmptyDocument(), 'add_cylinder', { radius: 30, height: 40, position: [0, 10, -30], axis: [0, 1, 0] });
    const base = { plane: { origin: [0, 0, 0], normal: [0, 0, 1], uDirection: [1, 0, 0] } };
    const where = { entityId: drum.affected[0], faceNear: [0, 10, 0] };
    const outside = execute(drum.document, 'add_box', { size: [60, 20, 2], position: [0, 0, 0], anchor: 'min' });
    const wrapped = run(outside.document, 'flow_on_surface', {
      id: outside.affected[0],
      base,
      target: where,
      targetOrigin: [0, 0, 0],
      targetUDirection: [1, 0, 0],
      output: { mode: 'exact', tolerance: 1e-3 },
    });
    expect(wrapped.error, wrapped.summary).toBeUndefined();
    const next = wrapped.affected[0] as string;
    expect(rel(volumeOfEntity(wrapped.document, next), 2480)).toBeLessThan(1e-5);
    const analysis = execute(wrapped.document, 'analyze_deformation', { id: next }).data as {
      volume: { driftRel: number };
      jacobian: { min: number };
    };
    expect(analysis.volume.driftRel).toBeLessThan(1e-3);
    expect(execute(wrapped.document, 'check_deformation', {}).error).toBeUndefined();
    const centred = execute(drum.document, 'add_box', { size: [60, 20, 2], position: [0, 0, 0], anchor: 'center' });
    const middle = run(centred.document, 'flow_on_surface', {
      id: centred.affected[0],
      base,
      target: where,
      targetOrigin: [0, 0, 0],
      targetUDirection: [1, 0, 0],
      output: { mode: 'exact', tolerance: 1e-3 },
    });
    expect(middle.error, middle.summary).toBeUndefined();
    expect(rel(volumeOfEntity(middle.document, middle.affected[0] as string), 2400)).toBeLessThan(1e-4);
    const wide = execute(drum.document, 'add_box', { size: [200, 20, 2], position: [0, 0, 0], anchor: 'min' });
    const overlap = run(wide.document, 'flow_on_surface', {
      id: wide.affected[0],
      base,
      target: where,
      targetOrigin: [0, 0, 0],
      targetUDirection: [1, 0, 0],
    });
    expect(overlap.error?.code).toBe('DEF_FLOW_OVERLAP');
  });

  it('deform_curve_to_curve bends a bar onto a target curve on the exact path and the field is the same function as the mesh path (VC-DEF-33)', () => {
    const bar = box([10, 10, 100], 'base-center');
    const rail = (points: number[][], doc: CadDocument): { doc: CadDocument; id: string } => {
      const made = execute(doc, 'interpolate_curve', { points, degree: 3 });
      return { doc: made.document, id: made.affected[0] as string };
    };
    const initial = rail(
      [0, 25, 50, 75, 100].map((z) => [5, 0, z]),
      bar.doc,
    );
    const goal = rail(
      [0, 25, 50, 75, 100].map((z) => [5 + 20 * (z / 100) ** 2, 0, z]),
      initial.doc,
    );
    const params = {
      id: bar.id,
      pairs: [{ initialId: initial.id, targetId: goal.id }],
      fixedPoints: [
        [0, 0, 0],
        [-5, 0, 0],
        [5, 0, 0],
        [0, 5, 0],
        [0, -5, 0],
      ],
    };
    const exact = run(goal.doc, 'deform_curve_to_curve', { ...params, output: { mode: 'exact', tolerance: 1e-3 } });
    expect(exact.error, exact.summary).toBeUndefined();
    const meshed = run(goal.doc, 'deform_curve_to_curve', { ...params, output: { mode: 'mesh', tolerance: 1e-3 } });
    const a = exact.affected[0] as string;
    expect((exact.data as { path: string }).path).toBe('exact');
    expect(rel(volumeOfEntity(exact.document, a), (meshed.data as { volume: { value: number } }).volume.value)).toBeLessThan(2e-3);
    const check = execute(exact.document, 'check_deformation', {});
    expect((check.data as { status: string }).status).not.toBe('fail');
  });

  /** Largest coordinate of the result mesh along `axis`. */
  const extentMax = (doc: CadDocument, id: string, axis: number): number => {
    const { positions } = (doc.entities[id] as unknown as { mesh: { positions: number[] } }).mesh;
    return positions.reduce((best, value, i) => (i % 3 === axis ? Math.max(best, value) : best), -Infinity);
  };

  it('region.infinite (01 DEF §17.1): twist, stretch and bend keep their rate beyond the region ends, exact path = mesh path', () => {
    const { doc, id } = box([10, 10, 100], 'base-center');
    const both = (
      name: string,
      params: Record<string, unknown>,
    ): { exact: ReturnType<typeof execute>; meshed: ReturnType<typeof execute> } => ({
      exact: run(doc, name, { id, frame: FRAME, ...params, output: { mode: 'exact', tolerance: 1e-4 } }),
      meshed: run(doc, name, { id, frame: FRAME, ...params, output: { mode: 'mesh', tolerance: 1e-4 } }),
    });
    const twist = both('twist_body', { angleDeg: 36, region: { start: 0, end: 20, infinite: true } });
    const whole = run(doc, 'twist_body', {
      id,
      angleDeg: 180,
      frame: FRAME,
      region: { start: 0, end: 100, falloff: 'linear' },
      output: { mode: 'exact', tolerance: 1e-4 },
    });
    const twisted = twist.exact.affected[0] as string;
    expect(twist.exact.error, twist.exact.summary).toBeUndefined();
    expect((twist.exact.data as { path: string; region: { infinite: boolean } }).region.infinite).toBe(true);
    expect(rel(volumeOfEntity(twist.exact.document, twisted), 10000)).toBeLessThan(1e-6);
    expect(rel(areaOfEntity(twist.exact.document, twisted), areaOfEntity(whole.document, whole.affected[0] as string))).toBeLessThan(1e-9);
    expect((twist.exact.data as { path: string }).path).toBe('exact');
    expect(
      rel(volumeOfEntity(twist.exact.document, twisted), (twist.meshed.data as { volume: { value: number } }).volume.value),
    ).toBeLessThan(1e-3);
    const stretch = both('stretch_body', { factor: 2, region: { start: 20, end: 30, infinite: true } });
    expect(rel(volumeOfEntity(stretch.exact.document, stretch.exact.affected[0] as string), 20000)).toBeLessThan(1e-9);
    expect(extentMax(stretch.exact.document, stretch.exact.affected[0] as string, 2)).toBeCloseTo(180, 6);
    expect(extentMax(stretch.meshed.document, stretch.meshed.affected[0] as string, 2)).toBeCloseTo(180, 6);
    const quarter = 25 * Math.PI;
    const rod = execute(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 2 * quarter, anchor: 'base-center' });
    const bend = (mode: string): ReturnType<typeof execute> =>
      run(rod.document, 'bend_body', {
        id: rod.affected[0],
        radius: 50,
        region: { start: 0, end: quarter, infinite: true },
        frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] },
        output: { mode, tolerance: 1e-4 },
      });
    const [arcExact, arcMesh] = [bend('exact'), bend('mesh')];
    expect(arcExact.error, arcExact.summary).toBeUndefined();
    expect(rel(volumeOfEntity(arcExact.document, arcExact.affected[0] as string), Math.PI * 25 * Math.PI * 50)).toBeLessThan(1e-5);
    expect(extentMax(arcExact.document, arcExact.affected[0] as string, 0)).toBeCloseTo(105, 0);
    expect(extentMax(arcMesh.document, arcMesh.affected[0] as string, 0)).toBeCloseTo(105, 0);
  }, 240_000);

  it('an infinite taper whose scale reaches 0 inside the body is refused as a fold on both paths', () => {
    const cylinder = execute(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 40, anchor: 'base-center' });
    for (const mode of ['exact', 'mesh']) {
      const result = run(cylinder.document, 'taper_body', {
        id: cylinder.affected[0],
        scaleEnd: 0.4,
        frame: FRAME,
        region: { start: 0, end: 20, infinite: true },
        output: { mode },
      });
      expect(result.error?.code).toBe('DEF_FOLDOVER');
    }
  });
});
