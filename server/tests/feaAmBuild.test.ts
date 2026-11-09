/**
 * Additive-build distortion through the real pipeline (PHY-16 VC-PRC-30 / 31): a 30 x 1 mm bar, a 2 mm plate with a 1.5 mm deposit on it (three 0.5 mm layers,
 * inherent strain -0.002 along the bar, E = 200 GPa, nu = 0, test inputs not process data) -> fea_mesh (Netgen, conformal tets) -> fea_solve (CalculiX, layers added with
 * *MODEL CHANGE ADD=STRAIN FREE, one global-temperature step per layer, then the plate removed) -> the curvature read by three probes and compared with the
 * layer-by-layer Euler-Bernoulli oracle of tests/helpers/layeredBeam.ts (the pack's generator, VC-PRC-30.b / .d). Skipped without llull-mesh / ccx.
 * The same bar is solved twice: built along the document Z axis (the build frame is the document frame) and rotated so it is built along the document X axis
 * (frame x = document Y, frame y = document Z): the strain eyy then acts along the bar, which proves the *ORIENTATION of the deck (VC-PRC-31).
 *
 * Measured (CalculiX 2.21, Netgen 6.2.2604, C3D10 size 0.3 mm, 3 probes on the plate-part interface at 10, 15 and 20 mm along the bar): build curvature 0.980 of the oracle,
 * after the release 0.967. The probes sit on nodes that are active from the start: a node added with a layer starts from zero displacement at its activation
 * (CalculiX), so the top face of a FREE plate reads only the last layers (measured 0.24 of the oracle; with a clamped plate the build displacement is negligible and
 * the part nodes read the true distortion after the release). The curvature is the second divided difference of the displacement, so the rigid-body motion (the free
 * choice of the 3-2-1 support) cancels.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { FeMeshArtifact } from '@core/model/analysis';
import { layeredBeam } from '../../tests/helpers/layeredBeam';
import { closeCase, dataOf, listOf, openCase, type PlanStep, type ThermalCase } from './feaThermalSupport';
import { feaToolsMissing } from './feaTestSupport';
import { createNativeTestKernel } from './kernelTestSupport';

const PLAN = path.resolve(__dirname, 'fixtures/am/prc_am_layered_bar.plan.json');
const ORACLE = layeredBeam({ substrate: 2, E: 200000, count: 3, thickness: 0.5, strain: -0.002 });

interface Reading {
  readonly build: number;
  readonly released: number;
  readonly checkItems: readonly string[];
  readonly phases: readonly string[];
}

/** Curvature (1/mm) from three probes at the given node positions along the bar: 2 [(w3 - w2)/(x3 - x2) - (w2 - w1)/(x2 - x1)] / (x3 - x1). */
const curvature = (x: readonly number[], w: readonly number[]): number => {
  const [x1 = 0, x2 = 0, x3 = 0] = x;
  const [w1 = 0, w2 = 0, w3 = 0] = w;
  return (2 * ((w3 - w2) / (x3 - x2) - (w2 - w1) / (x2 - x1))) / (x3 - x1);
};

/** Swap the document X and Z axes in every number triple, size, point and dof of the plan (the bar then lies along Z and is built along X). */
function rotateToBuildAlongX(plan: readonly PlanStep[]): PlanStep[] {
  const swap = (value: unknown): unknown => {
    if (Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number'))
      return [value[2], value[1], value[0]];
    if (Array.isArray(value)) return value.map(swap);
    if (typeof value === 'object' && value !== null)
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
          const renamed = key === 'ux' ? 'uz' : key === 'uz' ? 'ux' : key;
          return [renamed, swap(entry)];
        }),
      );
    return value === 'u_z' ? 'u_x' : value;
  };
  return plan.map((step) => {
    const params = swap(step.params) as Record<string, unknown>;
    // the bar axis is the frame y axis when built along X: the strain moves from exx to eyy
    return step.command === 'set_inherent_strain' ? { ...step, params: { ...params, exx: 0, eyy: -0.002, ezz: 0 } } : { ...step, params };
  });
}

