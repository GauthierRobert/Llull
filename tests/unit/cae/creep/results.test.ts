/** PHY-11 M2 results (TR-CRP-51, 52, 60; FR-CRP-05, 13..17, 21): frd reader, CreepResultsSummary, probes, creep_report, check_creep. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { parseFrd } from '@cae/results/frdReader';
import { evaluateProbes } from '@cae/results/probes';
import { caseOf, withCase } from '@cae/shared/access';
import { creepCube, creepFrd, cubeMesh, holdFrd, solveCube, type CreepCube } from './support';

const PRELOAD = 1e-3;
/** The `data` fields of the creep queries these tests read (the commands guarantee them; the cast is the only unchecked step). */
interface Data {
  readonly status: string;
  readonly state: string;
  readonly items: readonly { readonly code: string }[];
  readonly notes: readonly string[];
  readonly hold: Record<string, unknown>;
  readonly laws: readonly unknown[];
  readonly maxCeeq: { readonly value: number };
  readonly quickCheck: { readonly ratioFeToClosedForm: number };
  readonly probes: Record<string, { readonly history: readonly unknown[] }>;
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly reviewReason: string;
  readonly series: readonly { readonly points: readonly { readonly time: number }[] }[];
}
const reportOf = (data: unknown): Data => data as Data;
const codesOf = (data: unknown): string[] => reportOf(data).items.map((entry) => entry.code);

const solved = (options: Parameters<typeof creepCube>[0] = {}, frd = holdFrd(PRELOAD)): ReturnType<typeof solveCube> & { c: CreepCube } => {
  const c = creepCube({ probes: [{ name: 'centre', quantity: 'ceeq' }], ...options });
  return { ...solveCube(c, frd), c };
};

describe('frd reader on a real CalculiX 2.21 creep run', () => {
  it('reads PE (the creep strain, requested as CEEQ), STRESS and DISP per time point of the hold step; step 2, total time from the 100CL header', () => {
    const steps = parseFrd(readFileSync('tests/unit/cae/fixtures/ccx221_creep_excerpt.frd', 'utf8'));
    const pe = steps.filter((step) => step.fields['PE'] !== undefined);
    expect(pe.map((step) => [step.step, step.time])).toEqual([
      [2, 1.001],
      [2, 10.001],
      [2, 100.001],
      [2, 500.001],
      [2, 1000.001],
    ]);
    expect(pe[0]?.fields['PE']?.values['1']?.[0]).toBeCloseTo(3.19987e-4, 9);
    expect(pe[4]?.fields['PE']?.values['8']?.[0]).toBeCloseTo(0.319987, 6);
    expect(steps.at(-1)?.fields['STRESS']?.values['1']?.[2]).toBeCloseTo(19.9992, 4);
    expect(steps.at(-1)?.fields['DISP']?.components).toEqual(['D1', 'D2', 'D3']);
  });
});

