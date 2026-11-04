/**
 * PST-M3 code check end to end: VC-PST-12 (two-anchor L-bend through the commands), the stress formulas against hand values (mid-element extremum,
 * pressure, corrosion, occasional), SIFs of an RTE bend against pipe_sif, rule-set differences and the findings of check_pipe_stress.
 */

import { describe, expect, it } from 'vitest';
import { analyzeFrame } from '@lib/frame3d/solve';
import { pipeProperties } from '@lib/frame3d/section';
import { execute } from '@core/commands/registry';
import { deriveRun } from '@aec/plant/piping/routeParts';
import type { CadDocument } from '@core/model/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { cs150Line, valveScene } from '../piping/rteFixtures';
import {
  analyzed,
  anchorAt,
  baseDoc,
  cases,
  conditioned,
  DN100,
  reaction,
  steel,
  withModel,
  withPipe,
  type AnalysisData,
} from './m3Fixtures';
import { expectRel, referenceData } from './stressFixtures';

const GRAVITY = 9.80665;
const L_BEND = referenceData<{
  section: { DoMm: number; tMm: number; ZMm3: number };
  lBendTwoAnchors: { expectedWithAxial: { reactionAtC_N: number[]; SmaxMPa: number; momentMagnitudesNmm: { C: number } } };
}>('lbend_guided_cantilever.json');
const NPS6 = { odMm: L_BEND.section.DoMm, wallMm: L_BEND.section.tMm };

