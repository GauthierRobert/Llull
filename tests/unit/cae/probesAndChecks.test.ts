import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { AnalysisCase, FeResultsArtifact, ProbeQuantity } from '@core/model/analysis';
import { checkThermalItems } from '@cae/thermal/check';
import { checkThermomechItems } from '@cae/thermomech/check';
import { evaluateProbes } from '@cae/results/probes';
import { parseFrd } from '@cae/results/frdReader';
import { caseOf, withCase } from '@cae/shared/access';
import { barDocument, barMesh, mustRun, solvedBar } from './deckFixtures';

const resultsOf = (file: string): FeResultsArtifact => ({
  kind: 'fe_results',
  meshHash: 'm',
  inputHash: 'i',
  solver: 'CalculiX',
  solverVersion: '2.21',
  steps: parseFrd(readFileSync(`tests/unit/cae/fixtures/${file}`, 'utf8')),
});

const withProbes = (analysis: AnalysisCase, quantities: readonly ProbeQuantity[], point: [number, number, number]): AnalysisCase => ({
  ...analysis,
  probes: Object.fromEntries(quantities.map((quantity) => [`p-${quantity}`, { name: quantity, point, quantity }])),
});

describe('evaluateProbes', () => {
  it('reads every structural quantity at the nearest node of the static run', () => {
    const bar = solvedBar();
    const analysis = withProbes(
      caseOf(bar.doc, bar.analysisId)!,
      ['u_mag', 'u_x', 'u_y', 'u_z', 'von_mises', 's_xx', 's_yy', 's_zz'],
      [2, 1, 1],
    );
    const readings = evaluateProbes({ ...analysis, probes: analysis.probes }, { ...bar.mesh, nodeSets: {} }, bar.results, 1);
    const at = (quantity: string): number | null => readings.find((reading) => reading.quantity === quantity)?.values[0]?.value ?? null;
    expect(readings.every((reading) => reading.nodeId === 8 && reading.nodeDistance === 0)).toBe(true);
    expect(at('u_x')).toBeCloseTo(0.002, 12);
    expect(at('u_y')).toBeCloseTo(-3e-4, 12);
    expect(at('u_z')).toBeCloseTo(-3e-4, 12);
    expect(at('u_mag')).toBeCloseTo(Math.hypot(0.002, 3e-4, 3e-4), 12);
    expect(at('s_xx')).toBeCloseTo(210, 9);
    expect(at('s_yy')).toBeCloseTo(0, 9);
    expect(at('s_zz')).toBeCloseTo(0, 9);
    expect(at('von_mises')).toBeCloseTo(210, 9);
  });

  it('scales the probe point to analysis units and reports no node for an empty mesh', () => {
    const bar = solvedBar();
    const analysis = withProbes(caseOf(bar.doc, bar.analysisId)!, ['u_x'], [0.002, 0.001, 0.001]);
    const metres = evaluateProbes(analysis, { ...bar.mesh, nodeSets: {} }, bar.results, 1000);
    expect(metres[0]).toMatchObject({ nodeId: 8, unit: 'mm' });
    const empty = evaluateProbes(analysis, { ...bar.mesh, nodes: [], nodeSets: {} }, bar.results, 1);
    expect(empty[0]).toMatchObject({ nodeId: null, nodeDistance: null });
    expect(empty[0]?.values[0]?.value).toBeNull();
  });

  it('gives null where a field was not written in the result set', () => {
    const bar = solvedBar();
    const analysis = withProbes(caseOf(bar.doc, bar.analysisId)!, ['temperature', 'heat_flux'], [2, 1, 1]);
    const readings = evaluateProbes(analysis, bar.mesh, bar.results, 1);
    expect(readings.map((reading) => reading.values[0]?.value)).toEqual([null, null]);
  });

  it('gives time series with temperature and flux units for a heat case', () => {
    const base = barDocument({ supports: false });
    const created = execute(base.doc, 'create_analysis', { name: 'h', analysisType: 'heat_steady' });
    const analysisId = created.affected[0] ?? '';
    const doc = mustRun(created.document, 'set_part_idealization', { analysisId, entityId: base.boxId });
    const analysis = withProbes(caseOf(doc, analysisId)!, ['temperature', 'heat_flux'], [0, 0, 0]);
    const mesh = barMesh(doc, analysisId, base.boxId, {});
    const readings = evaluateProbes(analysis, mesh, resultsOf('heat.frd'), 1);
    expect(readings[0]).toMatchObject({ quantity: 'temperature', unit: 'degC', nodeId: 1 });
    expect(readings[0]?.values).toEqual([{ loadCase: null, step: 1, time: 1, value: 100 }]);
    expect(readings[1]?.unit).toBe('heat flux (N-mm-t-s)');
    expect(readings[1]?.values[0]?.value).toBeCloseTo(2000, 6);
    const transient = evaluateProbes(analysis, mesh, resultsOf('transient.frd'), 1);
    expect(transient[0]?.values.map((value) => value.time)).toEqual([0.5, 1, 1.5]);
    const kelvin = withCase(doc, { ...caseOf(doc, analysisId)!, thermal: { ...caseOf(doc, analysisId)!.thermal!, temperatureScale: 'K' } });
    expect(
      evaluateProbes(withProbes(caseOf(kelvin, analysisId)!, ['temperature'], [0, 0, 0]), mesh, resultsOf('heat.frd'), 1)[0]?.unit,
    ).toBe('K');
  });
});

