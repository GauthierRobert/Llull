/**
 * PSI fixtures (psi_benchmarks.json, S3 Pipe Stress Infinity, GPL-3.0; numbers transcribed from its test assertions) on @lib/frame3d.
 * VC-PST-07 thermal, VC-PST-08 weight, VC-PST-10 fully restrained axial force, VC-PST-11 propped cantilever and simply supported
 * statics. Units here: in, lbf, psi, degF (PSI's own); PSI compares within 3 % after rounding, the pack tightens to 1 % (thermal).
 */

import { describe, expect, it } from 'vitest';
import { pipeProperties } from '@lib/frame3d/section';
import { analyzeFrame } from '@lib/frame3d/solve';
import type { FrameCaseResult, FrameLoadCase, FrameModel, FramePoint, FrameRestraint } from '@lib/frame3d/types';
import { expectRel, referenceData } from '../plant/stress/stressFixtures';

interface PsiCase {
  id: string;
  node: string;
  psi: Record<string, number>;
  frame3d?: Record<string, number>;
  frame3dEulerBernoulli?: Record<string, number>;
}
const cases = referenceData<{ cases: PsiCase[] }>('psi_benchmarks.json').cases;
const psiCase = (id: string): PsiCase => cases.find((c) => c.id === id) as PsiCase;

const ALL = [0, 1, 2, 3, 4, 5];
const anchor = (node: number): FrameRestraint[] => ALL.map((dof) => ({ node, dof }));
const DEG = 180 / Math.PI;
const NPS10 = pipeProperties(10.75, 0.365, 27_900_000, 0.3);

function run(model: FrameModel, ...loads: FrameLoadCase[]): readonly FrameCaseResult[] {
  const result = analyzeFrame(model, loads);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.cases;
}

describe('loads_3d fixture (node 10 anchor, 4 legs, node 50 anchor)', () => {
  const nodes: FramePoint[] = [
    [0, 0, 0],
    [0, 0, 120],
    [0, 180, 120],
    [0, 180, -480],
    [0, 480, -480],
  ];
  const model: FrameModel = {
    nodes,
    elements: [0, 1, 2, 3].map((a) => ({ a, b: a + 1, properties: NPS10 })),
    restraints: [...anchor(0), ...anchor(4)],
  };
  const at30 = (c: FrameCaseResult): { dy: number; dz: number; rx: number } => ({
    dy: c.displacements[13] as number,
    dz: c.displacements[14] as number,
    rx: (c.displacements[15] as number) * DEG,
  });

  it('VC-PST-07: thermal 900 degF from 70 degF, node 30 dy 0.758, dz 1.891, rx 0.1521 deg within 1 %', () => {
    const strain = 7.84e-6 * (900 - 70);
    const thermal: FrameLoadCase = { name: 'T', elemental: nodes.slice(1).map((_, element) => ({ element, freeStrain: strain })) };
    const c = run(model, thermal)[0] as FrameCaseResult;
    const ref = psiCase('PSI-THERMAL-3D').psi as { dy: number; dz: number; rxDeg: number };
    const got = at30(c);
    expectRel(got.dy, ref.dy, 0.01, 'dy');
    expectRel(got.dz, ref.dz, 0.01, 'dz');
    expectRel(got.rx, ref.rxDeg, 0.01, 'rx');
    const independent = psiCase('PSI-THERMAL-3D').frame3d as { dy: number; dz: number; rxDeg: number };
    expectRel(got.dy, independent.dy, 5e-4, 'dy vs the independent python solver');
    expectRel(got.dz, independent.dz, 5e-4, 'dz vs the independent python solver');
    expectRel(got.rx, independent.rxDeg, 5e-4, 'rx vs the independent python solver');
    expect(c.residual).toBeLessThan(1e-10);
  });

  it('VC-PST-08: weight of the steel (w = 0.283 lb/in3 x A), node 30 dy 0.33, dz -1.31, rx -0.40 deg within 3 %', () => {
    const w = 0.283 * NPS10.area;
    const weight: FrameLoadCase = { name: 'W', elemental: nodes.slice(1).map((_, element) => ({ element, uniform: [0, 0, -w] })) };
    const c = run(model, weight)[0] as FrameCaseResult;
    const ref = psiCase('PSI-WEIGHT-3D').psi as { dy: number; dz: number; rxDeg: number };
    const got = at30(c);
    expectRel(got.dy, ref.dy, 0.03, 'dy');
    expectRel(got.dz, ref.dz, 0.03, 'dz');
    expectRel(got.rx, ref.rxDeg, 0.03, 'rx');
    const independent = psiCase('PSI-WEIGHT-3D').frame3d as { dy: number; dz: number; rxDeg: number };
    expectRel(got.dz, independent.dz, 1e-3, 'dz vs the independent python solver');
    // statics: the anchors carry the whole weight
    const total = w * (120 + 180 + 600 + 300);
    expectRel((c.reactions[2] as number) + (c.reactions[4 * 6 + 2] as number), total, 1e-10, 'sum of vertical reactions');
  });

  it('is exactly the Euler-Bernoulli variant when the shear area is zero: rotations differ by the documented 0.1534 vs 0.1521', () => {
    const euler = pipeProperties(10.75, 0.365, 27_900_000, 0.3, false);
    const strain = 7.84e-6 * 830;
    const thermal: FrameLoadCase = { name: 'T', elemental: [0, 1, 2, 3].map((element) => ({ element, freeStrain: strain })) };
    const c = run({ ...model, elements: model.elements.map((e) => ({ ...e, properties: euler })) }, thermal)[0] as FrameCaseResult;
    expectRel(at30(c).rx, psiCase('PSI-THERMAL-3D').frame3dEulerBernoulli?.rxDeg ?? 0, 5e-4);
  });
});