/** Two-anchor L-bend 6 m x 3 m, NPS 6 Sch 40, strain 0.00225 = 1.2e-5 x 187.5 K. */
function lBend(
  over: Record<string, unknown> = {},
  material: Record<string, unknown> = {},
  modelExtra: Record<string, unknown> = {},
): { doc: CadDocument; id: string; pipeId: string } {
  const { doc, id: pipeId } = withPipe(
    baseDoc(),
    [
      [0, 0, 3000],
      [6000, 0, 3000],
      [6000, 3000, 3000],
    ],
    NPS6.odMm,
    { dn: 150 },
  );
  const { doc: modelled, id } = withModel(doc, [pipeId], modelExtra);
  let d = conditioned(
    modelled,
    id,
    { installTempC: 20, temperatures: [{ name: 'T1', tempC: 207.5 }], wallMm: NPS6.wallMm, ...over },
    { thermal: { meanCtePerK: 1.2e-5 }, ...material },
  );
  d = anchorAt(anchorAt(d, id, pipeId, 0), id, pipeId, 9000);
  return { doc: d, id, pipeId };
}
const exp = (d: CadDocument, id: string): CadDocument =>
  cases(d, id, [
    { name: 'SUS', type: 'SUS', basic: ['W'] },
    { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
    {
      name: 'EXP',
      type: 'EXP',
      combine: [
        { case: 'OPE', factor: 1 },
        { case: 'SUS', factor: -1 },
      ],
    },
  ]);
type StressDetail = NonNullable<NonNullable<AnalysisData['details']>['stresses']>[number];
const row = (data: AnalysisData, caseName: string, node: string | null): StressDetail | undefined =>
  data.details?.stresses?.find((entry) => entry.case === caseName && entry.node === node);

describe('VC-PST-12: two-anchor L-bend through the commands (sharp corner, k = 1, i = 1)', () => {
  const { doc, id } = lBend();
  const result = analyzed(exp(doc, id), id, { include: ['reactions', 'stresses'] });

  it('the expansion range reproduces the reaction at C and S_max = 106.791 MPa at the anchor C', () => {
    const ref = L_BEND.lBendTwoAnchors.expectedWithAxial;
    const c = reaction(result, 'EXP', 'N3');
    expectRel(c.forceN[0] as number, ref.reactionAtC_N[0] as number, 2e-2, 'Rx at C (Euler-Bernoulli reference, the model is Timoshenko)');
    expectRel(c.forceN[1] as number, ref.reactionAtC_N[1] as number, 2e-2, 'Ry at C');
    // against the solver called directly with the same section: the command plumbing adds nothing
    const section = pipeProperties(NPS6.odMm, NPS6.wallMm, 200000, 0.3);
    const direct = analyzeFrame(
      {
        nodes: [
          [0, 0, 3000],
          [6000, 0, 3000],
          [6000, 3000, 3000],
        ],
        elements: [0, 1].map((a) => ({ a, b: a + 1, properties: section })),
        restraints: [0, 2].flatMap((node) => [0, 1, 2, 3, 4, 5].map((dof) => ({ node, dof }))),
      },
      [{ name: 'T', elemental: [0, 1].map((element) => ({ element, freeStrain: 1.2e-5 * 187.5 })) }],
    );
    if (!direct.ok) throw new Error(direct.message);
    expectRel(c.forceN[0] as number, direct.cases[0]?.reactions[2 * 6] as number, 1e-6, 'Rx at C vs frame3d Timoshenko');
    expectRel(c.forceN[1] as number, direct.cases[0]?.reactions[2 * 6 + 1] as number, 1e-6, 'Ry at C vs frame3d Timoshenko');
    const atC = row(result, 'EXP', 'N3');
    expectRel(atC?.stressMPa as number, ref.SmaxMPa, 2e-2, 'S_E at C');
    const expRows = (result.details?.stresses ?? []).filter((entry) => entry.case === 'EXP');
    expect(Math.max(...expRows.map((entry) => entry.stressMPa))).toBeCloseTo(atC?.stressMPa as number, 6);
    expect(atC?.sif).toEqual({ ii: 1, io: 1 });
  });

  it('the allowable is eq. (1b) per node (liberal: S_A = f (1.25 (Sc + Sh) - S_L) above eq. (1a)) and the governing entry names the rule', () => {
    const atC = row(result, 'EXP', 'N3');
    expect(atC?.allowableMPa).toBeGreaterThan(1.25 * 138 + 0.25 * 138); // f = 1.0 at 7000 cycles with the cap of 1.0
    expect(atC?.allowableMPa).toBeLessThan(1.25 * 276);
    expect(result.governing.find((entry) => entry.case === 'EXP')).toMatchObject({ rule: 'B313-SA-1A' });
    expect(result.status).toBe('pass');
  });
});

describe('stress formulas against hand values', () => {
  it('mid-element extremum: anchor + rest on one element recovers the positive moment 9 w L^2 / 128 at x = 5L/8 (SUS, B31.3 S_L = M / Z)', () => {
    const { doc: pipes, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [6000, 0, 3000],
      ],
      DN100.odMm,
    );
    const { doc, id } = withModel(pipes, [pipeId], { frictionCoefficient: 0 });
    let d = conditioned(doc, id, { fluidDensityKgM3: 1000 });
    d = anchorAt(d, id, pipeId, 0);
    d = apply(d, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: 6000 }, kind: 'rest' });
    d = cases(d, id, [{ name: 'SUS', type: 'SUS', basic: ['W'] }]);
    const result = analyzed(d, id, { include: ['stresses'] });
    const inner = DN100.odMm - 2 * DN100.wallMm;
    const w = GRAVITY * 1e-9 * (7850 * (Math.PI / 4) * (DN100.odMm ** 2 - inner ** 2) + 1000 * (Math.PI / 4) * inner ** 2);
    const Z = ((Math.PI / 32) * (DN100.odMm ** 4 - inner ** 4)) / DN100.odMm;
    const stations = result.details?.stresses ?? [];
    const mid = stations.filter((entry) => entry.node === null);
    expect(mid).toHaveLength(1);
    expectRel(mid[0]?.xMm as number, 3750, 5e-3, 'extremum at 5L/8 (Timoshenko shifts it slightly)');
    expectRel(mid[0]?.stressMPa as number, (9 * w * 6000 ** 2) / 128 / Z, 5e-3, 'mid-element moment');
    const fixed = stations.find((entry) => entry.node === 'N1');
    expectRel(fixed?.stressMPa as number, (w * 6000 ** 2) / 8 / Z, 5e-3, 'fixed end moment w L^2 / 8');
    expect(result.governing[0]?.nodeId).toBe('N1');
  });

  it('pressure alone: B31.3 sustained S_a = P Di^2 / (Do^2 - Di^2) (8.0213 MPa at 2 MPa) and B31.1 P Do / 4t = 9.493 MPa', () => {
    const run = (rule: string): number => {
      const { doc: pipes, id: pipeId } = withPipe(
        baseDoc(),
        [
          [0, 0, 3000],
          [3000, 0, 3000],
        ],
        DN100.odMm,
      );
      const { doc, id } = withModel(pipes, [pipeId], { rule });
      let d = conditioned(doc, id, { pressures: [{ name: 'P1', gaugeBar: 20 }] });
      d = anchorAt(anchorAt(d, id, pipeId, 0), id, pipeId, 3000);
      d = cases(d, id, [{ name: 'SUS', type: 'SUS', basic: ['P1'] }]);
      return (analyzed(d, id, { include: ['stresses'] }).details?.stresses ?? [])[0]?.stressMPa as number;
    };
    expectRel(run('B31.3-2018'), 8.0213, 1e-4, 'B31.3');
    expectRel(run('B31.1-2018'), 9.4934, 1e-4, 'B31.1');
  });

  it('the corrosion allowance thins the wall of the sustained check only: the stress rises, the expansion stress does not', () => {
    const stress = (corrosion: number, caseName: string): number => {
      const { doc, id } = lBend({ corrosionAllowanceMm: corrosion });
      const stresses = analyzed(exp(doc, id), id, { include: ['stresses'] }).details?.stresses ?? [];
      return Math.max(...stresses.filter((entry) => entry.case === caseName).map((entry) => entry.stressMPa));
    };
    expect(stress(3, 'SUS')).toBeGreaterThan(stress(0, 'SUS') * 1.05);
    expect(stress(3, 'EXP')).toBeCloseTo(stress(0, 'EXP'), 6);
  });

  it('the occasional case is checked against 1.33 S_h (B31.3) and 1.15 S_h (B31.1) on the full occasional state', () => {
    const occ = (rule: string): AnalysisData => {
      const { doc: pipes, id: pipeId } = withPipe(
        baseDoc(),
        [
          [0, 0, 3000],
          [6000, 0, 3000],
        ],
        DN100.odMm,
      );
      const { doc, id } = withModel(pipes, [pipeId], { rule, frictionCoefficient: 0 });
      let d = anchorAt(anchorAt(conditioned(pipes && doc, id), id, pipeId, 0), id, pipeId, 6000);
      d = cases(d, id, [{ name: 'OCC', type: 'OCC', basic: ['W', 'F1'] }], [{ name: 'F1', pipeId, atMm: 3000, forceN: [0, 0, -5000] }]);
      return analyzed(d, id, { include: ['stresses'] });
    };
    const b313 = occ('B31.3-2018');
    expect(b313.details?.stresses?.[0]?.allowableMPa).toBeCloseTo(1.33 * 138, 6);
    expect(b313.governing[0]?.rule).toBe('B313-OCC');
    expect(occ('B31.1-2018').details?.stresses?.[0]?.allowableMPa).toBeCloseTo(1.15 * 138, 6);
  });
});

