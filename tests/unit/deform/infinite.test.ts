/** 01 DEF §17.1: `region.infinite` on the axis deformations, mesh path (TS), against the closed forms. The native exact warp: server/tests/nativeKernelDeform.test.ts. */

import { afterEach, describe, expect, it } from 'vitest';
import type { DeformRegion } from '@core/model/deform';
import type { CadDocument, Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { bendFibres, jacobianRange, regionCreases, splitHeights } from '@core/geometry/deform/bounds';
import { localDeterminant, mapLocal } from '@core/geometry/deform/laws';
import { unmapLocal } from '@core/geometry/deform/inverse';
import { rampAt } from '@core/geometry/deform/region';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import {
  type AnalysisData,
  type CheckData,
  type KernelKind,
  type RunData,
  WORLD_Z,
  addBox,
  addCylinder,
  areaOf,
  dataOf,
  installKernel,
  meshEntity,
  relative,
  volumeOf,
} from './harness';
import { deformNode } from './nodes';

const KERNELS: KernelKind[] = ['none', 'manifold'];
const endless = (start: number, end: number, falloff: DeformRegion['falloff'] = 'linear'): DeformRegion => ({
  start,
  end,
  falloff,
  beyond: 'rigid',
  infinite: true,
});
const finite = (start: number, end: number): DeformRegion => ({ start, end, falloff: 'linear', beyond: 'rigid' });
const BEND_Z = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] } as const;

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

function hasVertex(doc: CadDocument, id: string, at: Vec3, eps = 1e-6): boolean {
  const { positions } = meshEntity(doc, id).mesh;
  for (let i = 0; i < positions.length; i += 3)
    if (Math.hypot((positions[i] as number) - at[0], (positions[i + 1] as number) - at[1], (positions[i + 2] as number) - at[2]) < eps)
      return true;
  return false;
}