describe('cantilever_10ft fixture', () => {
  const line: FramePoint[] = [
    [0, 0, 0],
    [60, 0, 0],
    [120, 0, 0],
  ];
  const elements = [0, 1].map((a) => ({ a, b: a + 1, properties: NPS10 }));

  it('VC-PST-10: fully restrained 500 degF axial force E A alpha dT = 1.00290e6 lbf (PSI 1.00235e6) within 0.1 %', () => {
    const ref = psiCase('PSI-LIMITSTOP-AXIAL').psi as { fxLbf: number };
    const model: FrameModel = { nodes: line, elements, restraints: [...anchor(0), ...anchor(2)] };
    const c = run(model, { name: 'T', elemental: [0, 1].map((element) => ({ element, freeStrain: 7.02e-6 * 430 })) })[0] as FrameCaseResult;
    const force = Math.abs(c.reactions[0] as number);
    expectRel(force, 1_002_903.2, 1e-3, 'closed form');
    expectRel(force, ref.fxLbf, 1e-3, 'PSI');
    expectRel(c.reactions[2 * 6] as number, -(c.reactions[0] as number), 1e-12, 'equal and opposite');
  });

  it('VC-PST-11: simply supported, 10000 lbf at mid-span: 5000 lbf at each end (PSI PSI-ONEWAY-BEARING)', () => {
    const ref = psiCase('PSI-ONEWAY-BEARING').psi as { reaction20FyLbf: number };
    const pinned: FrameRestraint[] = [0, 1, 2, 3].map((dof) => ({ node: 0, dof }));
    const model: FrameModel = { nodes: line, elements, restraints: [...pinned, { node: 2, dof: 1 }, { node: 2, dof: 2 }] };
    const c = run(model, { name: 'P', nodal: [{ node: 1, force: [0, -10000, 0] }] })[0] as FrameCaseResult;
    expectRel(c.reactions[2 * 6 + 1] as number, -ref.reaction20FyLbf, 1e-10, 'reaction at node 20');
    expectRel(c.reactions[1] as number, 5000, 1e-10, 'reaction at node 10');
  });

  it('VC-PST-11: 6 m DN100 propped cantilever, 10 kN at mid-span: rest 5P/16 = 3125 N (Euler) and 3126.19 N (Timoshenko)', () => {
    const nodes: FramePoint[] = [
      [0, 0, 0],
      [3000, 0, 0],
      [6000, 0, 0],
    ];
    const rest = (properties: typeof NPS10): number => {
      const model: FrameModel = {
        nodes,
        elements: [0, 1].map((a) => ({ a, b: a + 1, properties })),
        restraints: [...anchor(0), { node: 2, dof: 2 }],
      };
      return (run(model, { name: 'P', nodal: [{ node: 1, force: [0, 0, -10000] }] })[0] as FrameCaseResult).reactions[2 * 6 + 2] as number;
    };
    expectRel(rest(pipeProperties(114.3, 6.02, 200000, 0.3, false)), 3125, 1e-3, 'Euler');
    expectRel(rest(pipeProperties(114.3, 6.02, 200000, 0.3)), 3126.19, 1e-4, 'Timoshenko');
  });
});