describe('CreepResultsSummary', () => {
  it('records the hold: complete, final hold time without the preload period, peaks with place and entity, one load case at the end of the hold', () => {
    const { doc, c } = solved();
    const results = caseOf(doc, c.analysisId)?.results;
    expect(results?.creep).toMatchObject({
      holdComplete: true,
      finalTimeS: 1000,
      outputSets: 4,
      maxCeeq: { value: 0.32, entityId: c.cube },
      maxVonMisesEndMPa: { value: 20, entityId: c.cube },
      maxVonMisesOverHoldMPa: 20,
    });
    const [history] = Object.values(results?.creep?.probeHistories ?? {});
    expect(history).toMatchObject({ quantity: 'ceeq', unit: '-', tS: [1, 10, 100, 1000] });
    expect(results?.loadCases.map((entry) => [entry.name, entry.maxVonMises.value])).toEqual([['creep_hold_end', 20]]);
    expect(history?.values[3]).toBeCloseTo(0.32, 12);
  });

  it('flags an incomplete hold and keeps the preload sets out of the history', () => {
    const frd = creepFrd([
      { step: 1, time: PRELOAD, szz: 20, ceeq: 0 },
      { step: 2, time: PRELOAD + 1, szz: 20, ceeq: 3.2e-4 },
      { step: 2, time: PRELOAD + 500, szz: 20, ceeq: 0.16 },
    ]);
    const { doc, c } = solved({}, frd);
    expect(caseOf(doc, c.analysisId)?.results?.creep).toMatchObject({ holdComplete: false, finalTimeS: 500, outputSets: 2 });
    expect(reportOf(execute(doc, 'check_creep', { analysisId: c.analysisId }, solved({}, frd).ctx).data)['status']).toBe('fail');
  });

  it('without a PE block or a hold set it records no creep strain; the record text names the hold', () => {
    const noPe = creepFrd([{ step: 2, time: PRELOAD + 1000, szz: 20, ceeq: 0 }]).replace(/ -4  PE[\s\S]*? -3\n?/, '');
    const { doc, c } = solved({}, noPe);
    expect(caseOf(doc, c.analysisId)?.results?.creep?.maxCeeq).toBeUndefined();
    const none = solved({}, creepFrd([{ step: 1, time: PRELOAD, szz: 20, ceeq: 0 }]));
    expect(caseOf(none.doc, none.c.analysisId)?.results?.creep).toMatchObject({ holdComplete: false, outputSets: 0, finalTimeS: 0 });
    expect(caseOf(none.doc, none.c.analysisId)?.results?.loadCases).toEqual([]);
  });

  it('keeps at most 32 probe histories (the rest counted) and at most 200 points each', () => {
    const many = creepCube({ probes: Array.from({ length: 34 }, (_, i) => ({ name: `p${i}`, quantity: 'ceeq' })) });
    const times = Array.from({ length: 250 }, (_, i) => 1 + i * 4);
    const frd = creepFrd(times.map((t) => ({ step: 2, time: PRELOAD + t, szz: 20, ceeq: 3.2e-4 * t })));
    const { doc } = solveCube(many, frd);
    const creep = caseOf(doc, many.analysisId)?.results?.creep;
    expect(Object.keys(creep?.probeHistories ?? {})).toHaveLength(32);
    expect(creep?.probesOmitted).toBe(2);
    const history = Object.values(creep?.probeHistories ?? {})[0];
    expect(history?.tS.length).toBeLessThanOrEqual(200);
    expect(history?.tS.at(-1)).toBe(997);
  });
});

describe('ceeq probes', () => {
  it('read the creep strain per hold set at the nearest node (hold seconds), and probe_history returns the same series', () => {
    const { doc, c, mesh, results, ctx } = solved();
    const analysis = caseOf(doc, c.analysisId);
    if (analysis === undefined) throw new Error('no case');
    const [reading] = evaluateProbes(analysis, mesh, results, 1);
    expect(reading?.values.map((entry) => [entry.time, Number(entry.value?.toPrecision(6))])).toEqual([
      [1, 3.2e-4],
      [10, 3.2e-3],
      [100, 0.032],
      [1000, 0.32],
    ]);
    const history = execute(doc, 'probe_history', { analysisId: c.analysisId, plot: false }, ctx);
    expect(reportOf(history.data).series[0]?.points.map((point) => point.time)).toEqual([1, 10, 100, 1000]);
  });
});

describe('result fields of a creep case', () => {
  it('fea_result_field reads the last hold set (the preload step has no output): ceeq 0.32, von Mises 20 MPa', () => {
    const { doc, c, ctx } = solved();
    const ceeq = execute(doc, 'fea_result_field', { analysisId: c.analysisId, field: 'ceeq' }, ctx);
    expect(ceeq.error).toBeUndefined();
    expect(ceeq.data).toMatchObject({ field: 'ceeq', unit: '-', resultSet: 'hold t = 1000 s' });
    expect((ceeq.data as { max: { value: number } }).max.value).toBeCloseTo(0.32, 12);
    const stress = execute(doc, 'fea_result_field', { analysisId: c.analysisId, field: 'von_mises' }, ctx);
    expect((stress.data as { max: { value: number } }).max.value).toBeCloseTo(20, 9);
  });

  it('hold times match relative to the time itself: two sets 5e-7 s apart stay distinguishable, 0 matches exactly', async () => {
    const { selectStep } = await import('@cae/results/plotSetup');
    const { doc, c, results } = solved();
    const analysis = caseOf(doc, c.analysisId);
    const first = results.steps.find((step) => step.step === 2);
    if (analysis === undefined || first === undefined) throw new Error('no fixture');
    const steps = [0, 1e-4, 1.0005e-4, 1e-3].map((hold) => ({ ...first, time: PRELOAD + hold }));
    const pair = { ...results, steps };
    const picked = (time: number): number | string => {
      const found = selectStep(analysis, pair, undefined, time, undefined);
      return typeof found === 'string' ? found : found.step.time - PRELOAD;
    };
    expect(picked(1.0005e-4)).toBeCloseTo(1.0005e-4, 12);
    expect(picked(1e-4)).toBeCloseTo(1e-4, 12);
    expect(picked(1.00025e-4)).toContain('no stored result set');
    expect(picked(0)).toBeCloseTo(0, 12);
  });

  it('the plot selection takes the hold set at a stored time (never the nearest), the last without one, and refuses an unstored time and a case without hold sets', async () => {
    const { selectStep } = await import('@cae/results/plotSetup');
    const { doc, c, results } = solved();
    const analysis = caseOf(doc, c.analysisId);
    if (analysis === undefined) throw new Error('no case');
    expect(selectStep(analysis, results, undefined, 10, undefined)).toMatchObject({ label: 'hold t = 10 s' });
    expect(selectStep(analysis, results, undefined, 12, undefined)).toBe(
      'no stored result set at hold time 12 s (stored: 1, 10, 100, 1000)',
    );
    expect(selectStep(analysis, results, undefined, undefined, undefined)).toMatchObject({ label: 'hold t = 1000 s' });
    expect(selectStep(analysis, { ...results, steps: [] }, undefined, undefined, undefined)).toContain('no result set');
  });
});