describe('infinite laws (closed forms)', () => {
  const region = endless(0, 20);

  it('the ramp is the unclamped line, also beyond both ends', () => {
    expect(rampAt(region, -40)).toEqual({ w: -2, d1: 0.05, d2: 0 });
    expect(rampAt(region, 100).w).toBe(5);
    expect(rampAt(finite(0, 20), 100).w).toBe(1);
  });

  it('twist: constant rate beyond both ends, det J 1, inverse round trip', () => {
    const law = { kind: 'twist', angleRad: 0.5 } as const;
    const q: Vec3 = [3, 1, 100];
    const image = mapLocal(law, region, q);
    const theta = 0.5 * (100 / 20);
    expect(image[0]).toBeCloseTo(3 * Math.cos(theta) - Math.sin(theta), 12);
    expect(image[1]).toBeCloseTo(3 * Math.sin(theta) + Math.cos(theta), 12);
    expect(localDeterminant(law, region, q)).toBe(1);
    const back = unmapLocal(law, region, image) as Vec3;
    q.forEach((value, k) => expect(back[k]).toBeCloseTo(value, 12));
    const below = mapLocal(law, region, [1, 0, -20]);
    expect(Math.atan2(below[1], below[0])).toBeCloseTo(-0.5, 12);
  });

  it('taper: s = 1 + (S - 1) t on the whole axis; det J s squared; the range finds a sign change of s', () => {
    const law = { kind: 'taper', scaleEnd: 0.5, flat: false } as const;
    expect(mapLocal(law, region, [2, 4, 60])[0]).toBeCloseTo(2 * (1 - 0.5 * 3), 12);
    expect(localDeterminant(law, region, [0, 0, -20])).toBeCloseTo(1.5 ** 2, 12);
    const node = deformNode(law, { region });
    const within = jacobianRange(node, { min: [-1, -1, 0], max: [1, 1, 30] });
    expect(within.min).toBeCloseTo(0.25 ** 2, 12);
    const across = jacobianRange(node, { min: [-1, -1, 0], max: [1, 1, 50] });
    expect(across.min).toBe(0);
    expect(across.minAt[2]).toBeCloseTo(40, 12);
    const flat = jacobianRange(deformNode({ ...law, flat: true }, { region }), { min: [-1, -1, 0], max: [1, 1, 50] });
    expect(flat.min).toBeCloseTo(-0.25, 12);
  });

  it('stretch: z maps to start + factor (z - start) everywhere, det J = factor everywhere', () => {
    const law = { kind: 'stretch', factor: 3 } as const;
    const step = endless(10, 20, 'none');
    expect(mapLocal(law, step, [1, 2, 100])).toEqual([1, 2, 280]);
    expect(mapLocal(law, step, [1, 2, -5])).toEqual([1, 2, -35]);
    expect(localDeterminant(law, step, [0, 0, -1000])).toBe(3);
    expect(unmapLocal(law, step, [1, 2, 280])).toEqual([1, 2, 100]);
    expect(jacobianRange(deformNode(law, { region: step }), { min: [0, 0, -9], max: [1, 1, 5] })).toMatchObject({ min: 3, max: 3 });
  });

  it('bend: theta = (z - start) / R at every height, round trip, det J (R - y) / R, symmetric keeps the middle', () => {
    const law = { kind: 'bend', radius: 50, symmetric: false } as const;
    const bent = mapLocal(law, endless(0, 10), [0, 0, 50 * Math.PI]);
    expect(bent[1]).toBeCloseTo(100, 9);
    expect(bent[2]).toBeCloseTo(0, 9);
    const before = mapLocal(law, endless(0, 10), [0, 0, (-50 * Math.PI) / 2]);
    expect(before[1]).toBeCloseTo(50, 9);
    expect(before[2]).toBeCloseTo(-50, 9);
    expect(localDeterminant(law, endless(0, 10), [0, 10, 500])).toBeCloseTo(0.8, 12);
    const back = unmapLocal(law, endless(0, 10), mapLocal(law, endless(0, 10), [1, 5, 30])) as Vec3;
    expect(back[2]).toBeCloseTo(30, 9);
    expect(back[1]).toBeCloseTo(5, 9);
    const middle = mapLocal({ ...law, symmetric: true }, endless(0, 10), [0, 0, 5]);
    expect(middle[1]).toBeCloseTo(0, 9);
    expect(middle[2]).toBeCloseTo(5, 9);
  });

  it('no kink to split at, no crease; fibres use the body length', () => {
    const twist = deformNode({ kind: 'twist', angleRad: 1 }, { region });
    const body = { min: [-1, -1, -30], max: [1, 1, 70] } as { min: Vec3; max: Vec3 };
    expect(splitHeights(twist)).toEqual([]);
    expect(regionCreases(twist, body)).toEqual([]);
    expect(splitHeights(deformNode({ kind: 'twist', angleRad: 1 }, { region: finite(0, 20) }))).toEqual([0, 20]);
    const fibres = bendFibres(deformNode({ kind: 'bend', radius: 50, symmetric: false }, { region }), body);
    expect(fibres?.neutral).toBeCloseTo(100, 12);
  });

  it('a recipe node accepts infinite on the axis laws only, with a linear ramp', () => {
    const base = deformNode({ kind: 'twist', angleRad: 1 }, { region });
    const source = { op: 'brep', blob: 'a'.repeat(64), format: 'occt-brep-v1' };
    const valid = (patch: Record<string, unknown>): string | null =>
      validateShapeRecipe(JSON.parse(JSON.stringify({ ...base, source, ...patch })));
    expect(valid({})).toBeNull();
    expect(valid({ region: endless(0, 20, 'smooth') })).toContain('infinite');
    expect(valid({ region: { ...endless(0, 20), infinite: false } })).toContain('infinite must be true');
    const identity = {
      kind: 'affine',
      matrix: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      translation: [0, 0, 0],
    };
    expect(valid({ law: identity, region: endless(0, 20) })).toContain('infinite applies to twist, taper, stretch and bend');
  });
});

