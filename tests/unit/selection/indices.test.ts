import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { exponentValue, indexUnit, INDEX_RULES } from '@cae/selection/indexRules';
import { INDEX_CASES } from '@cae/selection/types';
import { dataOf, expectedCase, inputs, PACK, pinned, run, syntheticDocument, withinCase, workedDocument } from './fixtures';

const csv = readFileSync(path.join(PACK, 'performance_indices.csv'), 'utf8').trim().split(/\r?\n/);
const header = (csv[0] ?? '').split(',');
const rows = csv.slice(1).map((line) => Object.fromEntries(line.split(',').map((cell, k) => [header[k] ?? '', cell])));

interface Result {
  readonly material: string;
  readonly case: string;
  readonly value: number;
  readonly unit: string;
  readonly unverified: boolean;
  readonly inputs: { property: string; value: number; unit: string; basis: string; propertyValueId: string; provenance: string }[];
}

const syn = syntheticDocument();

describe('INDEX_RULES (TR-SEL-01)', () => {
  it('equals validation/performance_indices.csv row by row', () => {
    expect(INDEX_RULES.map((rule) => rule.case)).toEqual([...INDEX_CASES]);
    expect(INDEX_RULES).toHaveLength(rows.length);
    INDEX_RULES.forEach((rule, k) => {
      const row = rows[k] ?? {};
      expect(rule.case).toBe(row['case']);
      expect(rule.component).toBe(row['component']);
      expect(rule.constraint).toBe(row['constraint']);
      expect(rule.freeVariable).toBe(row['free_variable']);
      expect(rule.fixed).toBe(row['fixed']);
      expect(rule.property === 'E' ? 'E' : 'sigma_f').toBe(row['property']);
      expect(rule.index).toBe(row['index_to_maximise']);
      expect(rule.derivation).toBe(row['derivation']);
      const [num = '', den = '1'] = (row['exponent_n'] ?? '').split('/');
      expect(rule.exponent).toEqual({ num: Number(num), den: Number(den) });
      expect(rule.source.length).toBeGreaterThan(0);
    });
  });
});

/** Minimum-mass solve of each case (independent of the closed form): bisection on the free size until the constraint holds, n measured from two property values. */
const MASS_SOLVES: Record<string, { property: 'E' | 'strength'; mass: (p: number, rho: number) => number }> = (() => {
  const bisect = (g: (x: number) => number, target: number): number => {
    let low = 1e-9;
    let high = 1e9;
    for (let k = 0; k < 400; k += 1) {
      const mid = Math.sqrt(low * high);
      if (g(mid) < target) low = mid;
      else high = mid;
    }
    return Math.sqrt(low * high);
  };
  const L = 2;
  const w = 3;
  const C = 48;
  const N = 2;
  return {
    tie_stiffness: { property: 'E', mass: (p, rho) => rho * L * bisect((a) => (p * a) / L, 7) },
    tie_strength: { property: 'strength', mass: (p, rho) => rho * L * bisect((a) => p * a, 7) },
    beam_stiffness: {
      property: 'E',
      mass: (p, rho) =>
        rho *
        L *
        Math.pow(
          bisect((b) => (C * p * b ** 4) / (12 * L ** 3), 7),
          2,
        ),
    },
    beam_strength: {
      property: 'strength',
      mass: (p, rho) =>
        rho *
        L *
        Math.pow(
          bisect((b) => (p * b ** 3) / 6, 7),
          2,
        ),
    },
    panel_stiffness: { property: 'E', mass: (p, rho) => rho * w * L * bisect((t) => (C * p * w * t ** 3) / (12 * L ** 3), 7) },
    panel_strength: { property: 'strength', mass: (p, rho) => rho * w * L * bisect((t) => (p * w * t ** 2) / 6, 7) },
    column_buckling: {
      property: 'E',
      mass: (p, rho) =>
        rho *
        L *
        Math.pow(
          bisect((b) => (N * Math.PI ** 2 * p * b ** 4) / (12 * L ** 2), 7),
          2,
        ),
    },
  };
})();