describe('bends from an RTE run carry the SIFs of pipe_sif', () => {
  it('a 90 degree standard elbow of a routed run: ii / io equal pipe_sif at the derived OD, wall and radius; the flexible bend lowers the reaction', () => {
    const { doc: withLine, lineId } = cs150Line();
    const routed = ok(withLine, 'route_pipe', {
      lineId,
      from: { point: [0, 0, 3000], direction: [1, 0, 0] },
      legs: [
        { direction: '+X', length: 6000 },
        { direction: '+Y', length: 3000 },
      ],
    });
    const runId = routed.affected[0] as string;
    const derivation = deriveRun(routed.document, routed.document.plant?.piping?.runs[runId] as never);
    if (!derivation.ok) throw new Error('run does not derive');
    const turn = derivation.turns[0] as { radius: number };
    const { doc: modelled, id } = withModel(routed.document, [runId], { elbowRadiusFactor: 1.5 });
    let d = conditioned(
      modelled,
      id,
      { wallMm: undefined, installTempC: 20, temperatures: [{ name: 'T1', tempC: 207.5 }] },
      { thermal: { meanCtePerK: 1.2e-5 } },
    );
    d = anchorAt(anchorAt(d, id, runId, 0), id, runId, 9000);
    d = exp(d, id);
    const result = analyzed(d, id, { include: ['stresses'] });
    const sif = data<{ ii: number; io: number; k: number }>(d, 'pipe_sif', {
      component: 'elbow',
      rule: 'B31.3-2018',
      odMm: derivation.pipe.outsideDiameterMm,
      wallMm: derivation.pipe.wallMm,
      bendRadiusMm: turn.radius,
    });
    const bendRows = (result.details?.stresses ?? []).filter((entry) => entry.sif.ii > 1);
    expect(bendRows.length).toBeGreaterThan(0);
    for (const entry of bendRows) {
      expect(entry.sif.ii).toBeCloseTo(sif.ii, 9);
      expect(entry.sif.io).toBeCloseTo(sif.io, 9);
    }
    expect(result.model.elements).toBeGreaterThan(12);
    expect(result.findings.map((finding) => finding.code)).not.toContain('PST_SHARP_CORNERS');
  });

  it('building pipes use the model elbow radius factor (R = 1.5 x DN for a long radius bend) and are flagged sharp at factor 0', () => {
    const sharp = lBend();
    const sharpData = analyzed(exp(sharp.doc, sharp.id), sharp.id);
    expect(sharpData.findings.map((finding) => finding.code)).toContain('PST_SHARP_CORNERS');
    const flexible = lBend({}, {}, { elbowRadiusFactor: 1.5 });
    const flexData = analyzed(exp(flexible.doc, flexible.id), flexible.id, { include: ['reactions', 'stresses'] });
    expect(flexData.model.elements).toBeGreaterThan(sharpData.model.elements);
    const sharpReaction = reaction(analyzed(exp(sharp.doc, sharp.id), sharp.id, { include: ['reactions'] }), 'EXP', 'N3').forceN;
    const flexReaction = reaction(flexData, 'EXP', `N${flexData.model.nodes}`).forceN;
    expect(Math.hypot(...(flexReaction as [number, number, number]))).toBeLessThan(
      Math.hypot(...(sharpReaction as [number, number, number])),
    );
  });

  it('a leg shorter than the bend tangent length is PST_BEND_TOO_TIGHT with the pipe id', () => {
    const { doc: pipes, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [100, 0, 3000],
        [100, 3000, 3000],
      ],
      DN100.odMm,
      { dn: 100 },
    );
    const { doc, id } = withModel(pipes, [pipeId], { elbowRadiusFactor: 1.5 });
    const ready = cases(conditioned(doc, id), id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    const refusal = expectRefusal(ready, 'analyze_pipe_stress', { modelId: id }, 'PST_BEND_TOO_TIGHT');
    expect(refusal.error?.ids).toEqual([pipeId]);
    // a radius below the pipe radius is not a bend either
    expectRefusal(
      apply(ready, 'update_stress_model', { modelId: id, elbowRadiusFactor: 0.2 }),
      'analyze_pipe_stress',
      { modelId: id },
      'PST_BEND_TOO_TIGHT',
    );
  });

  it('a pipe ending on the interior of another is a tee node (M5a), not a refusal: the unrestrained system is PST_UNSTABLE at its first node', () => {
    const a = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [6000, 0, 3000],
      ],
      DN100.odMm,
    );
    const b = withPipe(
      a.doc,
      [
        [3000, 0, 3000],
        [3000, 2000, 3000],
      ],
      DN100.odMm,
    );
    const { doc, id } = withModel(b.doc, [a.id, b.id]);
    const ready = cases(conditioned(doc, id), id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    expectRefusal(ready, 'analyze_pipe_stress', { modelId: id }, 'PST_UNSTABLE');
  });
});

