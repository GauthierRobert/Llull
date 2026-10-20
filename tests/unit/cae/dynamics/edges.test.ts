/** PHY-09 failure paths and unit systems: persistence validation, loss factors, random set-up problems, deck refusals, field attachment. */
import { describe, expect, it } from 'vitest';
import type { AnalysisCase, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { writeInp } from '@cae/decks/inpWriter';
import { dynamicsErrors } from '@cae/dynamics/validate';
import { caseLossFactor, lossFactorOf } from '@cae/dynamics/materialDamping';
import { isPostProblem, modalPost, randomPost } from '@cae/dynamics/randomSetup';
import { randomFieldInput, withNodalRms } from '@cae/dynamics/nodalField';
import { gravityInUnitSystem } from '@cae/dynamics/units';
import { mustRun, readyRandomStrip, SOURCE, strip } from './fixtures';
import { modalResults, stripMesh } from './solvedFixtures';

const withCase = (doc: CadDocument, id: string, change: (c: AnalysisCase) => AnalysisCase): CadDocument => {
  const analysis = doc.analysis;
  const current = analysis?.cases[id];
  if (analysis === undefined || current === undefined) throw new Error('no case');
  return { ...doc, analysis: { ...analysis, cases: { ...analysis.cases, [id]: change(current) } } };
};

function results(doc: CadDocument, analysisId: string, boxId: string, modes = 6): FeResultsArtifact {
  const mesh = stripMesh(doc, analysisId, boxId);
  return {
    kind: 'fe_results',
    meshHash: '',
    inputHash: analysisInputHash(doc, analysisId, 'full'),
    solver: 'calculix',
    solverVersion: 't',
    ...modalResults(mesh, modes),
  };
}

const ETA = (value: number, id = 'eta'): Record<string, unknown> => ({
  material: 'steel',
  model: {
    id,
    property: 'structuralLossFactor',
    unit: '1',
    variables: [],
    validity: [],
    form: { kind: 'constant', value },
    basis: 'typical',
    source: SOURCE,
  },
});

describe('units and persistence validation', () => {
  it('g in each unit system', () => {
    expect(gravityInUnitSystem('N-mm-t-s')).toBeCloseTo(9806.65, 9);
    expect(gravityInUnitSystem('N-m-kg-s')).toBe(9.80665);
    expect(gravityInUnitSystem('lbf-in-slinch-s')).toBeCloseTo(386.0885826771654, 9);
  });

  it('reports malformed dynamics and library entries', () => {
    const { doc, analysisId } = readyRandomStrip();
    interface Raw {
      analysis: {
        cases: Record<string, { dynamics: unknown }>;
        vibration:
          | { spectra: Record<string, { unit: string }>; histories: unknown; historyOrder: unknown }
          | number
          | Record<string, unknown>;
      };
    }
    const raw = JSON.parse(JSON.stringify(doc)) as Raw;
    const library = raw.analysis.vibration as { spectra: Record<string, { unit: string }>; histories: unknown; historyOrder: unknown };
    const target = raw.analysis.cases[analysisId] ?? { dynamics: null };
    target.dynamics = { basis: {}, damping: { model: 'magic' }, sweep: { fMinHz: 5, fMaxHz: 1 }, base: { kind: 'x' } };
    (library.spectra['gevs_q'] ?? { unit: '' }).unit = 'furlong';
    library.histories = { h: { name: 'h', timeS: 'x', values: [] } };
    library.historyOrder = ['h'];
    const asRecord = (): Record<string, unknown> => raw as unknown as Record<string, unknown>;
    expect(dynamicsErrors(asRecord())).toHaveLength(5);
    target.dynamics = 'bad';
    raw.analysis.vibration = 3;
    expect(dynamicsErrors(asRecord())).toEqual([
      `analysis case '${analysisId}': dynamics needs a basis record`,
      'analysis.vibration: expected a record',
    ]);
    raw.analysis.vibration = { spectra: {}, spectrumOrder: ['x'], histories: [], historyOrder: [] };
    expect(dynamicsErrors(asRecord()).length).toBeGreaterThanOrEqual(2);
    expect(dynamicsErrors({})).toEqual([]);
  });
});

describe('structural loss factor', () => {
  it('refuses missing materials, negative and disagreeing loss factors', () => {
    const bare = strip({ material: false });
    expect(lossFactorOf(bare.doc, bare.doc.analysis?.cases[bare.analysisId] as AnalysisCase, bare.boxId)).toMatchObject({
      code: 'DYN_MATERIAL_NO_DAMPING',
    });
    const ready = strip();
    const negative = mustRun(ready.doc, 'define_property_model', ETA(-0.1));
    const negativeCase = negative.analysis?.cases[ready.analysisId] as AnalysisCase;
    expect(lossFactorOf(negative, negativeCase, ready.boxId)).toMatchObject({ code: 'DYN_MATERIAL_NO_DAMPING' });
    const noParts = { ...negativeCase, parts: {} };
    expect(caseLossFactor(negative, noParts)).toMatchObject({ code: 'DYN_MATERIAL_NO_DAMPING', message: 'the analysis has no part' });
    const ok = mustRun(ready.doc, 'define_property_model', ETA(0.02));
    expect(caseLossFactor(ok, ok.analysis?.cases[ready.analysisId] as AnalysisCase)).toMatchObject({ eta: 0.02 });
  });
});

describe('random set-up problems', () => {
  it('names the missing piece', () => {
    const ready = readyRandomStrip();
    const analysis = (doc: CadDocument): AnalysisCase => doc.analysis?.cases[ready.analysisId] as AnalysisCase;
    const full = results(ready.doc, ready.analysisId, ready.boxId);
    expect(modalPost(ready.doc, analysis(ready.doc), { ...full, dat: { tables: [] } })).toMatchObject({ code: 'DYN_RESULTS_MISSING' });
    const narrow = mustRun(ready.doc, 'set_dynamic_basis', { analysisId: ready.analysisId, fMaxHz: 10 });
    expect(modalPost(narrow, analysis(narrow), full)).toMatchObject({ code: 'DYN_BASIS_MISSING' });
    const partial = mustRun(ready.doc, 'set_dynamic_damping', {
      analysisId: ready.analysisId,
      model: 'modal',
      ratios: [{ fromMode: 1, toMode: 2, zeta: 0.02 }],
      source: SOURCE,
    });
    expect(modalPost(partial, analysis(partial), full)).toMatchObject({ code: 'DYN_DAMPING_UNSET' });
    const structural = mustRun(
      mustRun(ready.doc, 'set_dynamic_damping', { analysisId: ready.analysisId, model: 'structural_material' }),
      'define_property_model',
      ETA(0.02),
    );
    const post = modalPost(structural, analysis(structural), full);
    expect(!isPostProblem(post) && post.kept[0]?.zeta).toBe(0.01);
    expect(modalPost(ready.doc, analysis(strip().doc), full)).toMatchObject({ code: 'DYN_DAMPING_UNSET' });
    const noBase = withCase(ready.doc, ready.analysisId, (c) => ({
      ...c,
      dynamics: { basis: {}, ...(c.dynamics?.damping ? { damping: c.dynamics.damping } : {}) },
    }));
    expect(randomPost(noBase, analysis(noBase), full)).toMatchObject({ code: 'DYN_BASE_UNSET' });
    const noSweep = withCase(ready.doc, ready.analysisId, (c) => {
      const { sweep, ...rest } = c.dynamics ?? { basis: {} };
      void sweep;
      return { ...c, dynamics: rest };
    });
    expect(randomPost(noSweep, analysis(noSweep), full)).toMatchObject({ code: 'DYN_SWEEP_UNSET' });
    const disjoint = mustRun(ready.doc, 'set_frequency_sweep', { analysisId: ready.analysisId, fMinHz: 3000, fMaxHz: 4000 });
    expect(randomPost(disjoint, analysis(disjoint), full)).toMatchObject({ code: 'DYN_SPECTRUM_INVALID' });
    const harmonic = strip({ type: 'frequency_response' });
    expect(
      randomFieldInput(harmonic.doc, harmonic.analysisId, stripMesh(harmonic.doc, harmonic.analysisId, harmonic.boxId), full),
    ).toMatchObject({ code: 'DYN_CASE_TYPE' });
  });

  it('withNodalRms checks size and finiteness; the field drops stress without modal S', () => {
    const ready = readyRandomStrip();
    const mesh = stripMesh(ready.doc, ready.analysisId, ready.boxId);
    const full = results(ready.doc, ready.analysisId, ready.boxId);
    const noStress = {
      ...full,
      steps: full.steps.map((step) => ({ ...step, fields: { DISP: step.fields['DISP'] ?? { components: [], values: {} } } })),
    };
    const input = randomFieldInput(ready.doc, ready.analysisId, mesh, noStress);
    if (isPostProblem(input)) throw new Error(input.message);
    expect(input.components).toEqual(['u_x_rel', 'u_y_rel', 'u_z_rel', 'a_x', 'a_y', 'a_z']);
    expect(withNodalRms(full, input, new Float64Array(3), 'ts', 's', 'v')).toMatch(/expected/);
    const bad = new Float64Array(input.nodeIds.length * 6).fill(Number.NaN);
    expect(withNodalRms(full, input, bad, 'ts', 's', 'v')).toMatch(/not finite/);
  });
});

describe('deck refusals after later edits', () => {
  it('unknown spectrum, a removed base constraint and a missing mode count', () => {
    const ready = readyRandomStrip();
    const mesh = stripMesh(ready.doc, ready.analysisId, ready.boxId);
    const constraintId = ready.doc.analysis?.cases[ready.analysisId]?.constraintOrder[0] ?? '';
    const withSets = { ...mesh, nodeSets: { [`C_${constraintId}`]: [1] } };
    const code = (doc: CadDocument): string => {
      const deck = writeInp(doc, ready.analysisId, { ...withSets, inputHash: analysisInputHash(doc, ready.analysisId, 'mesh') });
      return 'code' in deck ? deck.code : 'ok';
    };
    expect(code(ready.doc)).toBe('ok');
    const noLibrary = {
      ...ready.doc,
      analysis: {
        ...(ready.doc.analysis ?? { cases: {}, caseOrder: [] }),
        vibration: { spectra: {}, spectrumOrder: [], histories: {}, historyOrder: [] },
      },
    };
    expect(code(noLibrary)).toBe('DYN_SPECTRUM_UNKNOWN');
    const pinnedOnly = withCase(ready.doc, ready.analysisId, (c) => ({
      ...c,
      constraints: {
        [constraintId]: { ...(c.constraints[constraintId] as AnalysisCase['constraints'][string]), kind: 'displacement', dofs: { ux: 0 } },
      },
    }));
    expect(code(pinnedOnly)).toBe('DYN_BASE_NO_CONSTRAINT');
    const noModes = withCase(ready.doc, ready.analysisId, (c) => {
      const { modes, ...rest } = c;
      void modes;
      return rest;
    });
    expect(code(noModes)).toBe('DYN_BASIS_MISSING');
  });
});