async function solve(c: ThermalCase, plan: readonly PlanStep[], along: 'x' | 'z'): Promise<Reading> {
  const planned = await c.runPlan(plan);
  expect(planned.code, String(planned.json['summary'])).toBe(0);
  const meshed = await c.cli('fea_mesh', `analysisId=${c.analysisId}`, 'timeoutS=300');
  expect(meshed.code, String(meshed.json['summary'])).toBe(0);
  const mesh = JSON.parse(
    gunzipSync(readFileSync(path.join(c.dir, 'cache', `${String(dataOf(meshed.json)['meshHash'])}.json.gz`))).toString('utf8'),
  ) as FeMeshArtifact;
  const solved = await c.cli('fea_solve', `analysisId=${c.analysisId}`, 'timeoutS=1500');
  expect(solved.code, String(solved.json['summary'])).toBe(0);
  const checked = await c.cli('check_analysis', `analysisId=${c.analysisId}`);
  const checkItems = listOf(dataOf(checked.json)['items']).map((item) => `${String(item['severity'])}:${String(item['code'])}`);
  const report = await c.cli('analysis_report', `analysisId=${c.analysisId}`);
  expect(report.code, String(report.json['summary'])).toBe(0);
  const axis = new Map(mesh.nodes.map(([id, px, , pz]) => [id, along === 'z' ? px : pz] as const));
  const probes = listOf(dataOf(report.json)['probes']).sort((p, q) => String(p['name']).localeCompare(String(q['name'])));
  const at = (phase: string): number[] =>
    probes.map((probe) => {
      const value = listOf(probe['values']).find((entry) => entry['loadCase'] === phase)?.['value'];
      if (typeof value !== 'number') throw new Error(`probe ${String(probe['name'])} has no ${phase} value`);
      return value;
    });
  const positions = probes.map((probe) => axis.get(Number(probe['nodeId'])) ?? Number.NaN);
  const phases = (c.document().analysis?.cases[c.analysisId]?.results?.loadCases ?? []).map((entry) => entry.name);
  return { build: curvature(positions, at('build')), released: curvature(positions, at('cut_plate')), checkItems, phases };
}

describe.skipIf(feaToolsMissing(true))('am build distortion (netgen + ccx)', () => {
  let c: ThermalCase | undefined;
  const readings: Partial<Record<'z' | 'x', Reading>> = {};

  beforeAll(async () => {
    c = await openCase('am');
    setGeometryKernel(createNativeTestKernel()); // conformal bonding needs the exact B-rep
    const plan = JSON.parse(readFileSync(PLAN, 'utf8')) as PlanStep[];
    readings.z = await solve(c, plan, 'z');
    readings.x = await solve(c, rotateToBuildAlongX(plan), 'x');
  }, 3_600_000);
  afterAll(() => closeCase(c));

  const reading = (along: 'z' | 'x'): Reading => {
    const found = readings[along];
    if (found === undefined) throw new Error(`no reading for the build along ${along}`);
    return found;
  };

  it('builds three layers and releases the plate: the set-up is complete (only the uncalibrated-strain warning) and the solve recorded both phases', () => {
    for (const along of ['z', 'x'] as const) {
      expect(reading(along).checkItems.filter((item) => item.startsWith('error:'))).toEqual([]);
      expect(reading(along).checkItems).toContain('warning:PRC_INHERENT_STRAIN_UNCALIBRATED');
      expect(reading(along).phases).toEqual(['build', 'cut_plate']);
    }
  });

  it('VC-PRC-30.b: after the three layers the interface is concave up with the oracle curvature within 5 % (measured -2.0 %)', () => {
    // the oracle's sign is the eigenstrain's (negative = the top shortens = concave up = positive second difference)
    expect(reading('z').build).toBeGreaterThan(0);
    expect(Math.abs(reading('z').build / -ORACLE.total - 1)).toBeLessThan(0.05);
  });

  it('VC-PRC-30.d: removing the plate adds the oracle curvature (build + release) within 5 % (measured -3.4 %)', () => {
    expect(reading('z').released).toBeGreaterThan(reading('z').build);
    expect(Math.abs(reading('z').released / -(ORACLE.total + ORACLE.release) - 1)).toBeLessThan(0.05);
  });

  it('VC-PRC-31: built along the document X axis the build frame (x = Y, y = Z, z = X) gives the same curvatures: the *ORIENTATION maps eyy onto the bar axis', () => {
    expect(Math.abs(reading('x').build / reading('z').build - 1)).toBeLessThan(0.02);
    expect(Math.abs(reading('x').released / reading('z').released - 1)).toBeLessThan(0.02);
  });
});
