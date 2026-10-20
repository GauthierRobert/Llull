/** PHY-04 M4b review: unverified elastic models in the orthotropic readiness check, orthotropic deck branches, amplitude blocks. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { ThermalSetup } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { amplitudeLines } from '@cae/thermal/deckAmplitude';
import { mustRun } from '../deckFixtures';
import { coupledFixture, textOf, type CoupledFixture } from './coupledSupport';

const SECANT_20 = { mat: { kind: 'secant', referenceTemperature: { value: 20, unit: 'degC' } } };

function ortho(): CoupledFixture {
  const base = coupledFixture({ orthotropic: [1e-5, 2e-5, 3e-5] });
  const doc = mustRun(base.doc, 'set_temperature_field', { analysisId: base.analysisId, cteBasis: SECANT_20 });
  return { ...base, doc, mesh: { ...base.mesh, inputHash: analysisInputHash(doc, base.analysisId, 'mesh') } };
}

/** The document with the basis of the property model `modelId` of material `mat` replaced. */
function withBasis(doc: CadDocument, modelId: string, basis: string): CadDocument {
  const material = doc.materials['mat'];
  if (material === undefined) throw new Error('fixture material missing');
  const propertyModels = (material.propertyModels ?? []).map((model) => (model.id === modelId ? { ...model, basis } : model));
  return { ...doc, materials: { ...doc.materials, mat: { ...material, propertyModels } } } as CadDocument;
}

const itemsOf = (fixture: { doc: CadDocument; analysisId: string }): { code: string; severity: string; message: string }[] =>
  (
    execute(fixture.doc, 'check_thermo_mechanical', { analysisId: fixture.analysisId }).data as {
      items: { code: string; severity: string; message: string }[];
    }
  ).items;

describe('orthotropic readiness check and deck with unverified models', () => {
  it('reports an unverified E model of an orthotropic material (as the isotropic branch does)', () => {
    const fixture = ortho();
    expect(itemsOf(fixture).map((item) => item.code)).toEqual(['TMC_CTE_ORTHO_ELASTIC_ISOTROPIC']);
    const typical = { ...fixture, doc: withBasis(fixture.doc, 'E', 'typical') };
    const unverified = itemsOf(typical).find((item) => item.code === 'TMC_MATERIAL_UNVERIFIED');
    expect(unverified?.severity).toBe('warning');
    expect(unverified?.message).toContain('E: basis typical');
  });

  it('reports an unverified CTE direction in the check and in a deck comment', () => {
    const fixture = ortho();
    const doc = withBasis(fixture.doc, 'cte2', 'typical');
    const message = itemsOf({ doc, analysisId: fixture.analysisId }).find((item) => item.code === 'TMC_MATERIAL_UNVERIFIED')?.message;
    expect(message).toContain('direction 2: basis typical');
    const mesh = { ...fixture.mesh, inputHash: analysisInputHash(doc, fixture.analysisId, 'mesh') };
    expect(textOf(writeInp(doc, fixture.analysisId, mesh))).toContain('** UNVERIFIED: ');
  });

  it('an invalid reference temperature unit refuses the deck and the check never throws', () => {
    const fixture = ortho();
    const analysisCase = fixture.doc.analysis?.cases[fixture.analysisId];
    if (analysisCase?.thermomech === undefined) throw new Error('fixture case missing');
    const broken = {
      ...fixture.doc,
      analysis: {
        ...fixture.doc.analysis,
        cases: {
          ...fixture.doc.analysis?.cases,
          [fixture.analysisId]: {
            ...analysisCase,
            thermomech: { ...analysisCase.thermomech, referenceTemperature: { value: 1, unit: 'mm' } },
          },
        },
      },
    } as CadDocument;
    expect('code' in writeInp(broken, fixture.analysisId, fixture.mesh)).toBe(true);
    expect(() => itemsOf({ doc: broken, analysisId: fixture.analysisId })).not.toThrow();
  });
});

describe('amplitudeLines', () => {
  const bc = (amplitude: string | undefined): ThermalSetup['bcs'][string] => ({ amplitude }) as never;
  const thermal = (bcs: ThermalSetup['bcs'], amplitudes: Record<string, { points: number[][] }>): ThermalSetup =>
    ({ bcOrder: Object.keys(bcs), bcs, amplitudes }) as never;

  it('writes four time / factor pairs per row, one block per used amplitude, sorted by id', () => {
    const points = [
      [0, 0],
      [1, 1],
      [2, 0.5],
      [3, 0.25],
      [4, 0],
    ];
    const lines = amplitudeLines(thermal({ a: bc('b'), c: bc('a'), d: bc('b'), e: bc(undefined) }, { a: { points }, b: { points } }));
    expect(lines.filter((line) => line.startsWith('*AMPLITUDE'))).toHaveLength(2);
    expect(lines[0]).toMatch(/^\*AMPLITUDE, NAME=/);
    expect(lines[1]).toBe('0, 0, 1, 1, 2, 0.5, 3, 0.25');
    expect(lines[2]).toBe('4, 0');
  });

  it('writes an empty block for an amplitude without points and nothing when no BC uses one', () => {
    expect(amplitudeLines(thermal({ a: bc('gone') }, {}))).toHaveLength(1);
    expect(amplitudeLines(thermal({ a: bc(undefined) }, {}))).toEqual([]);
  });
});
