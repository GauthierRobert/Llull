/** Plant 01 PSC M1: `pipe_section_properties` (VC-PSC-02) with the bridge to the legacy `pipeWeightPerMetre`. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { pipeWallThickness, pipeWeightPerMetre } from '../../../../packages/domain-aec/src/industrial/piping/pipeWeight';
import { sectionProperties } from '@aec/plant/catalog/sectionProperties';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { packJson } from './packData';

const doc = createEmptyDocument();
type Row = Record<string, number | string | boolean>;
const props = (params: Record<string, unknown>): Row => data<Row>(doc, 'pipe_section_properties', params);
const near = (actual: unknown, expected: number, tolerance: number): void =>
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);

/** A document with one pipe element (legacy, or bound to a spec). */
function withPipe(diameter: number, spec?: { odMm: number; wallMm: number; verified: boolean; schedule?: string }): CadDocument {
  const base = createEmptyDocument();
  const pipe = {
    id: 'pipe-1',
    category: 'pipe',
    levelId: 'lvl-0',
    entityIds: [],
    points: [
      [0, 0, 0],
      [1000, 0, 0],
    ],
    diameter,
    service: 'water',
    material: 'steel',
    ...(spec === undefined ? {} : { spec: { specId: 'S1', revision: 1, nps: '2', dimensionalStandard: 'ASME', ...spec } }),
  };
  return { ...base, building: { elements: { 'pipe-1': pipe }, elementOrder: ['pipe-1'] } } as unknown as CadDocument;
}

