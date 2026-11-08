/** Mode k's .frd set (results/modeSets): negative buckling factors keep their place, so render_fea_results / fea_result_field mode N is mode N. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { modeSet, modeSets } from '@cae/results/modeSets';
import { imperfectBar } from './nonlinear/imperfectionFixtures';

describe('buckling mode sets with a negative factor [-3.2, 4.5, 9.1]', () => {
  const bar = imperfectBar(true, [-3.2, 4.5, 9.1]);

  it('fea_result_field mode 2 reads the 4.5 set (mode shape uz = -x y), mode 1 the -3.2 one', () => {
    const second = execute(bar.doc, 'fea_result_field', { analysisId: bar.bucklingId, field: 'u_z', mode: 2 }, bar.ctx);
    expect(second.error, second.summary).toBeUndefined();
    const data = second.data as { resultSet: string };
    expect(data.resultSet).toBe('mode 2, buckling factor 4.5');
    const first = execute(bar.doc, 'fea_result_field', { analysisId: bar.bucklingId, field: 'u_y', mode: 1 }, bar.ctx);
    expect((first.data as { resultSet: string }).resultSet).toBe('mode 1, buckling factor -3.2');
    const missing = execute(bar.doc, 'fea_result_field', { analysisId: bar.bucklingId, field: 'u_z', mode: 4 }, bar.ctx);
    expect(missing.error?.code).toBe('FEA_RESULTS_MISSING');
    expect(missing.summary).toContain('the results hold 3 mode(s), not mode 4');
  });

  it('keeps negative sets, drops the zero-time reference set, and checks a known factor (1e-5, the .dat 7-digit print)', () => {
    const reference = { step: 1, time: 0, fields: {} };
    const results = { ...bar.bucklingResults, steps: [reference, ...bar.bucklingResults.steps] };
    expect(modeSets(results, 'buckling').map((set) => set.time)).toEqual([-3.2, 4.5, 9.1]);
    expect(modeSets(results, 'modal')).toHaveLength(4);
    expect(modeSet(results, 'buckling', 2, 4.50002)).toMatchObject({ set: { time: 4.5 }, count: 3 });
    expect(modeSet(results, 'buckling', 2, 9.1)).toContain('the mode order does not match');
  });
});
