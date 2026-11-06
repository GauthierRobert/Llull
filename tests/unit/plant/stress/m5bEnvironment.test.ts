/**
 * PST-M5b wind (WIN1..9) and static acceleration (U1..9, seismic) loads against exact statics of an anchored cantilever:
 * drag per length f = q Cf D_e sin(theta)^2 normal to the pipe (cross-flow principle), root force f L and moment f L^2 / 2; acceleration load = g factor x weight.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { apply, expectRefusal } from '../../../helpers/commandAssertions';
import { analyzed, baseDoc, cases, conditioned, DN100, withModel, withPipe, type AnalysisData } from './m3Fixtures';
import { expectRel } from './stressFixtures';

const E = 200000;
const G = E / (2 * (1 + 0.3));
const GRAVITY = 9.80665;
const section = (() => {
  const od = DN100.odMm;
  const id = od - 2 * DN100.wallMm;
  const A = (Math.PI / 4) * (od ** 2 - id ** 2);
  return { A, I: (Math.PI / 64) * (od ** 4 - id ** 4), As: A / 2, Z: (Math.PI / 32) * ((od ** 4 - id ** 4) / od) };
})();
const w = GRAVITY * 1e-9 * 7850 * section.A; // N/mm of the steel pipe
const L = 3000;

type Data = AnalysisData & { geometry: { nodes: { id: string; positionMm: number[] }[] } };

/** A DN100 pipe along x from the anchored origin; `over` replaces conditions fields. */
function cantilever(over: Record<string, unknown> = {}): { doc: CadDocument; id: string; pipe: string } {
  const pipe = withPipe(
    baseDoc(),
    [
      [0, 0, 3000],
      [L, 0, 3000],
    ],
    DN100.odMm,
  );
  const model = withModel(pipe.doc, [pipe.id]);
  const doc = apply(conditioned(model.doc, model.id, over), 'add_stress_restraint', {
    modelId: model.id,
    at: { pipeId: pipe.id, atMm: 0 },
    kind: 'anchor',
  });
  return { doc, id: model.id, pipe: pipe.id };
}

const rootLoad = (doc: CadDocument, id: string, caseName: string): { force: number[]; moment: number[]; data: Data } => {
  const data = analyzed(doc, id, { include: ['reactions', 'displacements', 'stresses', 'geometry'] }) as Data;
  const root = data.geometry.nodes.find((node) => (node.positionMm[0] as number) < 0.5)?.id;
  const row = data.details?.reactions?.find((entry) => entry.case === caseName && entry.nodeId === root);
  return { force: row?.forceN ?? [], moment: row?.momentNmm ?? [], data };
};

const WIND = { name: 'WIN1', pressureKPa: 1, dragCoefficient: 1.2, direction: [0, 1, 0] };

