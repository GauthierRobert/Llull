/** CAE command consolidation: delete_analysis_item, analysis_report, hand_check, run_reliability_study form, and the retired names that map onto them. */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { migrateRetiredCalls } from '@core/commands/persistence/retiredCommands';
import { apply, data, expectRefusal, ok } from '../../helpers/commandAssertions';
import { modelWithAnalysis } from './helpers';

const call = (command: string, params: Record<string, unknown>): { command: string; params: unknown } =>
  migrateRetiredCalls({ command, params }) as { command: string; params: unknown };

describe('retired CAE commands', () => {
  it.each([
    ['delete_fea_constraint', 'constraintId'],
    ['delete_fea_load', 'loadId'],
    ['delete_result_probe', 'probeId'],
    ['delete_thermal_bc', 'bcId'],
    ['delete_thermal_contact', 'contactId'],
    ['delete_amplitude', 'amplitudeId'],
    ['delete_temperature_limit', 'limitId'],
    ['delete_contact', 'contactId'],
    ['delete_imposed_motion', 'motionId'],
    ['delete_rigid_wall', 'wallId'],
  ])('%s maps its %s onto delete_analysis_item itemId', (oldName, key) => {
    expect(call(oldName, { analysisId: 'an-1.1', [key]: 'x-1.1' })).toEqual({
      command: 'delete_analysis_item',
      params: { analysisId: 'an-1.1', itemId: 'x-1.1' },
    });
    expect(call(oldName, { analysisId: 'an-1.1' })).toEqual({ command: 'delete_analysis_item', params: { analysisId: 'an-1.1' } });
  });

  it.each([
    ['fea_report', 'status'],
    ['thermal_report', 'thermal'],
    ['explicit_report', 'explicit'],
    ['dynamic_report', 'dynamic'],
  ])('%s becomes analysis_report with view %s and keeps its other params', (oldName, view) => {
    expect(call(oldName, { analysisId: 'an-1.1', probes: ['p'] })).toEqual({
      command: 'analysis_report',
      params: { analysisId: 'an-1.1', probes: ['p'], view },
    });
  });

  it('reliability_form becomes run_reliability_study with the form (and sorm) method', () => {
    expect(call('reliability_form', { limitState: 'g', maxIterations: 5 })).toEqual({
      command: 'run_reliability_study',
      params: { limitState: 'g', maxIterations: 5, methods: ['form'] },
    });
    expect(call('reliability_form', { limitState: 'g', sorm: true })).toEqual({
      command: 'run_reliability_study',
      params: { limitState: 'g', methods: ['form', 'sorm'] },
    });
  });

  it.each(['analytic_check', 'explicit_quick_check'])('%s becomes hand_check with unchanged params', (oldName) => {
    const params = { check: 'wave_speed', inputs: { E_Pa: 1 } };
    expect(call(oldName, params)).toEqual({ command: 'hand_check', params });
  });

  it('saved constraint and load deletions regenerate the same document', () => {
    const { doc, analysisId, boxId } = modelWithAnalysis();
    const withItems = apply(
      apply(doc, 'add_fea_constraint', { analysisId, name: 'fix', kind: 'fixed', target: { entityId: boxId, facesNear: [[5, 5, 0]] } }),
      'add_fea_load',
      { analysisId, name: 'g', kind: 'gravity', loadCase: 'LC1', category: 'limit', vector: [0, 0, -9810] },
    );
    const loadId = withItems.analysis?.cases[analysisId]?.loadOrder[0] ?? '';
    const modern = ok(withItems, 'delete_analysis_item', { analysisId, itemId: loadId }).document;
    const legacyStep = { ...modern.featureHistory.at(-1)!, name: 'delete_fea_load', params: { analysisId, loadId } };
    const legacy = { ...modern, featureHistory: [...modern.featureHistory.slice(0, -1), legacyStep] };
    const loaded = deserializeDocument(serializeDocument(legacy));
    expect(loaded.featureHistory.at(-1)).toMatchObject({ name: 'delete_analysis_item', params: { analysisId, itemId: loadId } });
    expect(execute(loaded, 'replay_history', {}).document.analysis).toEqual(modern.analysis);
  });
});

describe('delete_analysis_item', () => {
  it('refuses an id that is no record of the analysis, whichever family it looks like', () => {
    const { doc, analysisId } = modelWithAnalysis();
    for (const itemId of ['fc-9.9', 'tb-1.1', 'ct-1.1', 'nope'])
      expectRefusal(doc, 'delete_analysis_item', { analysisId, itemId }, 'FEA_ITEM_NOT_FOUND');
  });

  it('refuses an unknown analysis and rejects the old per-kind id keys', () => {
    const { doc } = modelWithAnalysis();
    expectRefusal(doc, 'delete_analysis_item', { analysisId: 'ghost', itemId: 'fl-1.1' }, 'FEA_ANALYSIS_NOT_FOUND');
    expect(execute(doc, 'delete_analysis_item', { analysisId: 'ghost', loadId: 'fl-1.1' }).rejected).toBe(true);
  });

  it('removes an explicit rigid wall by id and reports the analysis as affected', () => {
    const { doc, analysisId } = modelWithAnalysis('explicit_dynamics');
    const controlled = apply(doc, 'set_explicit_controls', {
      analysisId,
      endTime: { value: 1, unit: 'ms' },
      historyInterval: { value: 0.1, unit: 'ms' },
    });
    const added = ok(controlled, 'add_rigid_wall', { analysisId, name: 'anvil', point: [0, 0, 0], normal: [0, 0, 1] });
    const wallId = added.affected[1] ?? '';
    const removed = ok(added.document, 'delete_analysis_item', { analysisId, itemId: wallId });
    expect(removed.affected).toEqual([analysisId]);
    expect(removed.document.analysis?.cases[analysisId]?.explicit?.rigidWallOrder).toEqual([]);
  });
});

