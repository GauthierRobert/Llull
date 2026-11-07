/** Studies in the document: save / load round trip, load validation, replay of the recorded step (L8), the slice seed of the plugin fuzz. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { recordedStudy, studyBar } from './studyFixtures';

const bar = studyBar();
const { doc, studyId } = recordedStudy(bar);

/** The saved document with `edit` applied to its (raw JSON) study, loaded through load_document. */
function loadEdited(edit: (study: Record<string, unknown>, analysisCase: Record<string, unknown>) => void): ReturnType<typeof execute> {
  const file = JSON.parse(serializeDocument(doc)) as { document: { analysis: { cases: Record<string, Record<string, unknown>> } } };
  const analysisCase = file.document.analysis.cases[bar.analysisId] as Record<string, unknown>;
  const studies = analysisCase['studies'] as Record<string, Record<string, unknown>>;
  edit(studies[studyId] as Record<string, unknown>, analysisCase);
  return execute(createEmptyDocument(), 'load_document', { json: JSON.stringify(file) });
}

const REFUSAL = /document contains invalid values/;

describe('studies in a saved document', () => {
  it('round-trips and still verifies after a load', () => {
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.analysis?.cases[bar.analysisId]?.studies).toEqual(doc.analysis?.cases[bar.analysisId]?.studies);
    expect(serializeDocument(loaded)).toBe(serializeDocument(doc));
    const data = execute(loaded, 'check_verification', { analysisId: bar.analysisId }, bar.ctx).data as { studies: { state: string }[] };
    expect(data.studies[0]?.state).toBe('current');
  });

  it('load_document refuses malformed studies by name', () => {
    const cases: [string, (study: Record<string, unknown>, analysisCase: Record<string, unknown>) => void, RegExp][] = [
      ['two levels', (study) => (study['levels'] = (study['levels'] as unknown[]).slice(0, 2)), /levels must hold 3 to 6/],
      ['h not increasing', (study) => ((study['levels'] as Record<string, unknown>[])[1]!['h'] = 0), /levels\[1\]\.h/],
      ['level index', (study) => ((study['levels'] as Record<string, unknown>[])[2]!['index'] = 7), /levels\[2\]\.index/],
      ['hash', (study) => ((study['levels'] as Record<string, unknown>[])[0]!['meshHash'] = 'xyz'), /meshHash/],
      ['value', (study) => ((study['levels'] as Record<string, unknown>[])[0]!['value'] = 'x'), /levels\[0\]\.value/],
      ['controls', (study) => ((study['levels'] as Record<string, unknown>[])[0]!['controls'] = {}), /controls is malformed/],
      ['elements', (study) => ((study['levels'] as Record<string, unknown>[])[0]!['elements'] = 0), /elements/],
      ['analysisId', (study) => (study['analysisId'] = 'an-9.9'), /analysisId must be/],
      ['quantity kind', (study) => (study['quantity'] = { kind: 'torque' }), /quantity has an unknown kind/],
      ['quantity fields', (study) => (study['quantity'] = { kind: 'frequency', mode: 0 }), /needs a mode/],
      ['unit', (study) => (study['unit'] = ''), /unit must be text/],
      ['refinement', (study) => (study['refinement'] = 'p'), /refinement/],
      ['ratio', (study) => (study['ratio'] = 1), /ratio must be > 1/],
      ['measure', (study) => (study['measure'] = { value: 0, dimension: 3 }), /measure is malformed/],
      ['safety factor', (study) => (study['safetyFactor'] = { value: -1, source: 's', defaulted: true }), /safetyFactor/],
      ['formal order', (study) => (study['formalOrder'] = { value: 2 }), /formalOrder/],
      ['verified flag', (study) => (study['verified'] = true), /verified must be false/],
      ['exception', (study) => (study['exception'] = { code: 'VNV_NOT_ASYMPTOTIC' }), /exception needs/],
      ['exception shape', (study) => (study['exception'] = 'accepted'), /exception is malformed/],
      ['order list', (_study, analysisCase) => (analysisCase['studyOrder'] = []), /missing from studyOrder/],
      ['dangling order', (_study, analysisCase) => (analysisCase['studyOrder'] = [studyId, 'cs-9.9']), /listed but missing/],
      ['duplicate order', (_study, analysisCase) => (analysisCase['studyOrder'] = [studyId, studyId]), /duplicate ids/],
      ['no order', (_study, analysisCase) => delete analysisCase['studyOrder'], /studyOrder id list/],
      [
        'reserved id',
        (_study, analysisCase) => ((analysisCase['studies'] as Record<string, unknown>)['constructor'] = {}),
        /reserved name/,
      ],
      ['not a record', (_study, analysisCase) => (analysisCase['studies'] = []), /studyOrder id list/],
    ];
    for (const [label, edit, pattern] of cases) {
      const result = loadEdited(edit);
      expect(result.summary, label).toMatch(REFUSAL);
      expect(result.summary, label).toMatch(pattern);
    }
  });

  it('load_document accepts an unedited study and a flagged-unverified one', () => {
    expect(loadEdited(() => undefined).summary).toMatch(/^Loaded document/);
    expect(loadEdited((study) => (study['verified'] = false)).summary).toMatch(/^Loaded document/);
  });
});

describe('studies and replay (L8)', () => {
  const replay = (document: CadDocument, ctx = bar.ctx): CadDocument => execute(document, 'replay_history', {}, ctx).document;

  it('replaying the recipe with the store re-records the identical study', () => {
    const replayed = replay(doc);
    expect(JSON.stringify(replayed.analysis)).toBe(JSON.stringify(doc.analysis));
    expect(Object.keys(replayed.analysis?.cases[bar.analysisId]?.studies ?? {})).toEqual([studyId]);
  });

  it('replaying where the store is unavailable keeps the study flagged unverified', () => {
    const replayed = replay(doc, { ...bar.ctx, feaArtifacts: null });
    const study = replayed.analysis?.cases[bar.analysisId]?.studies?.[studyId];
    expect(study?.verified).toBe(false);
    expect(execute(replayed, 'check_verification', { analysisId: bar.analysisId }, { ...bar.ctx, feaArtifacts: null }).summary).toMatch(
      /0 current/,
    );
  });

  it('replaying after the geometry changed records the study stale (it is not lost)', () => {
    const scaled = execute(doc, 'scale_entity', { id: bar.boxId, factor: 2 });
    expect(scaled.rejected).not.toBe(true);
    const replayed = replay(scaled.document);
    const data = execute(replayed, 'check_verification', { analysisId: bar.analysisId }, bar.ctx).data as {
      studies: { id: string; state: string }[];
    };
    expect(data.studies.map((entry) => entry.state)).toEqual(['stale']);
  });
});