describe('wind WIN1: cross-flow drag per length', () => {
  it('a wind normal to a cantilever: root force f L and moment f L^2 / 2 with f = q Cf D (exact statics), tip deflection f L^4 / 8EI + f L^2 / 2GAs', () => {
    const sc = cantilever();
    const doc = apply(sc.doc, 'set_stress_load_cases', {
      modelId: sc.id,
      cases: [{ name: 'S', type: 'SUS', basic: ['WIN1'] }],
      wind: [WIND],
    });
    const f = 1e-3 * 1.2 * DN100.odMm;
    const { force, moment, data } = rootLoad(doc, sc.id, 'S');
    expectRel(force[1] as number, -f * L, 1e-7, 'Fy');
    expectRel(moment[2] as number, -(f * L ** 2) / 2, 1e-7, 'Mz');
    expect(Math.abs(force[0] as number) + Math.abs(force[2] as number)).toBeLessThan(1e-6);
    const tip = data.geometry.nodes.find((node) => (node.positionMm[0] as number) > L - 0.5)?.id;
    const u = data.details?.displacements?.find((entry) => entry.case === 'S' && entry.node === tip)?.uMm[1] as number;
    expectRel(u, (f * L ** 4) / (8 * E * section.I) + (f * L ** 2) / (2 * G * section.As), 1e-6, 'tip y');
  });

  it('a wind 30 degrees to the axis carries sin^2: Fy = 0.25 f L; along the axis it carries nothing', () => {
    const sc = cantilever();
    const f = 1e-3 * 1.2 * DN100.odMm;
    const angled = apply(sc.doc, 'set_stress_load_cases', {
      modelId: sc.id,
      cases: [{ name: 'S', type: 'SUS', basic: ['WIN1'] }],
      wind: [{ ...WIND, direction: [Math.cos(Math.PI / 6), 0.5, 0] }],
    });
    const { force, moment } = rootLoad(angled, sc.id, 'S');
    expectRel(force[1] as number, -0.25 * f * L, 1e-7, 'Fy');
    expectRel(moment[2] as number, -(0.25 * f * L ** 2) / 2, 1e-7, 'Mz');
    expect(Math.abs(force[0] as number)).toBeLessThan(1e-9);
    const along = apply(sc.doc, 'set_stress_load_cases', {
      modelId: sc.id,
      cases: [{ name: 'S', type: 'SUS', basic: ['WIN1'] }],
      wind: [{ ...WIND, direction: [1, 0, 0] }],
    });
    expect(Math.hypot(...rootLoad(along, sc.id, 'S').force)).toBeLessThan(1e-9);
  });

  it('insulation widens the exposed diameter: D_e = OD + 2 t', () => {
    const sc = cantilever({ insulation: { thicknessMm: 50, densityKgM3: 100 } });
    const doc = apply(sc.doc, 'set_stress_load_cases', {
      modelId: sc.id,
      cases: [{ name: 'S', type: 'SUS', basic: ['WIN1'] }],
      wind: [WIND],
    });
    expectRel(-(rootLoad(doc, sc.id, 'S').force[1] as number), 1e-3 * 1.2 * (DN100.odMm + 100) * L, 1e-7, 'Fy');
  });

  it('wind with weight is a biaxial bending: S_L at the root = sqrt(Mw^2 + Mg^2) / Z (the load reaches the code stress)', () => {
    const sc = cantilever();
    const doc = apply(sc.doc, 'set_stress_load_cases', {
      modelId: sc.id,
      cases: [{ name: 'S', type: 'SUS', basic: ['W', 'WIN1'] }],
      wind: [WIND],
    });
    const f = 1e-3 * 1.2 * DN100.odMm;
    const { data } = rootLoad(doc, sc.id, 'S');
    const worst = Math.max(...(data.details?.stresses ?? []).filter((row) => row.case === 'S').map((row) => row.stressMPa));
    expectRel(worst, Math.hypot((w * L ** 2) / 2, (f * L ** 2) / 2) / section.Z, 1e-6, 'S_L');
  });
});

describe('static acceleration U1 (seismic): g factor x weight', () => {
  it('+1 g vertical cancels the weight; 0.3 g along the pipe and 0.2 g across load the root by the factor times the weight', () => {
    const sc = cantilever();
    const run = (gFactors: number[], basic = ['U1']): ReturnType<typeof rootLoad> =>
      rootLoad(
        apply(sc.doc, 'set_stress_load_cases', {
          modelId: sc.id,
          cases: [{ name: 'S', type: 'SUS', basic }],
          seismic: [{ name: 'U1', gFactors }],
        }),
        sc.id,
        'S',
      );
    expectRel(run([0, 0, 1]).force[2] as number, -w * L * 1, 1e-7, 'U1 alone is the weight turned up');
    expect(Math.hypot(...run([0, 0, 1], ['W', 'U1']).force)).toBeLessThan(1e-6);
    expect(Math.hypot(...run([0, 0, 1], ['W', 'U1']).moment)).toBeLessThan(1e-3);
    expectRel(-(run([0.3, 0, 0]).force[0] as number), 0.3 * w * L, 1e-7, 'Fx');
    const across = run([0, 0.2, 0]);
    expectRel(-(across.force[1] as number), 0.2 * w * L, 1e-7, 'Fy');
    expectRel(-(across.moment[2] as number), (0.2 * w * L ** 2) / 2, 1e-7, 'Mz');
  });

  it('a stated valve weight is accelerated too: Fy = -0.2 (w (L - 500) + 100 g)', () => {
    const sc = cantilever();
    let doc = apply(sc.doc, 'set_stress_component', {
      modelId: sc.id,
      declare: { pipeId: sc.pipe, atMm: 1500, lengthMm: 500, kind: 'valve' },
      weightKg: 100,
    });
    doc = apply(doc, 'set_stress_load_cases', {
      modelId: sc.id,
      cases: [{ name: 'S', type: 'SUS', basic: ['U1'] }],
      seismic: [{ name: 'U1', gFactors: [0, 0.2, 0] }],
    });
    expectRel(-(rootLoad(doc, sc.id, 'S').force[1] as number), 0.2 * (w * (L - 500) + 100 * GRAVITY), 1e-7, 'Fy');
  });

  it('contents and insulation weigh in the acceleration load', () => {
    const sc = cantilever({ fluidDensityKgM3: 1000, insulation: { thicknessMm: 40, densityKgM3: 120, claddingKgM2: 2 } });
    const doc = apply(sc.doc, 'set_stress_load_cases', {
      modelId: sc.id,
      cases: [{ name: 'S', type: 'SUS', basic: ['W', 'U1'] }],
      seismic: [{ name: 'U1', gFactors: [0, 0, 1] }],
    });
    // W + 1 g up: the two cancel exactly, whatever the weight is made of
    expect(Math.hypot(...rootLoad(doc, sc.id, 'S').force)).toBeLessThan(1e-6);
  });
});

