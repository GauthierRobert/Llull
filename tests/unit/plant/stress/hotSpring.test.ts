/**
 * PST-FU2: `select_spring_hangers` with the model's hot modulus. The L-frame of m5bSprings (riser 4000, leg 6000, DN100, tip hanger): the travel of a
 * hanger point under its own hot load is the free thermal growth eps H (E drops out), so the design is unchanged by E(T) and the operating load stays
 * P_hot; the data reports E at the case temperature (linear in the fixture rows: 190 - 5 x 21.1 / 50 GPa at 221.1 degC) and the table limit still refuses.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';
import { baseDoc, cases, conditioned, DN100, withModel, withPipe } from './m3Fixtures';
import { E_ROWS, withEModulus } from './nozzleFixtures';
import { expectRel } from './stressFixtures';

const H = 4000;
const L = 6000;
const ALPHA = 1.2e-5;

function scene(rows: unknown[]): { doc: CadDocument; id: string; pipe: string } {
  const pipe = withPipe(
    withEModulus(baseDoc(), rows),
    [
      [0, 0, 0],
      [0, 0, H],
      [L, 0, H],
    ],
    DN100.odMm,
  );
  const model = withModel(pipe.doc, [pipe.id]);
  let doc = conditioned(model.doc, model.id, { temperatures: [{ name: 'T1', tempC: 221.1 }] }, { thermal: { meanCtePerK: ALPHA } });
  doc = apply(doc, 'add_stress_restraint', { modelId: model.id, at: { pipeId: pipe.id, atMm: 0 }, kind: 'anchor' });
  doc = cases(doc, model.id, [
    { name: 'SUS', type: 'SUS', basic: ['W'] },
    { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
  ]);
  doc = apply(doc, 'import_spring_table', {
    modelId: model.id,
    tableId: 'T',
    source: 'test catalogue 2026',
    sizes: [{ size: 'S3', series: 'A', minN: 300, maxN: 600, rateNPerMm: 5, travelMm: 25 }],
  });
  return { doc, id: model.id, pipe: pipe.id };
}

const run = (s: { doc: CadDocument; id: string; pipe: string }): ReturnType<typeof execute> =>
  execute(s.doc, 'select_spring_hangers', { modelId: s.id, hangers: [{ pipeId: s.pipe, atMm: H + L }], tableId: 'T' });

describe('select_spring_hangers with hotModulus', () => {
  const rows = [...E_ROWS, { tempC: 250, ShMPa: 138, EGPa: 185, meanCtePerK: 1.2e-5 }];

  it('reports E(T), keeps the thermal travel eps H and a zero operating error', () => {
    const s = scene(rows);
    const stated = run(s);
    expect((stated.data as { hotModulusMPa: number | null }).hotModulusMPa).toBeNull();
    const doc = apply(s.doc, 'set_hot_modulus', { modelId: s.id, materialId: 'FIX' });
    const hot = run({ ...s, doc });
    expect(hot.rejected).toBeUndefined();
    const data = hot.data as { hotModulusMPa: number; springs: { travelUpMm: number; hotLoadN: number; residualPct: number }[] };
    expect(data.hotModulusMPa).toBeCloseTo(187890, 3);
    const [spring] = data.springs as [(typeof data.springs)[number]];
    expectRel(spring.travelUpMm, ALPHA * (221.1 - 21.1) * H, 1e-6, 'travel eps H');
    expectRel(spring.hotLoadN, (stated.data as { springs: { hotLoadN: number }[] }).springs[0]?.hotLoadN as number, 1e-9, 'hot load');
    expect(Math.abs(spring.residualPct)).toBeLessThan(1e-5);
  });

  it('refuses a case temperature outside the E table, never extrapolating; no E data is refused too', () => {
    const s = scene(E_ROWS);
    const doc = apply(s.doc, 'set_hot_modulus', { modelId: s.id, materialId: 'FIX' });
    const out = run({ ...s, doc });
    expect(out.rejected).toBeDefined();
    expect(out.summary).toContain('PST_TEMPERATURE_OUT_OF_TABLE');
    expect(out.document).toBe(doc);
    expect(out.affected).toEqual([]);
  });
});
