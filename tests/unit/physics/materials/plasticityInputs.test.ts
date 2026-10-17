/** Plasticity inputs of add_material_model (VC-MATL-15): modulus kind, curve measure, curve conversions and validation. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { GPa, MPa, NL1_ELASTIC, SOURCE, addModel, codeOf, run, withMaterial } from './materialFixtures';

const base = (): CadDocument => withMaterial(createEmptyDocument(), 'steel');
const add = (doc: CadDocument, model: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  codeOf(doc, 'add_material_model', { material: 'steel', id: 'm', model, basis: 'typical', source: SOURCE, ...extra });

describe('plasticity inputs (VC-MATL-15)', () => {
  const doc = addModel(base(), 'steel', 'elastic', NL1_ELASTIC);
  const j2 = (isotropic: Record<string, unknown>, kinematic: Record<string, unknown> = { kind: 'none' }): Record<string, unknown> => ({
    kind: 'j2_plasticity',
    isotropic,
    kinematic,
  });
  const measure = { stress: 'true', strain: 'plastic', strainKind: 'true' };
  const multilinear = (points: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'multilinear',
    stressUnit: 'MPa',
    inputMeasure: measure,
    curves: [{ points }],
    ...extra,
  });

  it('requires the hardening modulus kind and the curve measure', () => {
    expect(add(doc, j2({ kind: 'linear', yieldStress: MPa(5), modulus: GPa(62.5) }))).toBe('MATL_HARDENING_MODULUS_KIND_MISSING');
    expect(
      add(
        doc,
        j2({
          kind: 'multilinear',
          stressUnit: 'MPa',
          curves: [
            {
              points: [
                [5, 0],
                [6, 0.1],
              ],
            },
          ],
        }),
      ),
    ).toBe('MATL_CURVE_MEASURE_MISSING');
    const result = execute(doc, 'add_material_model', {
      material: 'steel',
      id: 'x',
      model: j2({ kind: 'linear', yieldStress: MPa(5), modulus: GPa(62.5) }),
      basis: 'A',
      source: SOURCE,
    });
    expect(result.error).toMatchObject({ code: 'MATL_HARDENING_MODULUS_KIND_MISSING', paths: ['model.isotropic.modulusKind'] });
    expect(result.error?.remediation).toContain('plastic');
    expect(add(doc, j2({ kind: 'linear', yieldStress: MPa(5), modulus: GPa(62.5), modulusKind: 'tangent' }))).toBe('accepted');
  });

  it('validates hardening curves', () => {
    expect(
      add(
        doc,
        j2(
          multilinear([
            [5, 0],
            [6, 0.1],
          ]),
        ),
      ),
    ).toBe('accepted');
    expect(
      add(
        doc,
        j2(
          multilinear([
            [5, 0.01],
            [6, 0.1],
          ]),
        ),
      ),
    ).toBe('MATL_HARDENING_CURVE_INVALID');
    expect(
      add(
        doc,
        j2(
          multilinear([
            [5, 0],
            [6, 0],
          ]),
        ),
      ),
    ).toBe('MATL_HARDENING_CURVE_INVALID');
    expect(add(doc, j2(multilinear([[5, 0]])))).toBe('MATL_HARDENING_CURVE_INVALID');
    expect(
      add(
        doc,
        j2(
          multilinear([
            [-5, 0],
            [6, 0.1],
          ]),
        ),
      ),
    ).toBe('MATL_HARDENING_CURVE_INVALID');
    expect(add(doc, j2({ kind: 'multilinear', stressUnit: 'MPa', inputMeasure: measure, curves: [] }))).toBe(
      'MATL_HARDENING_CURVE_INVALID',
    );
    expect(
      add(
        doc,
        j2(
          multilinear(
            [
              [5, 0],
              [6, 0.1],
            ],
            { stressUnit: 'K' },
          ),
        ),
      ),
    ).toBe('MATL_LAW_PARAMS_INVALID');
    const softening = run(doc, 'add_material_model', {
      material: 'steel',
      id: 's',
      model: j2(
        multilinear([
          [5, 0],
          [6, 0.1],
          [5.5, 0.2],
        ]),
      ),
      basis: 'A',
      source: SOURCE,
    });
    expect((softening.data as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual(['MATL_HARDENING_SOFTENING']);
    const two = {
      kind: 'multilinear',
      stressUnit: 'MPa',
      inputMeasure: measure,
      curves: [
        {
          temperature: { value: 300, unit: 'K' },
          points: [
            [5, 0],
            [6, 0.1],
          ],
        },
        {
          temperature: { value: 200, unit: 'K' },
          points: [
            [6, 0],
            [7, 0.1],
          ],
        },
      ],
    };
    expect(add(doc, j2(two))).toBe('MATL_HARDENING_CURVE_INVALID');
    expect(
      add(
        doc,
        j2({
          ...two,
          curves: [
            {
              points: [
                [5, 0],
                [6, 0.1],
              ],
            },
            {
              points: [
                [6, 0],
                [7, 0.1],
              ],
            },
          ],
        }),
      ),
    ).toBe('MATL_HARDENING_CURVE_INVALID');
    expect(
      add(
        doc,
        j2({
          ...two,
          curves: [
            {
              temperature: { value: 200, unit: 'K' },
              points: [
                [5, 0],
                [6, 0.1],
              ],
            },
            {
              temperature: { value: 300, unit: 'K' },
              points: [
                [4, 0],
                [5, 0.1],
              ],
            },
          ],
        }),
      ),
    ).toBe('accepted');
  });

  it('converts engineering and total-strain curves to true stress vs plastic strain and records it', () => {
    const E = 200000;
    const engineering = { stress: 'engineering', strain: 'total', strainKind: 'engineering', youngModulus: GPa(200) };
    const points = [
      [400, 400 / E],
      [440, 0.05],
      [460, 0.1],
    ];
    const added = run(doc, 'add_material_model', {
      material: 'steel',
      id: 'curve',
      model: j2({ kind: 'multilinear', stressUnit: 'MPa', inputMeasure: engineering, curves: [{ points }] }),
      basis: 'typical',
      source: SOURCE,
    });
    const stored = added.document.materials['steel']?.materialModels?.find((m) => m.id === 'curve');
    const law = stored?.model;
    if (law?.kind !== 'j2_plasticity' || law.isotropic.kind !== 'multilinear') throw new Error('not multilinear');
    const curve = law.isotropic.curves[0]?.points ?? [];
    expect(curve[0]).toEqual([400 * (1 + 400 / E), 0]);
    const trueStress = 440 * 1.05;
    expect(curve[1]?.[0]).toBeCloseTo(trueStress, 9);
    expect(curve[1]?.[1]).toBeCloseTo(Math.log(1.05) - trueStress / E - (Math.log(1 + 400 / E) - (400 * (1 + 400 / E)) / E), 12);
    expect(stored?.conversion?.note).toContain('σ_t = σ_e (1 + ε_e)');
    expect(stored?.conversion?.note).toContain('first point shifted');
    const trueTotal = { stress: 'true', strain: 'total', strainKind: 'true', youngModulus: GPa(200) };
    const second = run(doc, 'add_material_model', {
      material: 'steel',
      id: 'c2',
      model: j2({
        kind: 'multilinear',
        stressUnit: 'MPa',
        inputMeasure: trueTotal,
        curves: [
          {
            points: [
              [400, 0.002],
              [450, 0.01],
            ],
          },
        ],
      }),
      basis: 'typical',
      source: SOURCE,
    });
    const secondLaw = second.document.materials['steel']?.materialModels?.find((m) => m.id === 'c2')?.model;
    if (secondLaw?.kind !== 'j2_plasticity' || secondLaw.isotropic.kind !== 'multilinear') throw new Error('not multilinear');
    expect(secondLaw.isotropic.curves[0]?.points[1]?.[1]).toBeCloseTo(0.01 - 450 / E - (0.002 - 400 / E), 12);
    const engineeringTrueStrain = { stress: 'engineering', strain: 'plastic', strainKind: 'true' };
    const third = run(doc, 'add_material_model', {
      material: 'steel',
      id: 'c3',
      model: j2({
        kind: 'multilinear',
        stressUnit: 'MPa',
        inputMeasure: engineeringTrueStrain,
        curves: [
          {
            points: [
              [400, 0],
              [440, 0.1],
            ],
          },
        ],
      }),
      basis: 'typical',
      source: SOURCE,
    });
    const thirdLaw = third.document.materials['steel']?.materialModels?.find((m) => m.id === 'c3')?.model;
    if (thirdLaw?.kind !== 'j2_plasticity' || thirdLaw.isotropic.kind !== 'multilinear') throw new Error('not multilinear');
    expect(thirdLaw.isotropic.curves[0]?.points[1]?.[0]).toBeCloseTo(440 * Math.exp(0.1), 9);
    expect(
      add(
        doc,
        j2({
          kind: 'multilinear',
          stressUnit: 'MPa',
          inputMeasure: { stress: 'true', strain: 'total', strainKind: 'true' },
          curves: [{ points }],
        }),
      ),
    ).toBe('MATL_CURVE_MEASURE_MISSING');
    expect(
      add(
        doc,
        j2({
          kind: 'multilinear',
          stressUnit: 'MPa',
          inputMeasure: { ...trueTotal, youngModulus: { value: 1, unit: 'K' } },
          curves: [{ points }],
        }),
      ),
    ).toBe('MATL_LAW_PARAMS_INVALID');
  });

  it('validates Voce, Johnson-Cook and kinematic parameters', () => {
    expect(add(doc, j2({ kind: 'voce', yieldStress: MPa(200), Q: MPa(100), b: 20 }))).toBe('accepted');
    expect(add(doc, j2({ kind: 'voce', yieldStress: MPa(200), Q: MPa(100), b: 0 }))).toBe('MATL_LAW_PARAMS_INVALID');
    const jc = {
      kind: 'johnson_cook',
      A: MPa(500),
      B: MPa(300),
      n: 0.3,
      m: 1,
      meltTemperature: { value: 1800, unit: 'K' },
      transitionTemperature: { value: 293, unit: 'K' },
    };
    expect(add(doc, j2(jc))).toBe('accepted');
    expect(add(doc, j2({ ...jc, meltTemperature: { value: 200, unit: 'K' } }))).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(doc, j2({ ...jc, A: MPa(0) }))).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(doc, j2({ kind: 'perfect', yieldStress: MPa(0) }))).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(doc, j2({ kind: 'perfect', yieldStress: MPa(5) }, { kind: 'linear', C: MPa(0) }))).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(doc, j2({ kind: 'perfect', yieldStress: MPa(5) }, { kind: 'chaboche', backstresses: [] }))).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(doc, j2({ kind: 'perfect', yieldStress: MPa(5) }, { kind: 'chaboche', backstresses: [{ C: MPa(1), gamma: -1 }] }))).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
    expect(add(doc, j2({ kind: 'perfect', yieldStress: MPa(5) }, { kind: 'chaboche', backstresses: [{ C: MPa(10), gamma: 5 }] }))).toBe(
      'accepted',
    );
    expect(add(doc, { kind: 'rate_johnson_cook', C: -1, referenceRate: { value: 1, unit: '1/s' } })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(doc, { kind: 'rate_johnson_cook', C: 0.01, referenceRate: { value: 1, unit: 'MPa' } })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(doc, { kind: 'rate_cowper_symonds', D: { value: 40, unit: '1/s' }, q: 0 })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(doc, { kind: 'rate_cowper_symonds', D: { value: 40, unit: '1/s' }, q: 5 })).toBe('accepted');
  });
});
