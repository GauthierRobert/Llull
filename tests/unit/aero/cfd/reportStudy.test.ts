/** 12 CFD M3c: cfd_report states whether the grid study still describes the case and the flow surface (the Flow panel only displays it). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { ok } from './fixtures';
import { recordedGridStudy } from './studyFixtures';

const { doc, ctx } = recordedGridStudy();
const studyOf = (document = doc): { stale: boolean; staleReasons: string[] } | undefined =>
  (ok(document, 'cfd_report', { caseId: 'c1' }, ctx).data as { study?: { stale: boolean; staleReasons: string[] } }).study;

describe('cfd_report study', () => {
  it('reports a current study as not stale', () => {
    expect(studyOf()).toEqual({ stale: false, staleReasons: [] });
  });

  it('reports no study member when the case has none', () => {
    const slice = doc.cfd;
    if (slice === undefined) throw new Error('fixture has no cfd slice');
    const { studies: _studies, ...withoutStudies } = slice;
    expect(studyOf({ ...doc, cfd: withoutStudies })).toBeUndefined();
  });

  it('reports the study stale with the reason when the case changed', () => {
    const changed = ok(doc, 'update_cfd_case', { caseId: 'c1', freestream: { speedMS: 3, alphaDeg: 0 } }).document;
    const study = studyOf(changed);
    expect(study?.stale).toBe(true);
    expect(study?.staleReasons.join(' ')).toContain('case changed');
  });

  it('reports the study stale when only the geometry moved (the case hash alone would not show it)', () => {
    const ballId = Object.keys(doc.entities)[0] as string;
    const moved = ok(doc, 'move_entities', { ids: [ballId], delta: [0.5, 0, 0] }).document;
    const study = studyOf(moved);
    expect(study?.stale).toBe(true);
    expect(study?.staleReasons.join(' ')).toContain('flow surface');
  });

  it('is read-only and refuses a case without a result as before', () => {
    const result = execute(doc, 'cfd_report', { caseId: 'zz' }, ctx);
    expect(result.error?.code).toBe('CFD_CASE_NOT_FOUND');
    expect(result.document).toBe(doc);
  });
});