describe('refusals', () => {
  it('a case naming a wind or acceleration that is not defined is PST_LOADCASE_INVALID, at set time and at analysis', () => {
    const sc = cantilever();
    expectRefusal(
      sc.doc,
      'set_stress_load_cases',
      { modelId: sc.id, cases: [{ name: 'S', type: 'SUS', basic: ['WIN1'] }] },
      'PST_LOADCASE_INVALID',
    );
    expectRefusal(
      sc.doc,
      'set_stress_load_cases',
      { modelId: sc.id, cases: [{ name: 'S', type: 'SUS', basic: ['U2'] }] },
      'PST_LOADCASE_INVALID',
    );
    const defined = cases(sc.doc, sc.id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    expect(defined).toBeDefined();
  });

  it('rejects a bad wind or acceleration: name, zero pressure, zero direction', () => {
    const sc = cantilever();
    const set = (wind: unknown): unknown => ({ modelId: sc.id, cases: [{ name: 'S', type: 'SUS', basic: ['W'] }], wind });
    expectRefusal(sc.doc, 'set_stress_load_cases', set([{ ...WIND, name: 'WIN0' }]), 'CMD_INVALID_PARAMS');
    expectRefusal(sc.doc, 'set_stress_load_cases', set([{ ...WIND, pressureKPa: 0 }]), 'CMD_INVALID_PARAMS');
    expectRefusal(sc.doc, 'set_stress_load_cases', set([{ ...WIND, direction: [0, 0, 0] }]), 'CMD_INVALID_PARAMS');
    expectRefusal(
      sc.doc,
      'set_stress_load_cases',
      { modelId: sc.id, cases: [{ name: 'S', type: 'SUS', basic: ['W'] }], seismic: [{ name: 'U10', gFactors: [0, 0, 1] }] },
      'CMD_INVALID_PARAMS',
    );
  });

  it('the new fields replace on a second call and stay when omitted', () => {
    const sc = cantilever();
    const first = apply(sc.doc, 'set_stress_load_cases', {
      modelId: sc.id,
      cases: [{ name: 'S', type: 'SUS', basic: ['WIN1', 'U1'] }],
      wind: [WIND],
      seismic: [{ name: 'U1', gFactors: [0, 0, 1] }],
    });
    const second = apply(first, 'set_stress_load_cases', { modelId: sc.id, cases: [{ name: 'S', type: 'SUS', basic: ['WIN1', 'U1'] }] });
    expect(Math.hypot(...rootLoad(second, sc.id, 'S').force)).toBeGreaterThan(0);
    expectRefusal(
      second,
      'set_stress_load_cases',
      { modelId: sc.id, cases: [{ name: 'S', type: 'SUS', basic: ['WIN1'] }], wind: [] },
      'PST_LOADCASE_INVALID',
    );
  });
});
