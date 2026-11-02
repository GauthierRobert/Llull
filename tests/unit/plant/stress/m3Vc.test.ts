/**
 * PST-M3 end to end through the registered commands: the PSI 3D fixture (VC-PST-07 thermal, VC-PST-08 weight), the fully restrained axial force
 * (VC-PST-10) and support switching (VC-PST-11: one-way rest, lift-off, gap, friction). References are read from psi_benchmarks.json.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';
import { expectRel, referenceData } from './stressFixtures';
import {
  analyzed,
  anchorAt,
  baseDoc,
  cases,
  conditioned,
  disp,
  DN100,
  LBF_TO_N,
  MM_PER_IN,
  NPS10,
  PSI_TO_MPA,
  reaction,
  withModel,
  withPipe,
} from './m3Fixtures';

interface PsiCase {
  id: string;
  psi: Record<string, number>;
}
const psi = (id: string): Record<string, number> =>
  (referenceData<{ cases: PsiCase[] }>('psi_benchmarks.json').cases.find((c) => c.id === id) as PsiCase).psi;

const inches = (points: number[][]): number[][] =>
  points.map(([x, y, z]) => [(x as number) * MM_PER_IN, (y as number) * MM_PER_IN, ((z as number) + 480) * MM_PER_IN]);
const PSI_E = 27_900_000 * PSI_TO_MPA;
const PSI_DENSITY = 0.283 * 27679.9; // lb/in3 -> kg/m3
const psiMaterial = { youngsModulusMPa: PSI_E, poisson: 0.3, densityKgM3: PSI_DENSITY };

describe('VC-PST-07 / 08: PSI loads_3d fixture through create_stress_model + analyze_pipe_stress', () => {
  const route = inches([
    [0, 0, 0],
    [0, 0, 120],
    [0, 180, 120],
    [0, 180, -480],
    [0, 480, -480],
  ]);
  const { doc: withRun, id: pipeId } = withPipe(baseDoc(), route, NPS10.odMm);
  const total = route.slice(1).reduce((sum, p, i) => sum + Math.hypot(...p.map((v, k) => v - (route[i]?.[k] ?? 0))), 0);
  const { doc: modelled, id } = withModel(withRun, [pipeId]);
  const ready = cases(
    anchorAt(
      anchorAt(
        conditioned(
          modelled,
          id,
          { installTempC: 70 / 1.8 - 32 / 1.8, temperatures: [{ name: 'T1', tempC: (900 - 32) / 1.8 }], wallMm: NPS10.wallMm },
          { ...psiMaterial, thermal: { meanCtePerK: 7.84e-6 * 1.8 } },
        ),
        id,
        pipeId,
        0,
      ),
      id,
      pipeId,
      total,
    ),
    id,
    [
      { name: 'THERM', type: 'OPE', basic: ['T1'] },
      { name: 'WEIGHT', type: 'SUS', basic: ['W'] },
    ],
  );
  const data = analyzed(ready, id, { include: ['displacements', 'reactions'], nodes: ['N3', 'N1', 'N5'] });

  it('builds 4 straight elements on 5 nodes (sharp corners) with solver residual below 1e-9', () => {
    expect(data.model).toMatchObject({ nodes: 5, elements: 4, dof: 30 });
    expect(data.solver.maxResidual).toBeLessThan(1e-9);
    expect(data.findings.map((f) => f.code)).toContain('PST_SHARP_CORNERS');
  });

  it('VC-PST-07: thermal 900 degF, node 30: dy 0.758 in, dz 1.891 in, rx 0.1521 deg within 1 %', () => {
    const ref = psi('PSI-THERMAL-3D') as { dy: number; dz: number; rxDeg: number };
    const got = disp(data, 'THERM', 'N3');
    expectRel((got.uMm[1] as number) / MM_PER_IN, ref.dy, 0.01, 'dy');
    expectRel((got.uMm[2] as number) / MM_PER_IN, ref.dz, 0.01, 'dz');
    expectRel(got.rotDeg[0] as number, ref.rxDeg, 0.01, 'rx');
  });

  it('VC-PST-08: weight of the steel, node 30: dy 0.33 in, dz -1.31 in, rx -0.40 deg within 3 %', () => {
    const ref = psi('PSI-WEIGHT-3D') as { dy: number; dz: number; rxDeg: number };
    const got = disp(data, 'WEIGHT', 'N3');
    expectRel((got.uMm[1] as number) / MM_PER_IN, ref.dy, 0.03, 'dy');
    expectRel((got.uMm[2] as number) / MM_PER_IN, ref.dz, 0.03, 'dz');
    expectRel(got.rotDeg[0] as number, ref.rxDeg, 0.03, 'rx');
  });

  it('the two anchors carry the whole weight and the thermal reactions are equal and opposite', () => {
    const weight = (n: string): number => reaction(data, 'WEIGHT', n).forceN[2] as number;
    const area = (Math.PI / 4) * (NPS10.odMm ** 2 - (NPS10.odMm - 2 * NPS10.wallMm) ** 2);
    expectRel(weight('N1') + weight('N5'), 9.80665e-9 * PSI_DENSITY * area * total, 1e-7, 'sum of vertical reactions = weight');
    for (let axis = 0; axis < 3; axis++)
      expect(
        Math.abs((reaction(data, 'THERM', 'N1').forceN[axis] as number) + (reaction(data, 'THERM', 'N5').forceN[axis] as number)),
      ).toBeLessThan(1e-3 * Math.abs(reaction(data, 'THERM', 'N1').forceN[1] as number));
  });
});

describe('VC-PST-10: fully restrained axial thermal force', () => {
  it('10 ft NPS 10 between two anchors, 500 degF rise: E A alpha dT = 1.00290e6 lbf within 0.1 % (PSI 1.00235e6)', () => {
    const { doc, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [120 * MM_PER_IN, 0, 3000],
      ],
      NPS10.odMm,
    );
    const { doc: modelled, id } = withModel(doc, [pipeId]);
    const ready = cases(
      anchorAt(
        anchorAt(
          conditioned(
            modelled,
            id,
            { installTempC: 21, temperatures: [{ name: 'T1', tempC: 21 + 430 / 1.8 }], wallMm: NPS10.wallMm },
            { ...psiMaterial, thermal: { meanCtePerK: 7.02e-6 * 1.8 } },
          ),
          id,
          pipeId,
          0,
        ),
        id,
        pipeId,
        120 * MM_PER_IN,
      ),
      id,
      [{ name: 'HOT', type: 'OPE', basic: ['T1'] }],
    );
    const data = analyzed(ready, id, { include: ['reactions'] });
    const force = Math.abs(reaction(data, 'HOT', 'N1').forceN[0] as number);
    expectRel(force / LBF_TO_N, 1_002_903.2, 1e-3, 'closed form');
    expectRel(force / LBF_TO_N, psi('PSI-LIMITSTOP-AXIAL')['fxLbf'] as number, 1e-3, 'PSI');
    expectRel(
      reaction(data, 'HOT', 'N2').forceN[0] as number,
      -(reaction(data, 'HOT', 'N1').forceN[0] as number),
      1e-9,
      'equal and opposite',
    );
  });
});

describe('VC-PST-11: non-linear supports (one-way rest, lift-off, friction, gap)', () => {
  const span = 6000;
  const base = (): { doc: ReturnType<typeof baseDoc>; pipeId: string } => {
    const { doc, id } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [span, 0, 3000],
      ],
      DN100.odMm,
    );
    return { doc, pipeId: id };
  };
  const propped = (loadN: number, extraRest: Record<string, unknown> = {}, frictionCoefficient = 0): { doc: CadDocument; id: string } => {
    const { doc, pipeId } = base();
    const { doc: modelled, id } = withModel(doc, [pipeId], { frictionCoefficient });
    let d = conditioned(modelled, id);
    d = anchorAt(d, id, pipeId, 0);
    d = apply(d, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: span }, kind: 'rest', ...extraRest });
    d = cases(d, id, [{ name: 'P', type: 'SUS', basic: ['F1'] }], [{ name: 'F1', pipeId, atMm: span / 2, forceN: [0, 0, loadN] }]);
    return { doc: d, id };
  };

  it('10 kN down at mid-span: the rest carries 5P/16 = 3125 N (Timoshenko 3126.19 N within 1e-3), status active', () => {
    const { doc, id } = propped(-10000);
    const data = analyzed(doc, id, { include: ['reactions'] });
    expectRel(reaction(data, 'P', 'N3').forceN[2] as number, 3126.19, 1e-3, 'rest reaction');
    expect(data.cases[0]?.contacts[0]).toMatchObject({ status: 'active' });
    expect(data.cases[0]?.iterations).toBe(1);
  });

  it('10 kN up: the rest lifts off (reaction 0, status lifted, PST_SUPPORT_LIFTOFF) and the pipe is a plain cantilever', () => {
    const { doc, id } = propped(10000);
    const data = analyzed(doc, id, { include: ['reactions', 'displacements'] });
    expect(Math.abs(reaction(data, 'P', 'N3').forceN[2] as number)).toBeLessThan(1e-6);
    expect(data.cases[0]?.contacts[0]?.status).toBe('lifted');
    expect(data.findings.map((f) => f.code)).toContain('PST_SUPPORT_LIFTOFF');
    // cantilever with the load at mid-span: end deflection P a^2 (3L - a) / 6EI > mid deflection
    const tip = disp(data, 'P', 'N3').uMm[2] as number;
    expect(tip).toBeGreaterThan(0);
    expect(data.cases[0]?.iterations).toBeGreaterThan(1);
  });

  it('a 40 mm gap rest is open under a light load (gap-open, no reaction) and closes under a heavy one (active at the gap face)', () => {
    const light = propped(-500, { gapMm: 40 });
    const open = analyzed(light.doc, light.id, { include: ['reactions'] });
    expect(open.cases[0]?.contacts[0]?.status).toBe('gap-open');
    expect(Math.abs(reaction(open, 'P', 'N3').forceN[2] as number)).toBeLessThan(1e-6);
    const heavy = propped(-60000, { gapMm: 5 });
    const closed = analyzed(heavy.doc, heavy.id, { include: ['reactions', 'displacements'] });
    expect(closed.cases[0]?.contacts[0]?.status).toBe('active');
    expect(reaction(closed, 'P', 'N3').forceN[2] as number).toBeGreaterThan(0);
    expect(disp(closed, 'P', 'N3').uMm[2]).toBeCloseTo(-5, 6);
  });

  it('friction: a shoe on a hot pipe anchored at one end slides and carries exactly mu N axially (status sliding)', () => {
    const { doc, pipeId } = base();
    const { doc: modelled, id } = withModel(doc, [pipeId], { frictionCoefficient: 0.3 });
    let d = conditioned(modelled, id);
    d = anchorAt(d, id, pipeId, 0);
    d = apply(d, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: span }, kind: 'rest' });
    d = cases(d, id, [{ name: 'HOT', type: 'OPE', basic: ['W', 'T1'] }]);
    const data = analyzed(d, id, { include: ['reactions', 'displacements'] });
    const shoe = reaction(data, 'HOT', 'N2').forceN;
    expect(data.cases[0]?.contacts[0]?.status).toBe('sliding');
    expectRel(Math.abs(shoe[0] as number), 0.3 * (shoe[2] as number), 1e-6, 'axial friction force = mu N');
    const growth = (
      execute(d, 'thermal_growth', { table: 'carbon-steel-c1', fromC: 21.1, toC: 260, lengthM: 6 }).data as { growthMm: number }
    ).growthMm;
    expectRel(
      Math.abs(disp(data, 'HOT', 'N2').uMm[0] as number),
      growth,
      0.01,
      'the sliding end grows freely to within the friction shortening',
    );
  });

  it('a pipe too stiff for the friction to hold sticks: low expansion, shoe force below mu N (status active)', () => {
    const { doc, pipeId } = base();
    const { doc: modelled, id } = withModel(doc, [pipeId], { frictionCoefficient: 0.3 });
    let d = conditioned(modelled, id, { temperatures: [{ name: 'T1', tempC: 21.2 }] });
    d = anchorAt(d, id, pipeId, 0);
    d = apply(d, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: span }, kind: 'rest' });
    d = cases(d, id, [{ name: 'HOT', type: 'OPE', basic: ['W', 'T1'] }]);
    const data = analyzed(d, id, { include: ['reactions'] });
    const shoe = reaction(data, 'HOT', 'N2').forceN;
    expect(data.cases[0]?.contacts[0]?.status).toBe('active');
    expect(Math.abs(shoe[0] as number)).toBeLessThan(0.3 * (shoe[2] as number));
  });
});
