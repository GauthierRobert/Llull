/** materialProperty binding (PHY-01 -> PHY-18, TR-PRB-10, VC-PRB-17): scatter derived from a property model's uncertainty band. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { reliabilityErrors } from '@cae/reliability/model';
import { code, data, type Json } from './support';
import { boxDoc } from './responses.support';

const Z975 = 1.959963984540054;
const Z95 = 1.6448536269514722;

function materialWith(uncertainty: Json | undefined, extra: Json = {}): CadDocument {
  let doc = execute(createEmptyDocument(), 'create_material', {
    name: 'al',
    density: 0.0027,
    color: '#b0b0b0',
    metalness: 1,
    roughness: 0.4,
  }).document;
  doc = execute(doc, 'define_property_model', {
    material: 'al',
    model: {
      id: 'e_al',
      property: 'E',
      unit: 'MPa',
      variables: [],
      form: { kind: 'constant', value: 70000 },
      validity: [],
      basis: 'typical',
      ...(uncertainty === undefined ? {} : { uncertainty }),
      source: { citation: 'test handbook', locator: 'table 1' },
      ...extra,
    },
  }).document;
  return doc;
}
const statistical = { kind: 'statistical', relative: 0.05, coverage: 0.95, provenance: { citation: 'test report' } };
const bind = (doc: CadDocument, extra: Json = {}, binding: Json = {}): ReturnType<typeof execute> =>
  execute(doc, 'define_random_variable', {
    name: 'E',
    unit: 'MPa',
    binding: { kind: 'materialProperty', material: 'al', property: 'E', ...binding },
    ...extra,
  });

describe('materialProperty binding', () => {
  it('derives normal(y, h / Phi^-1((1 + c) / 2)) from a statistical band with coverage (VC-PRB-17)', () => {
    const doc = materialWith(statistical);
    const result = bind(doc);
    expect(code(result)).toBeUndefined();
    const variable = result.document.probabilistic?.variables['E'];
    expect(variable?.distribution).toMatchObject({ kind: 'normal', mean: 70000 });
    const sd = (variable?.distribution as { sd: number }).sd;
    expect(Math.abs(sd / (3500 / Z975) - 1)).toBeLessThan(1e-9);
    expect(variable?.derivedFrom).toMatchObject({
      modelId: 'e_al',
      uncertaintyKind: 'statistical',
      coverage: 0.95,
      value: 70000,
      halfWidth: 3500,
    });
    expect(variable?.citation?.text).toContain('PHY-01 property model e_al');
    expect(result.summary).toContain('derived from the property model band');
    expect(result.document.probabilistic?.variables['E']?.binding).toMatchObject({
      kind: 'materialProperty',
      material: 'al',
      property: 'E',
    });
  });

  it('lognormal on request keeps the mean and sd; a measurement band needs the binding coverage', () => {
    const doc = materialWith(statistical);
    const lognormal = bind(doc, { distributionShape: 'lognormal' }).document.probabilistic?.variables['E']?.distribution;
    expect(lognormal).toMatchObject({ kind: 'lognormal', mean: 70000 });
    const measured = materialWith({ kind: 'measurement', relative: 0.05, provenance: { citation: 'calibration certificate' } });
    expect(code(bind(measured))).toBe('PRB_SCATTER_KIND_UNSUITABLE');
    const ok = bind(measured, {}, { measurementCoverage: 0.9 }).document.probabilistic?.variables['E']?.distribution as { sd: number };
    expect(Math.abs(ok.sd / (3500 / Z95) - 1)).toBeLessThan(1e-9);
  });

  it('refuses a fit-error band, a missing band or coverage, an unresolvable binding, leaving the document unchanged', () => {
    const refused = (doc: CadDocument, extra: Json = {}, binding: Json = {}): string | undefined => {
      const result = bind(doc, extra, binding);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      return code(result);
    };
    expect(refused(materialWith({ kind: 'fitErrorVsData', relative: 0.02, provenance: { citation: 'fit' } }))).toBe(
      'PRB_SCATTER_KIND_UNSUITABLE',
    );
    expect(refused(materialWith(undefined))).toBe('PRB_SCATTER_KIND_UNSUITABLE');
    expect(refused(materialWith({ kind: 'statistical', relative: 0.05, provenance: { citation: 'x' } }))).toBe(
      'PRB_SCATTER_KIND_UNSUITABLE',
    );
    expect(refused(materialWith(statistical), {}, { material: 'nope' })).toBe('PRB_BINDING_UNRESOLVED');
    expect(refused(materialWith(statistical), {}, { property: 'k' })).toBe('PRB_BINDING_UNRESOLVED');
    expect(refused(materialWith({ ...statistical, relative: 0 }))).toBe('PRB_DISTRIBUTION_INVALID');
    expect(refused(createEmptyDocument(), { binding: { kind: 'free' } })).toBe('PRB_PARAMS_INVALID');
  });

  it('a caller distribution with the binding is accepted without derivation (unsourced unless cited); the model unverified flag is inherited', () => {
    const doc = materialWith(statistical);
    const own = bind(doc, { distribution: { kind: 'normal', mean: 69000, sd: 1000 } });
    expect(own.document.probabilistic?.variables['E']?.derivedFrom).toBeUndefined();
    expect(own.document.probabilistic?.variables['E']?.citation).toBeUndefined();
    const limit = execute(bind(doc).document, 'define_limit_state', { name: 'g', expression: 'E - 68000', unit: 'MPa' }).document;
    const form = data(execute(limit, 'run_reliability_study', { limitState: 'g', methods: ['form'] }));
    const study = form['form'] as Json;
    expect(study['unverified']).toBe(true);
    expect((study['unverifiedReasons'] as string[]).join(' ')).toContain('E:');
    expect(Math.abs((((form['form'] as Json | undefined) ?? form)['beta'] as number) - 2000 / (3500 / Z975))).toBeLessThan(1e-6);
  });

  it('replaying the history re-derives the identical distribution', () => {
    const bound = bind(materialWith(statistical)).document;
    const replayed = execute(bound, 'replay_history', {}).document;
    expect(replayed.probabilistic?.variables['E']).toEqual(bound.probabilistic?.variables['E']);
  });

  it('its slice validation rejects a malformed material binding or derivedFrom', () => {
    const bound = bind(materialWith(statistical)).document;
    const slice = bound.probabilistic as unknown as { variables: Record<string, Json> };
    const variable = slice.variables['E'] ?? {};
    const withVariable = (patch: Json): string[] =>
      reliabilityErrors({ probabilistic: { ...slice, variables: { E: { ...variable, ...patch } } } });
    expect(withVariable({})).toEqual([]);
    expect(withVariable({ binding: { kind: 'materialProperty', material: 'al' } })).toHaveLength(1);
    expect(withVariable({ derivedFrom: { modelId: 3 } })).toHaveLength(1);
  });

  it('a density binding drives a geometry-backed response: mass scales with the sampled density (sd 0.8 g for 3.7 % density scatter)', () => {
    const { doc, boxId } = boxDoc();
    let model = execute(doc, 'define_response', {
      name: 'mass',
      unit: 'g',
      query: { command: 'mass_properties', params: { entityId: boxId }, pointer: '/data/mass' },
    }).document;
    model = execute(model, 'define_random_variable', {
      name: 'rho',
      unit: 'g/mm^3',
      binding: { kind: 'materialProperty', material: 'test_al', property: 'density' },
      distribution: { kind: 'normal', mean: 0.0027, sd: 0.0001 },
      citation: { text: 'supplier certificate' },
    }).document;
    model = execute(model, 'define_limit_state', { name: 'budget', expression: '22 - mass', unit: 'g' }).document;
    const before = JSON.stringify(model);
    const propagated = execute(model, 'propagate_uncertainty', { method: 'lhs', samples: 600, seed: 5 });
    expect(JSON.stringify(model)).toBe(before);
    const g = ((data(propagated)['limitStates'] as Record<string, Json>)['budget'] as Json)['g'] as { mean: number; sd: number };
    expect(Math.abs(g.mean - 0.4)).toBeLessThan(0.1);
    expect(Math.abs(g.sd / 0.8 - 1)).toBeLessThan(0.05);
    const indices = data(execute(model, 'sensitivity_indices', { response: 'mass', samples: 512, seed: 2, bootstrap: 0 }));
    expect(Object.keys(indices['S'] as Json)).toEqual(['rho']);
    expect((indices['S'] as Record<string, { value: number }>)['rho']?.value).toBeGreaterThan(0.95);
  });
});
