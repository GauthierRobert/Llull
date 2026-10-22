/**
 * Validation pack of 01 DEF (docs/design/01-body-deformation/validation): the M0 / M1 cases that run without the native kernel, with every
 * expected value read from expected_results.json. The mesh path is held to a relative 1e-3 here (pack mesh tolerance 5e-3, VC-DEF-19) at
 * output.tolerance 0.005; exact-kernel cases (VC-DEF-02/03/06/08/11/20/22/23) are server tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import {
  type AnalysisData,
  type CheckData,
  type KernelKind,
  type RunData,
  WORLD_Z,
  addBox,
  areaOf,
  dataOf,
  installKernel,
  meshEntity,
  relative,
  volumeOf,
} from './harness';
import { packExpected, packPlan } from './packPaths';

afterEach(() => setGeometryKernel(null));

const MESH_RELATIVE = 1e-3;
const FINE = { tolerance: 0.005 };
const BEND_FRAME = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] } as const;

describe.each<KernelKind>(['none', 'manifold'])('validation pack on the mesh path, kernel: %s', (kind) => {
  it('VC-DEF-01 twist keeps the volume (det J = 1) for boxes at 90 / 120 / 360 / 180 degrees', async () => {
    await installKernel(kind);
    const cases = packExpected('VC-DEF-01').expected as Array<{
      box: { a: number; b: number; L: number };
      angleDeg: number;
      volume: number;
    }>;
    for (const { box, angleDeg, volume } of cases) {
      const { doc, id } = addBox([box.a, box.b, box.L]);
      const result = execute(doc, 'twist_body', {
        id,
        angleDeg: angleDeg === 0 ? 0.001 : angleDeg,
        frame: WORLD_Z,
        region: { falloff: 'linear' },
        output: FINE,
      });
      expect(
        relative(volumeOf(result.document, result.affected[0] as string), volume),
        `${box.a}x${box.b}x${box.L} at ${angleDeg}`,
      ).toBeLessThan(MESH_RELATIVE);
    }
  });

  it('VC-DEF-02 twisted-box area matches the asinh closed form on the mesh path', async () => {
    await installKernel(kind);
    const areas = new Map([
      [90, 4204.10853848],
      [120, 4207.29883911],
    ]);
    for (const [angleDeg, area] of areas) {
      const { doc, id } = addBox();
      const result = execute(doc, 'twist_body', { id, angleDeg, frame: WORLD_Z, region: { falloff: 'linear' }, output: FINE });
      expect(relative(areaOf(result.document, result.affected[0] as string), area)).toBeLessThan(MESH_RELATIVE);
    }
  });

  it('VC-DEF-04 region-end crease: linear 0.1558065 rad, smooth 0', async () => {
    await installKernel(kind);
    const expected = packExpected('VC-DEF-04').expected as { linearCreaseMaxRad: number; smoothCreaseMaxRad: number };
    const { doc, id } = addBox();
    const creaseOf = (falloff: string): number => {
      const twisted = execute(doc, 'twist_body', {
        id,
        angleDeg: 90,
        frame: WORLD_Z,
        region: { start: 0, end: 50, falloff },
        output: { tolerance: 0.01 },
      });
      return (
        dataOf<AnalysisData>(execute(twisted.document, 'analyze_deformation', { id: twisted.affected[0] as string })).regionCrease[0]
          ?.angleRad ?? NaN
      );
    };
    expect(creaseOf('linear')).toBeCloseTo(expected.linearCreaseMaxRad, 6);
    expect(creaseOf('smooth')).toBe(expected.smoothCreaseMaxRad);
  });

  it('VC-DEF-05 taper volumes: linear, scale up, flat, smooth', async () => {
    await installKernel(kind);
    const cases = packExpected('VC-DEF-05').expected as Array<{ scaleEnd: number; falloff: string; flat: boolean; volume: number }>;
    for (const { scaleEnd, falloff, flat, volume } of cases) {
      const { doc, id } = addBox();
      const result = execute(doc, 'taper_body', { id, scaleEnd, flat, frame: WORLD_Z, region: { falloff }, output: FINE });
      expect(relative(volumeOf(result.document, result.affected[0] as string), volume), `${scaleEnd} ${falloff} ${flat}`).toBeLessThan(
        MESH_RELATIVE,
      );
    }
  });

  it('VC-DEF-07 bend: Pappus volumes and fibre lengths for centred and offset neutral fibres', async () => {
    await installKernel(kind);
    const cases = packExpected('VC-DEF-07').expected as Array<{
      bar: { y0: number; y1: number; L: number };
      radius: number;
      angleDeg: number;
      volume: number;
      inner: number;
      outer: number;
      neutral: number;
    }>;
    for (const entry of cases) {
      const { doc, id } = addBox([10, 10, entry.bar.L]);
      const centre = (entry.bar.y0 + entry.bar.y1) / 2;
      // the neutral fibre is the plane through the frame origin: y0 = -5 for the centred bar, 0 / -10 for the offsets
      const result = execute(doc, 'bend_body', {
        id,
        radius: entry.radius,
        angleDeg: entry.angleDeg,
        frame: { ...BEND_FRAME, origin: [0, -centre, 0] },
        output: FINE,
      });
      const next = result.affected[0] as string;
      expect(relative(volumeOf(result.document, next), entry.volume), `y ${entry.bar.y0}..${entry.bar.y1}`).toBeLessThan(MESH_RELATIVE);
      const analysis = dataOf<AnalysisData>(execute(result.document, 'analyze_deformation', { id: next }));
      expect(analysis.fibres?.neutral).toBeCloseTo(entry.neutral, 6);
      expect(analysis.fibres?.inner).toBeCloseTo(entry.inner, 6);
      expect(analysis.fibres?.outer).toBeCloseTo(entry.outer, 6);
    }
  });

  it('VC-DEF-09 radius below the inner side is refused with min det J -0.25', async () => {
    await installKernel(kind);
    const expected = packExpected('VC-DEF-09').expected as { code: string; paths: string[]; minJacobian: number };
    const { doc, id } = addBox();
    const result = execute(doc, 'bend_body', { id, radius: 4, angleDeg: 90, frame: BEND_FRAME });
    expect(result.error).toMatchObject({ code: expected.code, paths: expected.paths });
    expect(result.error?.remediation.length).toBeGreaterThan(10);
    expect(result.summary).toContain(`min det J ${expected.minJacobian}`);
  });

  it('VC-DEF-10 stretch in a region, and volume-preserving stretch', async () => {
    await installKernel(kind);
    const cases = packExpected('VC-DEF-10').expected as Array<{
      factor: number;
      region: number[] | string;
      volume: number;
      newLength: number;
    }>;
    for (const entry of cases) {
      const { doc, id } = addBox();
      const params = Array.isArray(entry.region)
        ? { id, factor: entry.factor, frame: WORLD_Z, region: { start: entry.region[0], end: entry.region[1] } }
        : { id, factor: entry.factor, frame: WORLD_Z, preserveVolume: true };
      const result = execute(doc, 'stretch_body', params);
      const next = result.affected[0] as string;
      expect(relative(volumeOf(result.document, next), entry.volume)).toBeLessThan(1e-6);
      const positions = meshEntity(result.document, next).mesh.positions;
      const zs = positions.filter((_, i) => i % 3 === 2);
      expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(entry.newLength, 6);
    }
  });

  it('VC-DEF-12 negative factor mirrors with positive volume, zero factor is refused', async () => {
    await installKernel(kind);
    const expected = packExpected('VC-DEF-12').expected as { mirroredVolume: number; zeroFactorCode: string };
    const { doc, id } = addBox([10, 20, 30], 'center');
    const mirrored = execute(doc, 'scale_nonuniform', { id, factors: [-1, 1, 1] });
    expect(volumeOf(mirrored.document, mirrored.affected[0] as string)).toBeCloseTo(expected.mirroredVolume, 6);
    const flat = execute(doc, 'scale_nonuniform', { id, factors: [1, 0, 1] });
    expect(flat.error?.code).toBe(expected.zeroFactorCode);
  });

  it('VC-DEF-19 the mesh path is flagged as a mesh result with its refinement bound', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const result = execute(doc, 'twist_body', { id, angleDeg: 90, frame: WORLD_Z, region: { falloff: 'linear' }, output: FINE });
    const data = dataOf<RunData>(result);
    expect(data.volume.method).toBe('mesh');
    expect(data.path).toBe('mesh');
    const analysis = dataOf<AnalysisData>(execute(result.document, 'analyze_deformation', { id: result.affected[0] as string }));
    expect(analysis.approximation?.maxError).toBeLessThanOrEqual(0.005);
    expect(analysis.volume.driftRel).toBeLessThan(MESH_RELATIVE);
  });

  it('VC-DEF-25 the same params give identical documents; replay of the recorded step regenerates the body', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const params = { id, angleDeg: 90, frame: WORLD_Z, output: { tolerance: 0.01 } };
    expect(execute(doc, 'twist_body', params).document).toEqual(execute(doc, 'twist_body', params).document);
    const edited = execute(execute(doc, 'twist_body', params).document, 'replay_history', {});
    expect(edited.rejected).toBeUndefined();
  });

  it('VC-DEF-21 editing the twist step from 90 to 120 degrees regenerates the body with the closed-form area', async () => {
    await installKernel(kind);
    const expected = packExpected('VC-DEF-21').expected as { volume: number; totalArea: number };
    const { doc, id } = addBox();
    const params = { id, angleDeg: 90, frame: WORLD_Z, region: { start: 0, end: 100, falloff: 'linear' }, output: FINE };
    const built = execute(doc, 'twist_body', params);
    const step = built.document.featureHistory.at(-1);
    expect(step?.name).toBe('twist_body');
    const edited = execute(built.document, 'edit_step_params', { stepId: step?.id, params: { ...params, angleDeg: 120 } });
    const next = edited.document.order[0] as string;
    expect(relative(volumeOf(edited.document, next), expected.volume)).toBeLessThan(MESH_RELATIVE);
    expect(relative(areaOf(edited.document, next), expected.totalArea)).toBeLessThan(MESH_RELATIVE);
  });

  it('VC-DEF-27 / 36 refusal codes with paths and remediation', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const plan = packPlan('target_bad_plan_codes.json');
    const checked: string[] = [];
    for (const step of plan) {
      const command = String(step['command']);
      if (!['bend_body', 'scale_nonuniform', 'twist_body'].includes(command)) continue;
      const params = { ...(step['params'] as Record<string, unknown>) };
      if (params['id'] === '$bar') params['id'] = id;
      const result = execute(doc, command, params);
      expect(result.rejected ?? result.error).toBeTruthy();
      expect(result.error?.remediation.length).toBeGreaterThan(5);
      checked.push(String(result.error?.code));
    }
    expect(checked).toEqual(['DEF_BEND_RADIUS_TOO_SMALL', 'DEF_SCALE_SINGULAR', 'DEF_ENTITY_NOT_FOUND']);
    const overlap = execute(doc, 'bend_body', { id, radius: 50, angleDeg: 400, frame: BEND_FRAME });
    expect(overlap.error).toMatchObject({ code: 'DEF_SELF_INTERSECTION' });
    expect(overlap.error?.ids).toEqual([id]);
  });

  it('VC-DEF-26 release check of a mesh result from an unpinned imported mesh: named defaults, unverified, reviewRequired', async () => {
    await installKernel(kind);
    const tetra = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10], indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] };
    const imported = execute(createEmptyDocument(), 'import_mesh', { bodies: [{ ...tetra, name: 'scan' }] });
    const meshId = imported.affected[0] as string;
    const twisted = execute(imported.document, 'twist_body', {
      id: meshId,
      angleDeg: 20,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] },
      output: { tolerance: 0.05 },
    });
    expect(twisted.affected).toHaveLength(1);
    const check = execute(twisted.document, 'check_deformation', { purpose: 'release' });
    const data = dataOf<CheckData>(check);
    expect(data.unverified).toBe(true);
    expect(data.reviewRequired).toBe(true);
    expect(data.reviewReason).toContain('faceted mesh');
    const codes = data.findings.map((finding) => finding.code);
    expect(codes).toContain('DEF_CHECK_MESH_RESULT');
    expect(codes).toContain('DEF_CHECK_INPUT_UNVERIFIED');
    expect(codes).toContain('DEF_CHECK_TOLERANCE_DEFAULTED');
    expect(data.tolerances.every((entry) => entry.defaulted)).toBe(true);
  });
});