describe('check_pipe_stress', () => {
  it('reports the overstress codes as fail items and ok false; sustained, expansion and occasional each by their own code', () => {
    const { doc, id } = lBend({}, { ShMPa: 20, ScMPa: 20 });
    const ready = cases(
      doc,
      id,
      [
        { name: 'SUS', type: 'SUS', basic: ['W'] },
        { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
        {
          name: 'EXP',
          type: 'EXP',
          combine: [
            { case: 'OPE', factor: 1 },
            { case: 'SUS', factor: -1 },
          ],
        },
        { name: 'OCC', type: 'OCC', basic: ['W', 'F1'] },
      ],
      [{ name: 'F1', pipeId: doc.plant?.stress?.models[id]?.scope.ids[0] as string, atMm: 4500, forceN: [0, 0, -30000] }],
    );
    const result = data<{
      ok: boolean;
      status: string;
      items: { code: string; severity: string; ids: string[] }[];
      reviewRequired: boolean;
    }>(ready, 'check_pipe_stress', { modelId: id });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('fail');
    expect(result.reviewRequired).toBe(true);
    const fails = result.items.filter((item) => item.severity === 'fail').map((item) => item.code);
    expect(fails).toEqual(expect.arrayContaining(['PST_EXPANSION_OVERSTRESS', 'PST_OCCASIONAL_OVERSTRESS']));
    expect(result.items.find((item) => item.code === 'PST_EXPANSION_OVERSTRESS')?.ids.length).toBeGreaterThan(0);
  });

  it('sustained overstress of a long unsupported span fails PST_SUSTAINED_OVERSTRESS and a short stiff one passes', () => {
    const run = (length: number): string => {
      const { doc: pipes, id: pipeId } = withPipe(
        baseDoc(),
        [
          [0, 0, 3000],
          [length, 0, 3000],
        ],
        DN100.odMm,
      );
      const { doc, id } = withModel(pipes, [pipeId], { maxElementLengthMm: 1000 });
      const d = cases(anchorAt(anchorAt(conditioned(doc, id, { fluidDensityKgM3: 1000 }), id, pipeId, 0), id, pipeId, length), id, [
        { name: 'SUS', type: 'SUS', basic: ['W'] },
        { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
        {
          name: 'EXP',
          type: 'EXP',
          combine: [
            { case: 'OPE', factor: 1 },
            { case: 'SUS', factor: -1 },
          ],
        },
      ]);
      return (data(d, 'check_pipe_stress', { modelId: id }) as { items: { code: string; severity: string }[]; status: string }).items
        .filter((item) => item.severity === 'fail')
        .map((item) => item.code)
        .join();
    };
    expect(run(40000)).toContain('PST_SUSTAINED_OVERSTRESS');
    expect(run(2000)).not.toContain('PST_SUSTAINED_OVERSTRESS');
  });

  it('status incomplete (PST_CASE_INCOMPLETE) without an expansion case, defaults and the B31J edition are warnings that cannot be hidden', () => {
    const { doc, id } = lBend(
      { cycles: undefined, corrosionAllowanceMm: undefined, installTempC: 21.1 },
      { thermal: { table: 'carbon-steel-c1' } },
      { rule: 'B31.3-2020' },
    );
    const ready = cases(doc, id, [{ name: 'SUS', type: 'SUS', basic: ['W'] }]);
    const result = data<{ ok: boolean; status: string; items: { code: string; severity: string }[] }>(ready, 'check_pipe_stress', {
      modelId: id,
    });
    const codes = result.items.map((item) => item.code);
    expect(result.status).toBe('incomplete');
    expect(result.ok).toBe(true);
    expect(codes).toEqual(
      expect.arrayContaining([
        'PST_CASE_INCOMPLETE',
        'PST_SIF_EDITION',
        'PST_CYCLES_DEFAULTED',
        'PST_FRICTION_DEFAULTED',
        'PST_CORROSION_DEFAULTED',
      ]),
    );
    expect(result.items.every((item) => item.severity !== 'fail')).toBe(true);
  });

  it('an unverified thermal source raises PST_MATERIAL_UNVERIFIED, a displacement limit raises PST_DISPLACEMENT_LIMIT', () => {
    const { doc, id } = lBend();
    const ready = exp(doc, id);
    const result = data<{ items: { code: string }[] }>(ready, 'check_pipe_stress', { modelId: id, displacementLimitMm: 5 });
    expect(result.items.map((item) => item.code)).toEqual(expect.arrayContaining(['PST_MATERIAL_UNVERIFIED', 'PST_DISPLACEMENT_LIMIT']));
    const roomy = data<{ items: { code: string }[] }>(ready, 'check_pipe_stress', { modelId: id, displacementLimitMm: 5000 });
    expect(roomy.items.map((item) => item.code)).not.toContain('PST_DISPLACEMENT_LIMIT');
  });

  it('refuses like analyze_pipe_stress and is read-only', () => {
    const { doc, id } = lBend();
    expectRefusal(doc, 'check_pipe_stress', { modelId: 'ghost' }, 'PST_MODEL_NOT_FOUND');
    expectRefusal(doc, 'check_pipe_stress', { modelId: id }, 'PST_LOADCASE_INVALID');
    const result = execute(exp(doc, id), 'check_pipe_stress', { modelId: id });
    expect(result.affected).toEqual([]);
  });
});

describe('corrosion allowance and non-finite stress', () => {
  it('a corrosion allowance equal to or above the wall is refused where it is set and where the wall is read from the spec', () => {
    const { doc, id } = lBend();
    const set = (corrosionAllowanceMm: number): unknown => ({ modelId: id, ...steel({ corrosionAllowanceMm, wallMm: NPS6.wallMm }) });
    expectRefusal(doc, 'set_pipe_operating_conditions', set(NPS6.wallMm), 'PST_CORROSION_EXCEEDS_WALL', 'corrosionAllowanceMm');
    expectRefusal(doc, 'set_pipe_operating_conditions', set(NPS6.wallMm + 3), 'PST_CORROSION_EXCEEDS_WALL');
    expectRefusal(doc, 'set_pipe_operating_conditions', set(NPS6.wallMm - 0.05), 'PST_CORROSION_EXCEEDS_WALL');
    ok(doc, 'set_pipe_operating_conditions', set(NPS6.wallMm - 1));
    // wall from the RTE derivation: the check happens at analysis
    const scene = valveScene();
    const created = ok(scene.doc, 'create_stress_model', { name: 'r', pipeIds: [scene.runId], rule: 'B31.3-2018' });
    const modelId = (created.data as { modelId: string }).modelId;
    const thin = cases(conditioned(created.document, modelId, { wallMm: undefined, corrosionAllowanceMm: 50 }), modelId, [
      { name: 'S', type: 'SUS', basic: ['W'] },
    ]);
    const refusal = expectRefusal(thin, 'analyze_pipe_stress', { modelId }, 'PST_CORROSION_EXCEEDS_WALL');
    expect(refusal.error?.ids).toEqual([scene.runId]);
  });

  it('every stress row of every VC model is finite', () => {
    const models = [lBend(), lBend({ corrosionAllowanceMm: 2 }, {}, { elbowRadiusFactor: 1.5 }), lBend({}, {}, { rule: 'B31.1-2018' })];
    for (const { doc, id } of models) {
      const rows = analyzed(exp(doc, id), id, { include: ['stresses'] }).details?.stresses ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const entry of rows) {
        expect(Number.isFinite(entry.stressMPa)).toBe(true);
        expect(Number.isFinite(entry.ratio)).toBe(true);
        expect(entry.stressMPa).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('interior stations of a span loaded out of one plane', () => {
  it('an inclined span with a weight and a lateral force: the coarse model finds the maximum a 150 mm mesh finds (within 1 %)', () => {
    const maxStress = (maxElementLengthMm: number): number => {
      const { doc: pipes, id: pipeId } = withPipe(
        baseDoc(),
        [
          [0, 0, 3000],
          [6000, 0, 6000],
        ],
        DN100.odMm,
      );
      const { doc, id } = withModel(pipes, [pipeId], { maxElementLengthMm, frictionCoefficient: 0 });
      let d = anchorAt(conditioned(doc, id), id, pipeId, 0);
      d = apply(d, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: 6708.2 }, kind: 'translational', axis: 'z', oneWay: '+' });
      d = apply(d, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: 6708.2 }, kind: 'translational', axis: 'y' });
      d = cases(d, id, [{ name: 'S', type: 'SUS', basic: ['W', 'F1'] }], [{ name: 'F1', pipeId, atMm: 2500, forceN: [0, 900, 0] }]);
      const rows = analyzed(d, id, { include: ['stresses'] }).details?.stresses ?? [];
      return Math.max(...rows.map((entry) => entry.stressMPa));
    };
    expectRel(maxStress(100000), maxStress(150), 0.01, 'coarse vs fine maximum');
  });
});