describe('VC-SEL-01: mass exponent n of each index', () => {
  INDEX_RULES.forEach((rule, k) => {
    it(`${rule.case}: n measured from a numerical minimum-mass solve = ${rule.exponent.num}/${rule.exponent.den}`, () => {
      const solve = MASS_SOLVES[rule.case];
      expect(solve?.property).toBe(rule.property);
      const [p1, p2, rho] = [100, 400, 3];
      const measured = -Math.log((solve?.mass(p2, rho) ?? 1) / (solve?.mass(p1, rho) ?? 1)) / Math.log(p2 / p1);
      const id = `VC-SEL-01.${k + 1}`;
      expect(Math.abs(measured - exponentValue(rule))).toBeLessThan(1e-6);
      expect(Math.abs(exponentValue(rule) - Number(expectedCase(id).value))).toBeLessThan(1e-9);
    });
  });

  it('the unit string is generated from the exponent', () => {
    expect(INDEX_RULES.map(indexUnit)).toEqual([
      'GPa/(Mg/m^3)',
      'MPa/(Mg/m^3)',
      'GPa^(1/2)/(Mg/m^3)',
      'MPa^(2/3)/(Mg/m^3)',
      'GPa^(1/3)/(Mg/m^3)',
      'MPa^(1/2)/(Mg/m^3)',
      'GPa^(1/2)/(Mg/m^3)',
    ]);
  });
});