describe('pipe_section_properties (VC-PSC-02)', () => {
  const reference = packJson<{ massFormula: { checks: Array<{ case: string; D: number; t: number; massKgPerM: number }> } }>(
    'component_references.json',
  );

  it('NPS 6 Sch 40 filled with water: 28.264 + 18.646 = 46.909 kg/m, ID 154.08 mm', () => {
    const row = props({ nps: 6, schedule: '40', standard: 'ASME B36.10M', contentDensityKgM3: 1000 });
    near(row['insideDiameterMm'], 154.08, 1e-3);
    near(row['massKgPerM'], 28.264, 1e-3);
    near(row['contentMassKgPerM'], 18.646, 1e-3);
    near(row['totalMassKgPerM'], 46.909, 2e-3);
    expect(row['basis']).toBe('catalogue');
    expect(row['verified']).toBe(true);
    expect(row['steelDensityKgM3']).toBe(7850);
  });

  it('reproduces the pack closed-form checks (NPS 6 and NPS 4 Sch 40) and NPS 2-1/2 Sch 40 = 8.633 kg/m', () => {
    for (const check of reference.massFormula.checks.filter((c) => c.massKgPerM > 0 && c.case.endsWith('Sch 40')))
      near(props({ odMm: check.D, wallMm: check.t })['massKgPerM'], check.massKgPerM, 1e-3);
    near(props({ nps: '2-1/2', schedule: '40' })['massKgPerM'], 8.633, 1e-3);
    near(props({ dn: 100, schedule: '40' })['massKgPerM'], 16.075, 1e-3);
  });

  it('agrees with the legacy pipeWeightPerMetre(168.3, 1000) = 0.46002 kN/m (bridge, 1e-9 for any D, t)', () => {
    near(props({ nps: 6, schedule: '40', contentDensityKgM3: 1000 })['weightKnPerM'], pipeWeightPerMetre(168.3, 1000), 1e-9);
    for (const diameter of [60.3, 114.3, 168.3, 219.1, 323.9]) {
      const section = sectionProperties({
        odMm: diameter,
        wallMm: pipeWallThickness(diameter),
        steelDensityKgM3: 7850,
        contentDensityKgM3: 800,
      });
      near(section?.weightKnPerM, pipeWeightPerMetre(diameter, 800), 1e-9);
    }
  });

  it('computes I, Z and insulation mass from the closed forms', () => {
    const row = props({ odMm: 100, wallMm: 5, insulation: { thicknessMm: 50, densityKgM3: 100 } });
    const d = 90;
    near(row['secondMomentMm4'], (Math.PI / 64) * (100 ** 4 - d ** 4), 1e-6);
    near(row['sectionModulusMm3'], (2 * (Math.PI / 64) * (100 ** 4 - d ** 4)) / 100, 1e-6);
    near(row['insulationMassKgPerM'], (100 * (Math.PI / 4) * (200 ** 2 - 100 ** 2)) / 1e6, 1e-9);
    near(row['metalAreaMm2'], Math.PI * 95 * 5, 1e-9);
    near(props({ odMm: 100, wallMm: 5, materialDensityKgM3: 2700 })['massKgPerM'], (2700 * Math.PI * 95 * 5) / 1e6, 1e-9);
  });

  it('reads a spec-bound pipe element (OD / wall of its binding) and a legacy one (wall table, unverified)', () => {
    const bound = props_(withPipe(60.3, { odMm: 73, wallMm: 5.16, verified: true, schedule: '40' }), { pipeId: 'pipe-1' });
    near(bound['massKgPerM'], 8.633, 1e-3);
    expect(bound['basis']).toBe('pipe spec');
    expect(bound['verified']).toBe(true);
    const legacy = props_(withPipe(168.3), { pipeId: 'pipe-1' });
    expect(legacy['basis']).toBe('legacy wall table');
    expect(legacy['verified']).toBe(false);
    expect(legacy['wallMm']).toBe(7.11);
    expect((legacy['warnings'] as unknown as Array<{ code: string }>)[0]?.code).toBe('PSC_DATA_UNVERIFIED');
  });

  it('reads the pipe diameter in document units', () => {
    const inches = { ...withPipe(6.625), units: 'in' } as CadDocument;
    near(props_(inches, { pipeId: 'pipe-1' })['outsideDiameterMm'], 168.275, 1e-9);
  });

  it('uses the standard OD for a size with wallMm (ASME NPS, EN 10220 DN)', () => {
    near(props({ nps: 4, wallMm: 6.02 })['outsideDiameterMm'], 114.3, 1e-9);
    near(props({ dn: 65, wallMm: 3.6, standard: 'EN 10220' })['outsideDiameterMm'], 76.1, 1e-9);
  });

  it('refuses unknown pipes, sizes, schedules and non-physical walls with codes', () => {
    expectRefusal(doc, 'pipe_section_properties', { pipeId: 'nope' }, 'PSC_PIPE_UNKNOWN', 'pipeId');
    expectRefusal(doc, 'pipe_section_properties', {}, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'pipe_section_properties', { nps: 6, schedule: '999' }, 'PSC_SCHEDULE_UNKNOWN');
    expectRefusal(doc, 'pipe_section_properties', { nps: 99, schedule: '40' }, 'PSC_CATALOG_ROW_MISSING');
    expectRefusal(doc, 'pipe_section_properties', { wallMm: 3 }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'pipe_section_properties', { odMm: 100, wallMm: 50 }, 'PSC_SIZE_UNKNOWN', 'wallMm');
    expectRefusal(doc, 'pipe_section_properties', { nps: 99, wallMm: 3 }, 'PSC_SIZE_UNKNOWN');
  });

  it('is pure', () => {
    expectPure(doc, () => props({ nps: 6, schedule: '40' }));
  });
});

function props_(document: CadDocument, params: Record<string, unknown>): Row {
  return data<Row>(document, 'pipe_section_properties', params);
}

describe('sectionProperties', () => {
  it('returns null for a non-physical pipe', () => {
    expect(sectionProperties({ odMm: 0, wallMm: 1, steelDensityKgM3: 7850, contentDensityKgM3: 0 })).toBeNull();
    expect(sectionProperties({ odMm: 10, wallMm: 0, steelDensityKgM3: 7850, contentDensityKgM3: 0 })).toBeNull();
    expect(sectionProperties({ odMm: 10, wallMm: 5, steelDensityKgM3: 7850, contentDensityKgM3: 0 })).toBeNull();
  });

  it('summarises the result for the agent', () => {
    expect(ok(doc, 'pipe_section_properties', { nps: 6, schedule: '40' }).summary).toContain('28.264 kg/m');
  });
});
