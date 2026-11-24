/** 12 CFD M3c: cfd_report states whether the grid study still describes the case and the flow surface (the Flow panel only displays it). */
import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { ok } from './fixtures';
import { recordedGridStudy } from './studyFixtures';

type StudyReport = { study?: { stale: boolean; staleReasons: string[] } };
const studyOf = (document: CadDocument, ctx: ExecutionContext): StudyReport['study'] =>
  (ok(document, 'cfd_report', { caseId: 'c1' }, ctx).data as StudyReport).study;

describe.each([
  ['without a kernel', null],
  ['with the Manifold kernel', 'manifold'],
] as const)('cfd_report study %s', (_name, which) => {
  let kernel: GeometryKernel | null = null;
  let doc: CadDocument;
  let ctx: ExecutionContext;
  beforeAll(async () => {
    kernel = which === null ? null : await createManifoldKernel();
    ({ doc, ctx } = recordedGridStudy(kernel));
  });

  it('reports a study as not stale right after it was recorded', () => {
    expect(studyOf(doc, ctx)).toEqual({ stale: false, staleReasons: [] });
  });

  it('reports no study member when the case has none', () => {
    const slice = doc.cfd;
    if (slice === undefined) throw new Error('fixture has no cfd slice');
    const { studies: _studies, ...withoutStudies } = slice;
    expect(studyOf({ ...doc, cfd: withoutStudies }, ctx)).toBeUndefined();
  });

  it('reports the study stale with the reason when the case changed', () => {
    const changed = ok(doc, 'update_cfd_case', { caseId: 'c1', freestream: { speedMS: 3, alphaDeg: 0 } }).document;
    const study = studyOf(changed, ctx);
    expect(study?.stale).toBe(true);
    expect(study?.staleReasons.join(' ')).toContain('case changed');
  });

  it('reports the study stale when only the geometry moved (the case hash alone would not show it)', () => {
    const ballId = Object.keys(doc.entities)[0] as string;
    const moved = ok(doc, 'move_entities', { ids: [ballId], delta: [0.5, 0, 0] }, ctx).document;
    const study = studyOf(moved, ctx);
    expect(study?.stale).toBe(true);
    expect(study?.staleReasons.join(' ')).toContain('flow surface');
  });

  it('is read-only: the document is returned as is and not changed, also for a refusal', () => {
    const before = structuredClone(doc);
    const report = execute(doc, 'cfd_report', { caseId: 'c1' }, ctx);
    expect(report.rejected).toBeUndefined();
    expect(report.document).toBe(doc);
    expect(doc).toEqual(before);
    const refused = execute(doc, 'cfd_report', { caseId: 'zz' }, ctx);
    expect(refused.error?.code).toBe('CFD_CASE_NOT_FOUND');
    expect(refused.document).toBe(doc);
  });
});