describe('analysis_report', () => {
  it('picks the view from the analysis type', () => {
    const status = data(modelWithAnalysis('static').doc, 'analysis_report', { analysisId: 'an-2.1' });
    expect(status).toHaveProperty('probesNote');
    const heat = modelWithAnalysis('heat_steady');
    expect(data(heat.doc, 'analysis_report', { analysisId: heat.analysisId })).toHaveProperty('temperatureScale');
    const explicit = modelWithAnalysis('explicit_dynamics');
    expect(data(explicit.doc, 'analysis_report', { analysisId: explicit.analysisId })).toHaveProperty('certificationEvidence', false);
  });

  it('view overrides the default and a view that does not fit the type is refused by that view', () => {
    const heat = modelWithAnalysis('heat_steady');
    expect(data(heat.doc, 'analysis_report', { analysisId: heat.analysisId, view: 'status' })).toHaveProperty('probesNote');
    const staticCase = modelWithAnalysis('static');
    expectRefusal(staticCase.doc, 'analysis_report', { analysisId: staticCase.analysisId, view: 'thermal' }, 'THM_CASE_TYPE');
    expectRefusal(staticCase.doc, 'analysis_report', { analysisId: staticCase.analysisId, view: 'explicit' }, 'EXP_CASE_TYPE');
  });

  it('refuses params the chosen view does not read, and an unknown analysis', () => {
    const { doc, analysisId } = modelWithAnalysis('static');
    expectRefusal(doc, 'analysis_report', { analysisId, timeS: 1 }, 'FEA_PARAM_NOT_APPLICABLE');
    expectRefusal(doc, 'analysis_report', { analysisId, maxPoints: 10 }, 'FEA_PARAM_NOT_APPLICABLE');
    expectRefusal(doc, 'analysis_report', { analysisId, probes: ['p'] }, 'FEA_PARAM_NOT_APPLICABLE');
    const explicit = modelWithAnalysis('explicit_dynamics');
    expectRefusal(explicit.doc, 'analysis_report', { analysisId: explicit.analysisId, probes: ['p'] }, 'FEA_PARAM_NOT_APPLICABLE');
    expectRefusal(doc, 'analysis_report', { analysisId: 'ghost' }, 'FEA_ANALYSIS_NOT_FOUND');
  });

  it('accepts the params its view reads', () => {
    const heat = modelWithAnalysis('heat_steady');
    ok(heat.doc, 'analysis_report', { analysisId: heat.analysisId, timeS: 1, probes: [] });
    const explicit = modelWithAnalysis('explicit_dynamics');
    ok(explicit.doc, 'analysis_report', { analysisId: explicit.analysisId, maxPoints: 50 });
  });

  it('is pure', () => {
    const { doc, analysisId } = modelWithAnalysis('static');
    const before = JSON.stringify(doc);
    expect(ok(doc, 'analysis_report', { analysisId }).document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('hand_check', () => {
  it('evaluates a structural and an explicit check from the same command', () => {
    const doc = createEmptyDocument();
    const beam = data<{ results: { name: string }[] }>(doc, 'hand_check', {
      check: 'cantilever',
      inputs: { P_N: 9, L_mm: 8, E_MPa: 210000, b_mm: 1, h_mm: 1 },
    });
    expect(beam.results.length).toBeGreaterThan(0);
    const wave = data<{ values: Record<string, number> }>(doc, 'hand_check', {
      check: 'wave_speed',
      inputs: { E_Pa: 2e11, nu: 0.3, rho_kg_m3: 7850 },
    });
    expect(wave.values['c0_m_s']).toBeGreaterThan(5000);
  });

  it('refuses compare on an explicit check, a missing explicit input and an unknown structural input', () => {
    const doc = createEmptyDocument();
    const inputs = { E_Pa: 2e11, nu: 0.3, rho_kg_m3: 7850 };
    expectRefusal(
      doc,
      'hand_check',
      { check: 'wave_speed', inputs, compare: { quantity: 'c0_m_s', value: 1 } },
      'FEA_PARAM_NOT_APPLICABLE',
    );
    expectRefusal(doc, 'hand_check', { check: 'wave_speed', inputs: { E_Pa: 2e11 } }, 'EXP_INPUT_MISSING');
    expectRefusal(doc, 'hand_check', { check: 'cantilever', inputs: { bogus: 1 } }, 'FEA_ANALYTIC_INPUT_INVALID');
  });
});
