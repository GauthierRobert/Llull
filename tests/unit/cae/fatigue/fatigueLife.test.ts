import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { FAT_PLANS, expectedValue, relativeError, runPlanBefore, runPlanFile } from './support';

type Json = Record<string, unknown>;
const data = (result: { data?: unknown }): Json => (result.data ?? {}) as Json;
const code = (result: { error?: { code: string } }): string | undefined => result.error?.code;
let doc: CadDocument;
beforeAll(() => {
  doc = runPlanBefore(`${FAT_PLANS}/fat_notch_swt_s5.plan.json`, 'fatigue_life').document;
});

const stress = (extra: Json = {}): Json => ({
  method: 'stress_life',
  material: 'mat_test',
  modelId: 'sn1',
  amplitude: { value: 400, unit: 'MPa' },
  ...extra,
});

describe('fatigue_life (stress-life)', () => {
  it('VC-FAT-10: Basquin at 400 MPa gives 2Nf = 511231.09', () => {
    const result = execute(doc, 'fatigue_life', stress());
    expect(relativeError(data(result)['reversalsToFailure'] as number, expectedValue('07-fatigue', 'VC-FAT-10') as number)).toBeLessThan(
      1e-9,
    );
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('not approved');
    expect(data(result)).toMatchObject({ extrapolated: false, unverified: false, reviewRequired: true });
  });

  it('VC-FAT-15: a surface modifier 0.8 gives 2Nf = 32523.5', () => {
    const result = execute(
      doc,
      'fatigue_life',
      stress({ modifiers: [{ name: 'surface', value: 0.8, justification: 'machined surface' }] }),
    );
    expect(relativeError(data(result)['reversalsToFailure'] as number, expectedValue('07-fatigue', 'VC-FAT-15') as number)).toBeLessThan(
      1e-9,
    );
    expect(data(result)['modifierProduct']).toBe(0.8);
  });

  it('VC-FAT-61 ii: amplitude above Ftu is a static failure with no life', () => {
    const result = execute(doc, 'fatigue_life', stress({ amplitude: { value: 1500, unit: 'MPa' } }));
    expect(data(result)['cyclesToFailure']).toBeNull();
    expect((data(result)['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('FAT_STATIC_FAILURE');
    expect(result.summary).toContain('static failure');
  });

  it('VC-FAT-61 i: beyond the tested range is flagged FAT_CURVE_EXTRAPOLATED', () => {
    const result = execute(doc, 'fatigue_life', stress({ amplitude: { value: 100, unit: 'MPa' } }));
    expect(data(result)['extrapolated']).toBe(true);
    expect(relativeError(data(result)['reversalsToFailure'] as number, expectedValue('07-fatigue', 'VC-FAT-61') as number)).toBeLessThan(
      1e-9,
    );
    expect((data(result)['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('FAT_CURVE_EXTRAPOLATED');
  });

  it('mean-stress models use Ftu, Fty, sigma_f; SWT with a compressive peak gives no damage', () => {
    const goodman = data(execute(doc, 'fatigue_life', stress({ meanStress: 'goodman', mean: { value: 100, unit: 'MPa' } })));
    expect(relativeError(goodman['equivalentAmplitudeMPa'] as number, 400 / (1 - 100 / 1400))).toBeLessThan(1e-12);
    expect(execute(doc, 'fatigue_life', stress({ meanStress: 'gerber', mean: { value: 100, unit: 'MPa' } })).summary).toContain('cycles');
    expect(code(execute(doc, 'fatigue_life', stress({ meanStress: 'soderberg', mean: { value: 100, unit: 'MPa' } })))).toBe(
      'FAT_ALLOWABLE_MISSING',
    );
    expect(
      data(execute(doc, 'fatigue_life', stress({ meanStress: 'morrow', mean: { value: 100, unit: 'MPa' } })))['equivalentAmplitudeMPa'],
    ).toBeCloseTo(400 / (1 - 100 / 1160), 8);
    const none = data(
      execute(
        doc,
        'fatigue_life',
        stress({ meanStress: 'swt', amplitude: { value: 100, unit: 'MPa' }, mean: { value: -200, unit: 'MPa' } }),
      ),
    );
    expect(none['cyclesToFailure']).toBeNull();
    expect((none['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('FAT_SWT_NONPOSITIVE');
  });

  it('a notch without FE Kt scales the nominal stress by Kf; with feIncludesKt it does not', () => {
    const plain = data(execute(doc, 'fatigue_life', stress({ amplitude: { value: 200, unit: 'MPa' } })));
    const notched = data(
      execute(doc, 'fatigue_life', stress({ amplitude: { value: 200, unit: 'MPa' }, notch: { kt: 2, q: 1, feIncludesKt: false } })),
    );
    const included = data(
      execute(doc, 'fatigue_life', stress({ amplitude: { value: 200, unit: 'MPa' }, notch: { kt: 2, q: 1, feIncludesKt: true } })),
    );
    expect(notched['cyclesToFailure']).toBeLessThan(plain['cyclesToFailure'] as number);
    expect(included['cyclesToFailure']).toBe(plain['cyclesToFailure']);
  });

  it('refuses bad inputs with coded errors and no change', () => {
    expect(code(execute(doc, 'fatigue_life', stress({ modelId: 'zzz' })))).toBe('FAT_CURVE_MISSING');
    expect(code(execute(doc, 'fatigue_life', stress({ modelId: 'en1' })))).toBe('FAT_CURVE_UNSUPPORTED');
    expect(code(execute(doc, 'fatigue_life', stress({ amplitude: { value: 0, unit: 'MPa' } })))).toBe('FAT_PARAMS_INVALID');
    expect(code(execute(doc, 'fatigue_life', stress({ amplitude: { value: 5, unit: 'mm' } })))).toBe('FAT_PARAMS_INVALID');
    expect(code(execute(doc, 'fatigue_life', stress({ modifiers: [{ name: 'size', value: 0.9, justification: '' }] })))).toBe(
      'FAT_FACTOR_INVALID',
    );
    expect(code(execute(doc, 'fatigue_life', stress({ notch: { kt: 0.2, q: 2, feIncludesKt: false } })))).toBe('FAT_PARAMS_INVALID');
    expect(code(execute(doc, 'fatigue_life', stress({ amplitude: undefined })))).toBe('FAT_PARAMS_INVALID');
  });

  it('reads sn_power_law and sn_table models and an unverified basis', () => {
    let next = doc;
    for (const [id, model, basis] of [
      [
        'pl',
        { kind: 'sn_power_law', k: 5, nD: 1e6, sD: { value: 200, unit: 'MPa' }, conditions: { probability: 'mean', control: 'load' } },
        'company',
      ],
      [
        'tb',
        {
          kind: 'sn_table',
          families: [
            {
              points: [
                [1e4, 400],
                [1e6, 200],
              ],
              amplitudeUnit: 'MPa',
            },
          ],
          measure: 'amplitude',
          conditions: { probability: 'mean', control: 'load' },
        },
        'typical',
      ],
      [
        'tm',
        {
          kind: 'sn_table',
          families: [
            {
              points: [
                [1e4, 400],
                [1e6, 200],
              ],
              amplitudeUnit: 'MPa',
            },
          ],
          measure: 'max',
          conditions: { probability: 'mean', control: 'load' },
        },
        'company',
      ],
    ] as const)
      next = execute(next, 'add_material_model', { material: 'mat_test', id, model, basis, source: { citation: 'test' } }).document;
    const power = execute(next, 'fatigue_life', stress({ modelId: 'pl', amplitude: { value: 300, unit: 'MPa' } }));
    expect(relativeError(data(power)['cyclesToFailure'] as number, expectedValue('07-fatigue', 'VC-FAT-11') as number)).toBeLessThan(1e-9);
    const table = data(execute(next, 'fatigue_life', stress({ modelId: 'tb', amplitude: { value: 282.842712475, unit: 'MPa' } })));
    expect(table['cyclesToFailure']).toBeCloseTo(1e5, 0);
    expect(table['unverified']).toBe(true);
    expect((table['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('FAT_CURVE_UNVERIFIED');
    expect(code(execute(next, 'fatigue_life', stress({ modelId: 'tm' })))).toBe('FAT_CURVE_UNSUPPORTED');
  });
});

describe('fatigue_life (strain-life)', () => {
  const nominal = { amplitude: { value: 375, unit: 'MPa' }, mean: { value: 0, unit: 'MPa' } };
  const strain = (extra: Json = {}): Json => ({ method: 'strain_life', material: 'mat_test', modelId: 'en1', ...extra });

  it('VC-FAT-12: eps_a 0.0075 gives 2Nf = 4414.93', () => {
    const result = data(execute(doc, 'fatigue_life', strain({ strainAmplitude: 0.0075 })));
    expect(relativeError(result['reversalsToFailure'] as number, expectedValue('07-fatigue', 'VC-FAT-12') as number)).toBeLessThan(1e-9);
    expect(relativeError(result['transitionReversals'] as number, expectedValue('07-fatigue', 'VC-FAT-13') as number)).toBeLessThan(1e-9);
  });

  it('VC-FAT-21 / 22: the S5 notch example (Kt 2.41, q 0.9857) gives 506.73 MPa and 2919.91 cycles', () => {
    const plan = runPlanFile(`${FAT_PLANS}/fat_notch_swt_s5.plan.json`);
    const first = plan.steps.find((s) => s.command === 'fatigue_life')?.data ?? {};
    expect(relativeError(first['localStressMaxMPa'] as number, expectedValue('07-fatigue', 'VC-FAT-21') as number)).toBeLessThan(1e-9);
    expect(relativeError(first['cyclesToFailure'] as number, expectedValue('07-fatigue', 'VC-FAT-22') as number)).toBeLessThan(1e-6);
  });

  it('VC-FAT-14: Morrow with a 100 MPa mean at eps_a 0.005', () => {
    const result = data(
      execute(doc, 'fatigue_life', strain({ strainAmplitude: 0.005, mean: { value: 100, unit: 'MPa' }, meanStress: 'morrow' })),
    );
    expect(relativeError(result['reversalsToFailure'] as number, expectedValue('07-fatigue', 'VC-FAT-14') as number)).toBeLessThan(1e-9);
  });

  it('strain amplitude with SWT uses the cyclic curve; nominal input without a notch uses the elastic stress', () => {
    const swt = data(execute(doc, 'fatigue_life', strain({ strainAmplitude: 0.005, cyclicModelId: 'ro1', meanStress: 'swt' })));
    expect(swt['localStressMaxMPa']).toBeGreaterThan(0);
    const smooth = data(execute(doc, 'fatigue_life', strain({ nominal, cyclicModelId: 'ro1', meanStress: 'none' })));
    expect(smooth['equivalentAmplitudeMPa']).toBe(375);
    const compressive = data(
      execute(
        doc,
        'fatigue_life',
        strain({
          nominal: { amplitude: { value: 100, unit: 'MPa' }, mean: { value: -300, unit: 'MPa' } },
          cyclicModelId: 'ro1',
          meanStress: 'swt',
        }),
      ),
    );
    expect(compressive['cyclesToFailure']).toBeNull();
  });

  it('refuses unsupported or incomplete inputs', () => {
    expect(code(execute(doc, 'fatigue_life', strain({ strainAmplitude: 0.005, meanStress: 'goodman' })))).toBe(
      'FAT_MEAN_MODEL_UNSUPPORTED',
    );
    expect(code(execute(doc, 'fatigue_life', strain({ strainAmplitude: 0.005, meanStress: { walker: 0.5 } })))).toBe(
      'FAT_MEAN_MODEL_UNSUPPORTED',
    );
    expect(code(execute(doc, 'fatigue_life', strain({ strainAmplitude: -1 })))).toBe('FAT_PARAMS_INVALID');
    expect(code(execute(doc, 'fatigue_life', strain({ strainAmplitude: 0.005, meanStress: 'swt' })))).toBe('FAT_PARAMS_INVALID');
    expect(code(execute(doc, 'fatigue_life', strain({ nominal })))).toBe('FAT_PARAMS_INVALID');
    expect(code(execute(doc, 'fatigue_life', strain({})))).toBe('FAT_PARAMS_INVALID');
    expect(code(execute(doc, 'fatigue_life', strain({ nominal, cyclicModelId: 'zzz' })))).toBe('FAT_CURVE_MISSING');
    expect(code(execute(doc, 'fatigue_life', strain({ modelId: 'sn1', strainAmplitude: 0.005 })))).toBe('FAT_CURVE_UNSUPPORTED');
    expect(code(execute(doc, 'fatigue_life', strain({ strainAmplitude: 0.005, mean: { value: 1, unit: 'mm' } })))).toBe(
      'FAT_PARAMS_INVALID',
    );
  });
});
