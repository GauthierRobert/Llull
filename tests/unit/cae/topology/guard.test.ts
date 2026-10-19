/** Derivation guard, document extension and plan replay of the topology plugin (TOP_DERIVED_READ_ONLY, VC-TOP-20, L8). */
import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { derivedEntityIds } from '@core/plugins/host';
import { pluginToolNames } from '@core/plugins/host';
import { code, contextWith, data, mbbModel, readPlan, solveAndRecord, studyOf } from './support';

describe('derivation guard', () => {
  const model = mbbModel();
  const solved = solveAndRecord(model);
  const derivedId = studyOf(solved.doc, model.analysisId, model.studyId).derivedEntityId ?? '';

  it('reports the iso-surface as derived geometry', () => {
    expect(derivedEntityIds(solved.doc)).toEqual(new Set([derivedId]));
    expect(derivedEntityIds(model.doc).size).toBe(0);
  });

  it.each([
    ['move_entities', { ids: [derivedId], delta: [1, 0, 0] }],
    ['delete_entities', { ids: [derivedId] }],
    ['scale_entity', { id: derivedId, factor: 2 }],
    ['set_entity_name', { id: derivedId, name: 'mine' }],
  ])('refuses %s on the iso-surface (VC-TOP-20)', (name, params) => {
    const result = execute(solved.doc, name, params);
    expect(result.summary).toContain('TOP_DERIVED_READ_ONLY');
    expect(result.document).toBe(solved.doc);
    expect(result.affected).toEqual([]);
  });

  it('lets other entities change and the study be deleted with its surface', () => {
    const moved = execute(solved.doc, 'move_entities', { ids: [model.entityId], delta: [0, 0, 0] });
    expect(moved.summary).not.toContain('TOP_DERIVED_READ_ONLY');
    const removed = execute(solved.doc, 'delete_topology_study', { studyId: model.studyId });
    expect(removed.rejected).toBeUndefined();
    expect(removed.document.entities[derivedId]).toBeUndefined();
  });

  it('refuses to delete the analysis while its iso-surface would be orphaned', () => {
    const result = execute(solved.doc, 'delete_analysis', { analysisId: model.analysisId });
    expect(result.summary).toContain('TOP_DERIVED_READ_ONLY');
    expect(result.summary).toContain('delete_topology_study');
    expect(result.document).toBe(solved.doc);
    const cleared = execute(execute(solved.doc, 'delete_topology_study', { studyId: model.studyId }).document, 'delete_analysis', {
      analysisId: model.analysisId,
    });
    expect(cleared.rejected).toBeUndefined();
  });
});