describe('check_analysis item coverage', () => {
  const codesOf = (doc: Parameters<typeof execute>[0], analysisId: string): string[] =>
    ((execute(doc, 'check_analysis', { analysisId }).data as { items: { code: string }[] }).items ?? []).map((item) => item.code);

  it('warns that property models on a typical basis are unverified (FEA_MATERIAL_UNVERIFIED, VC-MAT-23)', () => {
    const bar = barDocument({ material: 'models' });
    expect(codesOf(bar.doc, bar.analysisId)).toContain('FEA_MATERIAL_UNVERIFIED');
  });

  it('flags a part whose entity is gone', () => {
    const bar = barDocument();
    const removed = { ...bar.doc, entities: {}, order: [] };
    expect(codesOf(removed, bar.analysisId)).toContain('FEA_PART_INVALID');
  });

  it('checks the elastic constants of a thermo_static case at its reference temperature', () => {
    const thermo = barDocument({ analysisType: 'thermo_static' });
    expect(codesOf(thermo.doc, thermo.analysisId)).not.toContain('FEA_MATERIAL_NO_ELASTIC');
    const kelvin = withCase(thermo.doc, {
      ...caseOf(thermo.doc, thermo.analysisId)!,
      thermomech: { ...caseOf(thermo.doc, thermo.analysisId)!.thermomech!, referenceTemperature: { value: 293.15, unit: 'K' } },
    });
    expect(codesOf(kelvin, thermo.analysisId)).not.toContain('FEA_MATERIAL_NO_ELASTIC');
  });
});

describe('check_analysis delegation to the disciplines', () => {
  it('adds the thermal items for a heat case and the thermo-mechanical items for thermo_static', () => {
    const base = barDocument({ supports: false });
    const created = execute(base.doc, 'create_analysis', { name: 'h', analysisType: 'heat_steady' });
    const analysisId = created.affected[0] ?? '';
    const doc = mustRun(created.document, 'set_part_idealization', { analysisId, entityId: base.boxId });
    const heat = execute(doc, 'check_analysis', { analysisId }).data as { items: { code: string }[] };
    expect(heat.items.map((item) => item.code)).toEqual(
      expect.arrayContaining(checkThermalItems(doc, analysisId).map((item) => item.code)),
    );
    expect(checkThermalItems(doc, analysisId).length).toBeGreaterThan(0);
    const thermo = barDocument({ analysisType: 'thermo_static' });
    const result = execute(thermo.doc, 'check_analysis', { analysisId: thermo.analysisId }).data as { items: { code: string }[] };
    const expected = checkThermomechItems(thermo.doc, thermo.analysisId).map((item) => item.code);
    expect(expected.length).toBeGreaterThan(0);
    expect(result.items.map((item) => item.code)).toEqual(expect.arrayContaining(expected));
  });
});