describe.each(KERNELS)('infinite deformation commands, kernel: %s', (kind) => {
  it('twist_body keeps the rate beyond the region ends: 36 degrees per 20 units twists a 100 bar by 180 degrees', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const params = { id, angleDeg: 36, frame: WORLD_Z, region: { start: 0, end: 20, infinite: true } };
    const result = execute(doc, 'twist_body', { ...params, output: { tolerance: 0.01 } });
    expect(result.affected).toHaveLength(1);
    const next = result.affected[0] as string;
    expect(meshEntity(result.document, next).brep).toMatchObject({
      op: 'deform',
      region: { start: 0, end: 20, falloff: 'linear', infinite: true },
    });
    expect(hasVertex(result.document, next, [-5, -5, 100])).toBe(true);
    expect(hasVertex(result.document, next, [5, 5, 0])).toBe(true);
    expect(relative(volumeOf(result.document, next), 10000)).toBeLessThan(5e-3);
    const whole = execute(doc, 'twist_body', {
      id,
      angleDeg: 180,
      frame: WORLD_Z,
      region: { start: 0, end: 100, falloff: 'linear' },
      output: { tolerance: 0.01 },
    });
    expect(relative(areaOf(result.document, next), areaOf(whole.document, whole.affected[0] as string))).toBeLessThan(1e-9);
    expect(dataOf<RunData>(result).region).toMatchObject({ infinite: true });
    expectPure(doc, () => execute(doc, 'twist_body', params));
  });

  it('the default region has no infinite key: a finite result keeps its recipe', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const next = execute(doc, 'twist_body', { id, angleDeg: 90, frame: WORLD_Z });
    const recipe = meshEntity(next.document, next.affected[0] as string).brep as unknown as { region: Record<string, unknown> };
    expect(Object.keys(recipe.region).sort()).toEqual(['beyond', 'end', 'falloff', 'start']);
    const off = execute(doc, 'twist_body', { id, angleDeg: 90, frame: WORLD_Z, region: { infinite: false } });
    expect(Object.keys((meshEntity(off.document, off.affected[0] as string).brep as { region: object }).region)).not.toContain('infinite');
  });

  it('analyze and check: an infinite twist has no crease and a right predicted volume; the finite linear twist of the same body warns', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const params = { angleDeg: 36, frame: WORLD_Z, output: { tolerance: 0.01 } };
    const infinite = execute(doc, 'twist_body', { id, ...params, region: { start: 20, end: 40, infinite: true } });
    const bounded = execute(doc, 'twist_body', { id, ...params, region: { start: 20, end: 40, falloff: 'linear' } });
    const analysis = dataOf<AnalysisData>(execute(infinite.document, 'analyze_deformation', { id: infinite.affected[0] as string }));
    expect(analysis.regionCrease).toEqual([]);
    expect(analysis.volume.predicted).toBeCloseTo(10000, 6);
    const verdict = (result: typeof bounded): string[] =>
      dataOf<CheckData>(execute(result.document, 'check_deformation', { ids: [result.affected[0] as string] })).findings.map((f) => f.code);
    expect(verdict(bounded)).toContain('DEF_CHECK_REGION_CREASE');
    expect(verdict(infinite)).not.toContain('DEF_CHECK_REGION_CREASE');
  });

  it('taper_body: the slope of the region continues; the volume is the frustum, predicted volume agrees', async () => {
    await installKernel(kind);
    const { doc, id } = addCylinder(5, 40);
    const result = execute(doc, 'taper_body', {
      id,
      scaleEnd: 0.8,
      frame: WORLD_Z,
      region: { start: 0, end: 80, infinite: true },
      output: { tolerance: 0.005 },
    });
    const next = result.affected[0] as string;
    const frustum = ((Math.PI * 40) / 3) * (25 + 5 * 4.5 + 4.5 * 4.5);
    expect(relative(volumeOf(result.document, next), frustum)).toBeLessThan(2e-2);
    const analysis = dataOf<AnalysisData>(execute(result.document, 'analyze_deformation', { id: next }));
    expect(relative(analysis.volume.predicted / analysis.volume.source, 67.75 / 75)).toBeLessThan(1e-4);
    expect(analysis.jacobian.min).toBeCloseTo(0.9 ** 2, 9);
    expect(analysis.jacobian.max).toBeCloseTo(1, 9);
  });

  it('taper_body refuses a scale that reaches 0 inside the body, where the finite region of the same numbers is fine', async () => {
    await installKernel(kind);
    const { doc, id } = addCylinder(5, 40);
    const refused = execute(doc, 'taper_body', { id, scaleEnd: 0.4, frame: WORLD_Z, region: { start: 0, end: 20, infinite: true } });
    expectNoOp(refused, doc, 'DEF_FOLDOVER');
    const bounded = execute(doc, 'taper_body', { id, scaleEnd: 0.4, frame: WORLD_Z, region: { start: 0, end: 20 } });
    expect(bounded.affected).toHaveLength(1);
  });

  it('stretch_body: a uniform scale of the whole body about region.start', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const result = execute(doc, 'stretch_body', { id, factor: 2, frame: WORLD_Z, region: { start: 20, end: 30, infinite: true } });
    const next = result.affected[0] as string;
    const extent = extentOf(result.document, next);
    expect(extent.min[2]).toBeCloseTo(-20, 9);
    expect(extent.max[2]).toBeCloseTo(180, 9);
    expect(relative(volumeOf(result.document, next), 20000)).toBeLessThan(1e-9);
    const data = dataOf<AnalysisData>(execute(result.document, 'analyze_deformation', { id: next }));
    expect(data.jacobian).toMatchObject({ min: 2, max: 2 });
    expect(data.volume.predicted).toBeCloseTo(20000, 6);
  });

  it('bend_body: a bar longer than the region curves into one arc of length / R radians, no straight tail', async () => {
    await installKernel(kind);
    const quarter = (Math.PI / 2) * 50;
    const { doc, id } = addCylinder(5, 2 * quarter);
    const result = execute(doc, 'bend_body', {
      id,
      radius: 50,
      region: { start: 0, end: quarter, infinite: true },
      frame: BEND_Z,
      output: { tolerance: 0.01 },
    });
    const next = result.affected[0] as string;
    const extent = extentOf(result.document, next);
    expect(extent.max[0]).toBeCloseTo(105, 1);
    expect(extent.max[2]).toBeCloseTo(55, 1);
    expect(relative(volumeOf(result.document, next), Math.PI * 25 * Math.PI * 50)).toBeLessThan(2e-2);
    const bounded = execute(doc, 'bend_body', {
      id,
      radius: 50,
      region: { start: 0, end: quarter },
      frame: BEND_Z,
      output: { tolerance: 0.01 },
    });
    expect(extentOf(bounded.document, bounded.affected[0] as string).max[0]).toBeGreaterThan(120);
    const data = dataOf<AnalysisData>(execute(result.document, 'analyze_deformation', { id: next }));
    expect(data.fibres?.neutral).toBeCloseTo(2 * quarter, 4);
    expect(data.regionCrease).toEqual([]);
  });

  it('bend_body: radius and angleDeg with only infinite: true bend the whole body at that rate; symmetric keeps the arc', async () => {
    await installKernel(kind);
    const { doc, id } = addCylinder(5, 100);
    const arc = execute(doc, 'bend_body', {
      id,
      radius: 100,
      angleDeg: 30,
      region: { infinite: true },
      frame: BEND_Z,
      output: { tolerance: 0.01 },
    });
    expect(arc.affected).toHaveLength(1);
    const data = dataOf<AnalysisData>(execute(arc.document, 'analyze_deformation', { id: arc.affected[0] as string }));
    expect(data.fibres?.neutral).toBeCloseTo(100, 9);
    const symmetric = execute(doc, 'bend_body', {
      id,
      radius: 100,
      length: 100,
      symmetric: true,
      region: { infinite: true },
      frame: BEND_Z,
      output: { tolerance: 0.01 },
    });
    expect(relative(volumeOf(symmetric.document, symmetric.affected[0] as string), Math.PI * 25 * 100)).toBeLessThan(2e-2);
  });

  it('bend_body refuses a body that would turn 360 degrees or more', async () => {
    await installKernel(kind);
    const { doc, id } = addCylinder(5, 320);
    const result = execute(doc, 'bend_body', { id, radius: 50, region: { start: 0, end: 50, infinite: true }, frame: BEND_Z });
    expectNoOp(result, doc, 'DEF_SELF_INTERSECTION');
  });

  it('refuses a smooth ramp on an infinite region by name (twist and taper)', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const twist = execute(doc, 'twist_body', { id, angleDeg: 10, region: { infinite: true, falloff: 'smooth' } });
    expectNoOp(twist, doc, 'DEF_REGION_INVALID');
    expect(twist.summary).toContain('linear');
    expectNoOp(execute(doc, 'taper_body', { id, scaleEnd: 0.9, region: { infinite: true, falloff: 'smooth' } }), doc, 'DEF_REGION_INVALID');
    const linear = execute(doc, 'twist_body', { id, angleDeg: 10, region: { infinite: true, falloff: 'linear' } });
    expect(linear.affected).toHaveLength(1);
  });
});