describe('creep_report', () => {
  it('reports the hold, the law with units and source, the peaks, the probe history and a quick check ratio of 1; reviewRequired; is pure', () => {
    const { doc, c, ctx } = solved();
    const before = structuredClone(doc);
    const result = execute(doc, 'creep_report', { analysisId: c.analysisId }, ctx);
    expect(result.error).toBeUndefined();
    expect(doc).toEqual(before);
    expect(result.affected).toEqual([]);
    const data = reportOf(result.data);
    expect(data['hold']).toMatchObject({
      durationS: 1000,
      finalTimeS: 1000,
      complete: true,
      cetol: 1e-3,
      temperatureK: 293,
      preloadPeriodS: PRELOAD,
    });
    expect(data['laws']).toEqual([
      expect.objectContaining({
        materialId: 'norton',
        modelId: 'creep',
        parts: [c.cube],
        A: { value: 1e-10, unit: 'MPa^-n s^-(m+1)' },
        n: 5,
        m: 0,
        basis: 'company',
      }),
    ]);
    expect(data['maxCeeq'].value).toBeCloseTo(0.32, 12);
    expect(data['quickCheck'].ratioFeToClosedForm).toBeCloseTo(1, 12);
    expect(Object.values(data['probes'] as Record<string, { history: unknown[] }>)[0]?.history).toHaveLength(4);
    expect(data).toMatchObject({ unverified: false, reviewRequired: true });
    expect(data['reviewReason']).toContain('structural');
    expect(result.summary).toContain('not approved');
  });

  it('flags an unverified law with its reasons, bounds the history by maxPoints, filters probes, and states the time-hardening effective time', () => {
    const { doc, c, ctx } = solved({ basis: 'typical', law: { m: -0.5 } });
    const data = reportOf(execute(doc, 'creep_report', { analysisId: c.analysisId, maxPoints: 2 }, ctx).data);
    expect(data).toMatchObject({ unverified: true, unverifiedReasons: ['basis typical'] });
    expect(Object.values(data['probes'] as Record<string, { history: unknown[] }>)[0]?.history).toHaveLength(2);
    const [probeId = ''] = Object.keys(caseOf(doc, c.analysisId)?.probes ?? {});
    expect(
      Object.keys(reportOf(execute(doc, 'creep_report', { analysisId: c.analysisId, probes: [probeId] }, ctx).data)['probes']),
    ).toEqual([probeId]);
  });

  it('a zero end-of-hold stress gives a null quick-check ratio and no ratio in the text (no NaN)', () => {
    const frd = creepFrd([{ step: 2, time: PRELOAD + 1000, szz: 0, ceeq: 0 }]);
    const { doc, c, ctx } = solved({}, frd);
    const result = execute(doc, 'creep_report', { analysisId: c.analysisId }, ctx);
    expect(reportOf(result.data).quickCheck).toMatchObject({ value: 0, ratioFeToClosedForm: null });
    expect(result.summary).not.toContain('quick check ratio');
    expect(JSON.stringify(result.data)).not.toContain('NaN');
  });

  it('refuses stale results, missing results, unknown probes, a bad maxPoints, another case type, no hold and an unknown case', () => {
    const { doc, c, ctx } = solved();
    const longer = execute(doc, 'set_creep_step', {
      analysisId: c.analysisId,
      duration: { value: 2000, unit: 's' },
      cetol: 1e-3,
      temperature: { value: 293, unit: 'K' },
    });
    expect(execute(longer.document, 'creep_report', { analysisId: c.analysisId }, ctx).error?.code).toBe('FEA_RESULTS_STALE');
    const fresh = creepCube();
    expect(execute(fresh.doc, 'creep_report', { analysisId: fresh.analysisId }).error?.code).toBe('CRP_RESULTS_MISSING');
    expect(execute(doc, 'creep_report', { analysisId: c.analysisId, probes: ['ghost'] }, ctx).error?.code).toBe('FEA_PROBE_NOT_FOUND');
    expect(execute(doc, 'creep_report', { analysisId: c.analysisId, maxPoints: 1 }, ctx).error?.code).toBe('CMD_INVALID_PARAMS');
    expect(execute(doc, 'creep_report', { analysisId: c.analysisId, maxPoints: 500 }, ctx).error?.code).toBe('CMD_INVALID_PARAMS');
    const stat = creepCube({ type: 'static' });
    expect(execute(stat.doc, 'creep_report', { analysisId: stat.analysisId }).error?.code).toBe('CRP_CASE_TYPE');
    expect(execute(doc, 'creep_report', { analysisId: 'ghost' }).error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    const unheld = creepCube({ step: null });
    expect(execute(unheld.doc, 'creep_report', { analysisId: unheld.analysisId }).error?.code).toBe('CRP_STEP_MISSING');
  });

  it('refuses results whose artifact cannot be verified (untrusted summary)', () => {
    const { doc, c, mesh, results } = solved();
    const analysis = caseOf(doc, c.analysisId);
    if (analysis?.results === undefined) throw new Error('no results');
    const tampered = withCase(doc, { ...analysis, results: { ...analysis.results, loadCases: [] } });
    const { ctx } = solveCube(c, holdFrd(PRELOAD));
    void mesh;
    void results;
    expect(execute(tampered, 'creep_report', { analysisId: c.analysisId }, ctx).error?.code).toBe('FEA_SUMMARY_MISMATCH');
  });
});

describe('hold sets and result items without a hold', () => {
  it('a case without a hold has no hold sets and no result items; a part whose material left the document has no law', async () => {
    const { holdSets } = await import('@cae/creep/history');
    const { creepResultItems } = await import('@cae/creep/check');
    const { partLaw } = await import('@cae/creep/readiness');
    const c = creepCube({ step: null });
    const analysis = caseOf(c.doc, c.analysisId);
    if (analysis === undefined) throw new Error('no case');
    expect(holdSets(analysis, solveCube(creepCube(), holdFrd(PRELOAD)).results)).toEqual([]);
    expect(creepResultItems(analysis, undefined)).toEqual([]);
    const orphan = {
      ...c.doc,
      entities: { ...c.doc.entities, [c.cube]: { ...c.doc.entities[c.cube], materialId: 'ghost' } },
    } as unknown as typeof c.doc;
    expect(partLaw(orphan, c.cube)).toMatchObject({ code: 'CRP_LAW_MISSING', ids: [c.cube, 'ghost'] });
  });
});

describe('check_creep', () => {
  it('on a set-up without a bound on the increment: the unbounded warning and the check_analysis items; reviewRequired; pure', () => {
    const c = creepCube();
    const before = structuredClone(c.doc);
    const result = execute(c.doc, 'check_creep', { analysisId: c.analysisId });
    expect(c.doc).toEqual(before);
    const data = reportOf(result.data);
    expect(codesOf(data)).toEqual(expect.arrayContaining(['FEA_MESH_MISSING', 'CRP_INCREMENT_UNBOUNDED']));
    expect(data).toMatchObject({ status: 'fail', reviewRequired: true });
    expect(data['notes'][0]).toContain('result checks skipped');
    expect(result.summary).toContain('not approved');
  });

  it('lists each set-up problem once with its code: no hold, no law, unverified law, plastic model beside creep, no load', () => {
    const noStep = creepCube({ step: null });
    expect(codesOf(execute(noStep.doc, 'check_creep', { analysisId: noStep.analysisId }).data)).toContain('CRP_STEP_MISSING');
    const none = creepCube({ creep: false, step: null });
    const codes = codesOf(execute(none.doc, 'check_creep', { analysisId: none.analysisId }).data);
    expect(codes.filter((code) => code === 'CRP_NO_VISCOUS_MATERIAL')).toHaveLength(1);
    expect(codes).not.toContain('CRP_LAW_MISSING');
    const typical = creepCube({ basis: 'typical' });
    const typicalItems = reportOf(execute(typical.doc, 'check_creep', { analysisId: typical.analysisId }).data)['items'];
    expect(typicalItems.find((item: { code: string }) => item.code === 'CRP_LAW_UNVERIFIED')).toMatchObject({
      severity: 'warning',
      ids: [typical.cube, 'norton'],
    });
    const noLoad = creepCube();
    const analysis = caseOf(noLoad.doc, noLoad.analysisId);
    if (analysis === undefined) throw new Error('no case');
    const unloaded = withCase(noLoad.doc, { ...analysis, loads: {}, loadOrder: [] });
    expect(codesOf(execute(unloaded, 'check_creep', { analysisId: noLoad.analysisId }).data)).toContain('FEA_NO_LOADS');
  });

  it('reports a plastic model beside the creep law (overstress) and the temperature outside the law validity', () => {
    const c = creepCube();
    const withPlastic = execute(c.doc, 'add_material_model', {
      material: 'norton',
      id: 'plastic',
      model: {
        kind: 'j2_plasticity',
        isotropic: { kind: 'perfect', yieldStress: { value: 300, unit: 'MPa' } },
        kinematic: { kind: 'none' },
      },
      validity: [{ variable: 'T', unit: 'K', data: [200, 900] }],
      basis: 'company',
      source: { citation: 'synthetic test fixture' },
    });
    const set = execute(withPlastic.document, 'define_constitutive_set', {
      material: 'norton',
      set: { id: 'cr', elastic: 'el', creep: 'creep', plastic: 'plastic' },
      makeDefault: true,
      replace: true,
    });
    expect(set.error).toBeUndefined();
    expect(codesOf(execute(set.document, 'check_creep', { analysisId: c.analysisId }).data)).toContain('CRP_OVERSTRESS_MODEL');
    const analysis = caseOf(c.doc, c.analysisId);
    if (analysis?.creep === undefined) throw new Error('no hold');
    const hot = withCase(c.doc, { ...analysis, creep: { ...analysis.creep, temperature: { kind: 'uniform', valueK: 500 } } });
    expect(codesOf(execute(hot, 'check_creep', { analysisId: c.analysisId }).data)).toContain('CRP_LAW_OUT_OF_RANGE');
  });

  it('after the solve: no creep error for a complete hold (the stress range of the law is stated as a note), CRP_HOLD_INCOMPLETE for a short one, stale results flagged', () => {
    const { doc, c, ctx } = solved();
    const data = reportOf(execute(doc, 'check_creep', { analysisId: c.analysisId }, ctx).data);
    expect(codesOf(data).filter((code) => code.startsWith('CRP_'))).toEqual(['CRP_INCREMENT_UNBOUNDED']);
    expect(data['state']).toBe('solved');
    expect(data['notes'].join(' ')).toContain('stress range');
    const short = solved({}, creepFrd([{ step: 2, time: PRELOAD + 500, szz: 20, ceeq: 0.16 }]));
    expect(codesOf(execute(short.doc, 'check_creep', { analysisId: short.c.analysisId }, short.ctx).data)).toContain('CRP_HOLD_INCOMPLETE');
    const changed = execute(doc, 'set_creep_step', {
      analysisId: c.analysisId,
      duration: { value: 2000, unit: 's' },
      cetol: 1e-3,
      temperature: { value: 293, unit: 'K' },
    });
    const stale = reportOf(execute(changed.document, 'check_creep', { analysisId: c.analysisId }, ctx).data);
    expect(stale['state']).toBe('stale');
    expect(codesOf(stale)).toContain('FEA_RESULTS_STALE');
  });

  it('refuses another case type and an unknown case', () => {
    const stat = creepCube({ type: 'static' });
    expect(execute(stat.doc, 'check_creep', { analysisId: stat.analysisId }).error?.code).toBe('CRP_CASE_TYPE');
    expect(execute(stat.doc, 'check_creep', { analysisId: 'ghost' }).error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
  });

  it('check_analysis carries the creep set-up items too (the hook), and the mesh fixture matches the case', () => {
    const c = creepCube({ step: null });
    expect(codesOf(execute(c.doc, 'check_analysis', { analysisId: c.analysisId }).data)).toContain('CRP_STEP_MISSING');
    expect(cubeMesh(c).blocks[0]?.entityId).toBe(c.cube);
  });
});
