/** add_time_history: node / part / rigid-wall history requests of an explicit case (PHY-19 TECHNICAL_SPEC §3, TR-EXP-10 /TH/*). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { ExplicitSpec } from '@core/model/explicit';
import type { CadDocument } from '@core/model/types';
import { explicitErrors } from '@cae/explicit/model';
import { explicitInputHash } from '@cae/explicit/hash';
import { barModel, code, must } from './support';

const bar = barModel({ size: 5 });
const specOf = (doc: CadDocument): ExplicitSpec | undefined => doc.analysis?.cases[bar.analysisId]?.explicit;
const wallParams = {
  analysisId: bar.analysisId,
  name: 'anvil_force',
  kind: 'rigid_wall',
  wallId: bar.wallId,
  quantities: ['normal_force', 'energy'],
};
const nodeParams = {
  analysisId: bar.analysisId,
  name: 'tip',
  kind: 'node',
  target: { entityId: bar.barId, facesNear: [[5, 5, 10]] },
  quantities: ['velocity', 'displacement'],
  intervalS: 2e-6,
};
const partParams = { analysisId: bar.analysisId, name: 'bar_energy', kind: 'part', partId: bar.barId, quantities: ['kinetic_energy'] };

describe('add_time_history', () => {
  it('stores node, part and wall requests purely, in order, with ids in affected[1]', () => {
    const before = structuredClone(bar.doc);
    const node = must(bar.doc, 'add_time_history', nodeParams);
    expect(bar.doc).toEqual(before);
    const part = must(node.document, 'add_time_history', partParams);
    const wall = must(part.document, 'add_time_history', wallParams);
    const spec = specOf(wall.document);
    expect(spec?.timeHistoryOrder).toEqual([node.affected[1], part.affected[1], wall.affected[1]]);
    expect(node.affected[0]).toBe(bar.analysisId);
    expect(spec?.timeHistories?.[node.affected[1] ?? '']).toEqual({
      name: 'tip',
      kind: 'node',
      target: { entityId: bar.barId, facesNear: [[5, 5, 10]] },
      quantities: ['velocity', 'displacement'],
      intervalS: 2e-6,
    });
    expect(spec?.timeHistories?.[part.affected[1] ?? '']).toEqual({
      name: 'bar_energy',
      kind: 'part',
      target: { entityId: bar.barId },
      quantities: ['kinetic_energy'],
    });
    expect(spec?.timeHistories?.[wall.affected[1] ?? '']?.intervalS).toBeUndefined();
    expect(wall.summary).toContain('at the case history interval');
    expect(wall.summary).toContain('(3/32)');
    expect(explicitErrors(JSON.parse(JSON.stringify(wall.document)) as Record<string, unknown>)).toEqual([]);
  });

  it('resolves a wall given by name to its id and stores the id', () => {
    const byName = must(bar.doc, 'add_time_history', { ...wallParams, wallId: 'anvil', quantities: ['normal_impulse'] });
    expect(specOf(byName.document)?.timeHistories?.[byName.affected[1] ?? '']?.wallId).toBe(bar.wallId);
  });

  it('makes the explicit input hash change (a run recorded before is stale)', () => {
    const added = must(bar.doc, 'add_time_history', wallParams).document;
    const hashOf = (doc: CadDocument): string => explicitInputHash(doc, doc.analysis?.cases[bar.analysisId] ?? (undefined as never));
    expect(hashOf(added)).not.toBe(hashOf(bar.doc));
  });

  it('delete_analysis_item removes a history; deleting its wall drops the wall histories only', () => {
    const node = must(bar.doc, 'add_time_history', nodeParams);
    const both = must(node.document, 'add_time_history', wallParams);
    const wallHistoryId = both.affected[1] ?? '';
    const removed = must(both.document, 'delete_analysis_item', { analysisId: bar.analysisId, itemId: wallHistoryId });
    expect(specOf(removed.document)?.timeHistoryOrder).toEqual([node.affected[1]]);
    expect(Object.keys(specOf(removed.document)?.timeHistories ?? {})).toEqual([node.affected[1]]);
    const walled = must(both.document, 'delete_analysis_item', { analysisId: bar.analysisId, itemId: bar.wallId });
    expect(specOf(walled.document)?.timeHistoryOrder).toEqual([node.affected[1]]);
    expect(Object.keys(specOf(walled.document)?.timeHistories ?? {})).toEqual([node.affected[1]]);
    expect(specOf(walled.document)?.rigidWallOrder).toEqual([]);
  });

  describe('refusals leave the document unchanged', () => {
    const refused = (overrides: Record<string, unknown>, base: Record<string, unknown> = wallParams): string | undefined => {
      const result = execute(bar.doc, 'add_time_history', { ...base, ...overrides });
      expect(result.document).toBe(bar.doc);
      expect(result.affected).toEqual([]);
      return code(result);
    };

    it('unknown case, wrong type, no controls', () => {
      expect(refused({ analysisId: 'nope' })).toBe('FEA_ANALYSIS_NOT_FOUND');
      const fresh = must(bar.doc, 'create_analysis', { name: 'fresh', analysisType: 'explicit_dynamics' });
      expect(code(execute(fresh.document, 'add_time_history', { ...wallParams, analysisId: fresh.affected[0] }))).toBe(
        'EXP_CONTROLS_MISSING',
      );
      const modal = must(bar.doc, 'create_analysis', { name: 'static', analysisType: 'static' });
      expect(code(execute(modal.document, 'add_time_history', { ...wallParams, analysisId: modal.affected[0] }))).toBe('EXP_CASE_TYPE');
    });

    it('quantities of another kind, repeats, bad interval', () => {
      expect(refused({ quantities: ['velocity'] })).toBe('EXP_TIME_HISTORY_INVALID');
      expect(refused({ quantities: ['energy', 'energy'] })).toBe('EXP_TIME_HISTORY_INVALID');
      expect(refused({ intervalS: 0 })).toBe('EXP_TIME_HISTORY_INVALID');
      expect(refused({ intervalS: 1 })).toBe('EXP_TIME_HISTORY_INVALID');
      expect(refused({ quantities: [] })).toBe('CMD_INVALID_PARAMS');
    });

    it('target / partId / wallId missing, extra or unresolved', () => {
      expect(refused({ wallId: undefined })).toBe('EXP_TIME_HISTORY_INVALID');
      expect(refused({ wallId: 'rw-9.9' })).toBe('EXP_RIGID_WALL_NOT_FOUND');
      expect(refused({ partId: bar.barId })).toBe('EXP_TIME_HISTORY_INVALID');
      expect(refused({ partId: undefined }, partParams)).toBe('EXP_TIME_HISTORY_INVALID');
      expect(refused({ partId: 'ghost' }, partParams)).toBe('EXP_TARGET_NOT_IN_CASE');
      expect(refused({ target: undefined }, nodeParams)).toBe('EXP_TIME_HISTORY_INVALID');
      expect(refused({ target: { entityId: bar.barId } }, nodeParams)).toBe('FEA_TARGET_UNRESOLVED');
      expect(refused({ target: { entityId: 'ghost', pointsNear: [[0, 0, 0]] } }, nodeParams)).toBe('FEA_TARGET_UNRESOLVED');
      expect(refused({ target: { entityId: bar.barId, edgesNear: [[0, 0, 0]] } }, nodeParams)).toBe('EXP_TIME_HISTORY_INVALID');
    });

    it('duplicate name and the 33rd history', () => {
      const once = must(bar.doc, 'add_time_history', wallParams).document;
      expect(code(execute(once, 'add_time_history', wallParams))).toBe('EXP_TIME_HISTORY_INVALID');
      let full = bar.doc;
      for (let k = 0; k < 32; k += 1) full = must(full, 'add_time_history', { ...wallParams, name: `h${k}` }).document;
      const over = execute(full, 'add_time_history', { ...wallParams, name: 'one_more' });
      expect(code(over)).toBe('EXP_TIME_HISTORY_INVALID');
      expect(over.summary).toContain('32');
    });
  });

  it('caps the samples of a series and of the controls at 100 000 intervals', () => {
    // end time 1.6e-4 s: 1e-9 s gives 160 000 intervals, 2e-9 s gives 80 000
    expect(code(execute(bar.doc, 'add_time_history', { ...wallParams, intervalS: 1e-9 }))).toBe('EXP_TIME_HISTORY_INVALID');
    expect(specOf(must(bar.doc, 'add_time_history', { ...wallParams, intervalS: 2e-9 }).document)?.timeHistoryOrder).toHaveLength(1);
    const controls = { analysisId: bar.analysisId, endTime: { value: 1, unit: 's' }, mesh: { kind: 'structured_hex', size: 5 } };
    expect(code(execute(bar.doc, 'set_explicit_controls', { ...controls, historyInterval: { value: 5e-6, unit: 's' } }))).toBe(
      'EXP_TIME_INVALID',
    );
    expect(code(execute(bar.doc, 'set_explicit_controls', { ...controls, historyInterval: { value: 1e-5, unit: 's' } }))).toBeUndefined();
    // a history without its own interval follows the case interval: lowering the cap through a long end time refuses it
    const long = must(bar.doc, 'set_explicit_controls', { ...controls, historyInterval: { value: 1e-5, unit: 's' } }).document;
    expect(code(execute(long, 'add_time_history', { ...wallParams, intervalS: 5e-6 }))).toBe('EXP_TIME_HISTORY_INVALID');
  });

  it('deletes a history once: the second delete refuses and changes nothing', () => {
    const added = must(bar.doc, 'add_time_history', wallParams);
    const params = { analysisId: bar.analysisId, itemId: added.affected[1] ?? '' };
    const removed = must(added.document, 'delete_analysis_item', params);
    const again = execute(removed.document, 'delete_analysis_item', params);
    expect(code(again)).toBe('FEA_ITEM_NOT_FOUND');
    expect(again.document).toBe(removed.document);
    expect(specOf(removed.document)?.timeHistoryOrder).toEqual([]);
  });

  it('rejects malformed histories on load (slice validation)', () => {
    const raw = JSON.parse(JSON.stringify(must(bar.doc, 'add_time_history', wallParams).document)) as {
      analysis: { cases: Record<string, { explicit: Record<string, unknown> }> };
    };
    const spec = raw.analysis.cases[bar.analysisId]?.explicit ?? {};
    expect(explicitErrors(raw as unknown as Record<string, unknown>)).toEqual([]);
    const histories = spec['timeHistories'] as Record<string, Record<string, unknown>>;
    const [id = ''] = Object.keys(histories);
    const mutate = (change: (entry: Record<string, unknown>) => void): string[] => {
      const copy = structuredClone(raw);
      const entry = (copy.analysis.cases[bar.analysisId]?.explicit['timeHistories'] as Record<string, Record<string, unknown>>)[id];
      if (entry !== undefined) change(entry);
      return explicitErrors(copy as unknown as Record<string, unknown>);
    };
    expect(mutate((entry) => (entry['kind'] = 'bogus'))).toHaveLength(1);
    expect(mutate((entry) => (entry['quantities'] = ['velocity']))).toHaveLength(1);
    expect(mutate((entry) => (entry['quantities'] = []))).toHaveLength(1);
    expect(mutate((entry) => (entry['intervalS'] = -1))).toHaveLength(1);
    expect(mutate((entry) => delete entry['wallId'])).toHaveLength(1);
    expect(mutate((entry) => (entry['name'] = 3))).toHaveLength(1);
    expect(mutate((entry) => (entry['intervalS'] = 1))).toHaveLength(1);
    expect(mutate((entry) => (entry['intervalS'] = 1e-9))).toHaveLength(1);
    expect(mutate((entry) => (entry['quantities'] = ['energy', 'energy']))).toHaveLength(1);
    expect(mutate((entry) => (entry['wallId'] = 'rw-404'))).toHaveLength(1);
    const twins = structuredClone(raw);
    const twinSpec = twins.analysis.cases[bar.analysisId]?.explicit ?? {};
    const twinHistories = twinSpec['timeHistories'] as Record<string, Record<string, unknown>>;
    twinHistories['th-copy'] = { ...(twinHistories[id] ?? {}) };
    twinSpec['timeHistoryOrder'] = [id, 'th-copy'];
    expect(explicitErrors(twins as unknown as Record<string, unknown>)).toHaveLength(1);
    const capped = structuredClone(raw);
    const cappedSpec = capped.analysis.cases[bar.analysisId]?.explicit ?? {};
    cappedSpec['historyIntervalS'] = 1e-9;
    expect(explicitErrors(capped as unknown as Record<string, unknown>)).toHaveLength(1);
    const orderless = structuredClone(raw);
    delete orderless.analysis.cases[bar.analysisId]?.explicit['timeHistoryOrder'];
    expect(explicitErrors(orderless as unknown as Record<string, unknown>)).toHaveLength(1);
    const nodeRaw = JSON.parse(JSON.stringify(must(bar.doc, 'add_time_history', nodeParams).document)) as typeof raw;
    const nodeEntry = Object.values(
      nodeRaw.analysis.cases[bar.analysisId]?.explicit['timeHistories'] as Record<string, Record<string, unknown>>,
    )[0];
    if (nodeEntry !== undefined) delete nodeEntry['target'];
    expect(explicitErrors(nodeRaw as unknown as Record<string, unknown>)).toHaveLength(1);
  });
});