describe('material_index', () => {
  it('VC-SEL-02: beam stiffness index of the synthetic materials, base units, inputs with basis and source', () => {
    const result = run(syn, 'material_index', { materials: inputs.synthetic.map((entry) => entry.id), indices: ['beam_stiffness'] });
    const data = dataOf(result);
    const results = data['results'] as Result[];
    expect(result.rejected).toBeUndefined();
    expect(result.document).toBe(syn);
    expect(result.affected).toEqual([]);
    expect(results.map((entry) => entry.material)).toEqual(inputs.synthetic.map((entry) => entry.id));
    for (const entry of results) {
      const caseId = `VC-SEL-02.${entry.material}`;
      expect(withinCase(entry.value, Number(expectedCase(caseId).value), caseId)).toBe(true);
      expect(entry.unit).toBe('GPa^(1/2)/(Mg/m^3)');
      expect(entry.inputs.map((input) => [input.property, input.unit, input.basis])).toEqual([
        ['E', 'GPa', 'company'],
        ['density', 'Mg/m^3', 'company'],
      ]);
      expect(entry.inputs[0]?.provenance).toContain('synthetic test fixture');
      expect(entry.unverified).toBe(false);
    }
    expect(data['unverified']).toBe(false);
    expect(data['basesUsed']).toEqual(['company']);
    expect(data['reviewRequired']).toBe(true);
  });

  it('strength indices read the named property: Fty and Ftu differ', () => {
    const doc = execute(workedDocument(), 'set_material_property', {
      material: 'aa7075_t6',
      property: 'Ftu',
      value: 572,
      unit: 'MPa',
      basis: 'typical',
      source: { citation: 'test: Ftu above Fty' },
    }).document;
    const read = (strengthProperty: string): number =>
      (
        dataOf(run(doc, 'material_index', { materials: ['aa7075_t6'], indices: ['tie_strength'], strengthProperty }))['results'] as Result[]
      )[0]?.value ?? Number.NaN;
    expect(read('Fty')).toBeCloseTo(503 / 2.81, 9);
    expect(read('Ftu')).toBeCloseTo(572 / 2.81, 9);
  });

  it('worked example (VC-SEL-10/11 inputs): indices of the sourced materials are unverified, with the pinned values', () => {
    const doc = workedDocument();
    const rowsOut = pinned<{ rows: Record<string, { beamStiffnessIndex: number; panelStiffnessIndex: number; tieStrengthIndex: number }> }>(
      'workedExample',
    ).rows;
    const result = run(doc, 'material_index', {
      materials: ['aa7075_t6', 'ti6al4v_annealed', 'aisi4130_normalized'],
      indices: ['beam_stiffness', 'panel_stiffness', 'tie_strength'],
      strengthProperty: 'Fty',
    });
    const results = dataOf(result)['results'] as Result[];
    expect(results).toHaveLength(9);
    const keyOf: Record<string, 'beamStiffnessIndex' | 'panelStiffnessIndex' | 'tieStrengthIndex'> = {
      beam_stiffness: 'beamStiffnessIndex',
      panel_stiffness: 'panelStiffnessIndex',
      tie_strength: 'tieStrengthIndex',
    };
    for (const entry of results) {
      const pin = rowsOut[entry.material]?.[keyOf[entry.case] ?? 'beamStiffnessIndex'] ?? Number.NaN;
      expect(Math.abs(entry.value - pin)).toBeLessThanOrEqual(1e-9 * Math.abs(pin) + 1e-11 * Math.abs(pin));
      expect(entry.unverified).toBe(true);
    }
    expect(dataOf(result)['unverified']).toBe(true);
    expect(result.summary).toContain('UNVERIFIED');
    expect((dataOf(result)['warnings'] as { code: string }[]).map((entry) => entry.code)).toContain('SEL_VALUE_UNVERIFIED');
  });

  it('VC-SEL-14: a material without a density is excluded with SEL_PROPERTY_MISSING and the missing name, never ranked', () => {
    const result = run(workedDocument(), 'material_index', {
      materials: ['aa7075_t6', 'cfrp_t300_5208_quasi_iso'],
      indices: ['beam_stiffness'],
    });
    const data = dataOf(result);
    expect((data['results'] as Result[]).map((entry) => entry.material)).toEqual(['aa7075_t6']);
    expect(data['excluded']).toEqual([
      expect.objectContaining({ material: 'cfrp_t300_5208_quasi_iso', code: expectedCase('VC-SEL-14').value, missing: ['density'] }),
    ]);
  });

  it('VC-SEL-16: the worked example mixes bases -> SEL_BASIS_MIXED', () => {
    const result = run(workedDocument(), 'material_index', { materials: ['ti6al4v_annealed'], indices: ['beam_stiffness'] });
    const data = dataOf(result);
    expect(data['basesUsed']).toEqual(['supplier_unstated', 'typical']);
    expect((data['warnings'] as { code: string }[]).map((entry) => entry.code)).toContain(expectedCase('VC-SEL-16').value);
  });

  it('is pure', () => {
    const before = structuredClone(syn);
    const result = execute(syn, 'material_index', { materials: ['syn_a'], indices: ['tie_stiffness'] });
    expect(syn).toEqual(before);
    expect(result.document).toBe(syn);
  });

  it('refuses an unknown material, a strength index without strengthProperty and a bad quantity (unchanged doc)', () => {
    const unknown = run(syn, 'material_index', { materials: ['syn_a', 'nope'], indices: ['beam_stiffness'] });
    expect(unknown.rejected).toBe(true);
    expect(unknown.error).toMatchObject({ code: 'SEL_MATERIAL_NOT_FOUND', ids: ['nope'] });
    expect(unknown.document).toBe(syn);
    const unset = run(syn, 'material_index', { materials: ['syn_a'], indices: ['beam_strength'] });
    expect(unset.error).toMatchObject({ code: 'SEL_STRENGTH_PROPERTY_UNSET', paths: ['strengthProperty'] });
    const badUnit = run(syn, 'material_index', {
      materials: ['syn_a'],
      indices: ['beam_stiffness'],
      temperature: { value: 20, unit: 'furlong' },
    });
    expect(badUnit.error?.code).toBe('SEL_PARAMS_INVALID');
    const none = run(syn, 'material_index', { materials: [], indices: ['beam_stiffness'] });
    expect(none.error?.code).toBe('SEL_PARAMS_INVALID');
    expect(none.document).toBe(syn);
  });

  it('two values of one property and none preferred is ambiguous (SEL_PROPERTY_AMBIGUOUS), a preferred one resolves it', () => {
    const rival = { material: 'syn_a', property: 'E', value: 71, unit: 'GPa', basis: 'B', source: { citation: 'test rival value' } };
    const two = execute(syn, 'set_material_property', rival).document;
    const ambiguous = dataOf(run(two, 'material_index', { materials: ['syn_a'], indices: ['beam_stiffness'] }));
    expect(ambiguous['excluded']).toEqual([expect.objectContaining({ code: 'SEL_PROPERTY_AMBIGUOUS', missing: ['E'] })]);
    const resolved = execute(two, 'set_material_property', { ...rival, id: 'E.preferred', basis: 'A', preferred: true }).document;
    expect(
      (dataOf(run(resolved, 'material_index', { materials: ['syn_a'], indices: ['beam_stiffness'] }))['results'] as Result[])[0]?.value,
    ).toBeCloseTo(Math.sqrt(71) / 2, 9);
  });
});