describe('document extension', () => {
  const model = mbbModel();
  const solved = solveAndRecord(model);
  const derivedId = studyOf(solved.doc, model.analysisId, model.studyId).derivedEntityId ?? '';

  it('omits the derived mesh from the saved file and keeps the study and its record', () => {
    const text = serializeDocument(solved.doc);
    expect(text).not.toContain('"positions"');
    expect(serializeDocument(solved.doc, { includeDerived: true })).toContain('"positions"');
    const loaded = deserializeDocument(text);
    expect(loaded.entities[derivedId]).toBeUndefined();
    expect(studyOf(loaded, model.analysisId, model.studyId)).toEqual(studyOf(solved.doc, model.analysisId, model.studyId));
    expect(derivedEntityIds(loaded)).toEqual(new Set([derivedId]));
    const report = data(execute(loaded, 'topology_report', { studyId: model.studyId }, contextWith(solved.store.port)));
    expect(report['state']).toBe('solved');
    expect(report['derivedGeometry']).toBe('absent');
    const again = execute(
      loaded,
      'record_topology_result',
      { studyId: model.studyId, fieldHash: solved.hash },
      contextWith(solved.store.port),
    );
    expect(again.document.entities[derivedId]).toEqual(solved.doc.entities[derivedId]);
  });

  it('round-trips an unsolved study and rejects malformed topology data on load', () => {
    expect(studyOf(deserializeDocument(serializeDocument(model.doc)), model.analysisId, model.studyId)).toEqual(
      studyOf(model.doc, model.analysisId, model.studyId),
    );
    const edit = (change: (study: Record<string, unknown>, analysisCase: Record<string, unknown>) => void): Error | null => {
      const envelope = JSON.parse(serializeDocument(model.doc)) as {
        document: { analysis: { cases: Record<string, Record<string, unknown>> } };
      };
      const analysisCase = envelope.document.analysis.cases[model.analysisId] as Record<string, unknown>;
      change((analysisCase['topology'] as Record<string, Record<string, unknown>>)[model.studyId] as Record<string, unknown>, analysisCase);
      try {
        deserializeDocument(JSON.stringify(envelope));
        return null;
      } catch (error) {
        return error as Error;
      }
    };
    expect(edit(() => undefined)).toBeNull();
    for (const mutate of [
      (study: Record<string, unknown>) => (study['voxel'] = -1),
      (study: Record<string, unknown>) => (study['volumeFraction'] = 1),
      (study: Record<string, unknown>) => (study['dimension'] = 4),
      (study: Record<string, unknown>) => (study['designDomain'] = 'x'),
      (study: Record<string, unknown>) => (study['keepIn'] = 'x'),
      (study: Record<string, unknown>) => (study['settings'] = {}),
      (study: Record<string, unknown>) => (study['name'] = 3),
      (study: Record<string, unknown>) => (study['settings'] = { ...(study['settings'] as object), filter: { kind: 'x' } }),
      (_study: Record<string, unknown>, analysisCase?: Record<string, unknown>) =>
        analysisCase && (analysisCase['topologyOrder'] = ['ghost']),
      (_study: Record<string, unknown>, analysisCase?: Record<string, unknown>) => analysisCase && (analysisCase['topology'] = 5),
    ])
      expect(edit(mutate)?.message).toMatch(/topology/);
  });
});

describe('validation plans', () => {
  it('replays the MBB study set-up and the density-filter variant', () => {
    const sensitivity = mbbModel();
    expect(studyOf(sensitivity.doc, sensitivity.analysisId, sensitivity.studyId).settings.filter.kind).toBe('sensitivity');
    const density = mbbModel({}, (action) =>
      action.command === 'set_topology_settings'
        ? { ...action, params: { ...action.params, filter: { kind: 'density', radius: 1.5 } } }
        : action,
    );
    expect(studyOf(density.doc, density.analysisId, density.studyId).settings.filter.kind).toBe('density');
    expect(readPlan('top_mbb_60x20_density').find((action) => action.command === 'set_topology_settings')?.params['filter']).toEqual({
      kind: 'density',
      radius: 1.5,
    });
    const replayed = execute(sensitivity.doc, 'replay_history', {});
    expect(replayed.rejected).toBeUndefined();
    expect(studyOf(replayed.document, sensitivity.analysisId, sensitivity.studyId)).toEqual(
      studyOf(sensitivity.doc, sensitivity.analysisId, sensitivity.studyId),
    );
  });

  it('replaying a recorded result re-derives the identical iso-surface, and refuses without the store', () => {
    const model = mbbModel();
    const solved = solveAndRecord(model);
    const derivedId = studyOf(solved.doc, model.analysisId, model.studyId).derivedEntityId ?? '';
    const replayed = execute(solved.doc, 'replay_history', {}, contextWith(solved.store.port));
    expect(replayed.document.entities[derivedId]).toEqual(solved.doc.entities[derivedId]);
    expect(studyOf(replayed.document, model.analysisId, model.studyId).result).toEqual(
      studyOf(solved.doc, model.analysisId, model.studyId).result,
    );
  });

  it('registers its tools in the analysis toolset', () => {
    expect(pluginToolNames('analysis')).toEqual(
      expect.arrayContaining([
        'create_topology_study',
        'set_topology_regions',
        'set_topology_settings',
        'delete_topology_study',
        'record_topology_result',
        'topology_report',
        'suggest_rebuild',
        'compare_to_topology',
        'check_topology',
      ]),
    );
    expect(code(execute(createEmptyDocument(), 'topology_report', { studyId: 'x' }))).toBe('TOP_STUDY_NOT_FOUND');
  });
});
