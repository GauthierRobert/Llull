/** 12 CFD M5 (first slice): `record_cfd_grid_study` - GCI of three recorded solves, trust and refusal ladder, purity, document validation. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { ExecutionContext, CommandResult } from '@core/commands/types';
import type { CfdResultPort } from '@core/model/cfdResult';
import type { CfdCase, CfdGridStudy } from '@aero/cfd/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { gciTriplet } from '@lib/convergence';
import { cfdDocument } from '@aero/cfd/document';
import { caseHashOf } from '@aero/cfd/caseDoc';
import { expectPure } from '../../../helpers/expectNoOp';
import { ok } from './fixtures';
import { recordedSphere } from './resultFixtures';
import { portOf, studyLevel, type StudyLevel } from './studyFixtures';

const recorded = recordedSphere();
const Q = 2;
const AREA = 0.7853981634;

const level = studyLevel;
const contextOf = (levels: readonly StudyLevel[]): ExecutionContext => ({ ...recorded.ctx, cfdResults: portOf(levels) });

// f = f0 + a h^2 on h = 0.05, 0.1, 0.2: second order, extrapolated drag 0.5 N
const drag = (h: number): number => 0.5 + 4 * h * h;
const fine = level(0.05, drag(0.05));
const medium = level(0.1, drag(0.1));
const coarse = level(0.2, drag(0.2));
const ctx = contextOf([fine, medium, coarse]);
const hashes = [coarse.hash, fine.hash, medium.hash];
const study = (doc = recorded.doc, params: Record<string, unknown> = {}, context = ctx): CommandResult =>
  execute(doc, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes, ...params }, context);

describe('record_cfd_grid_study', () => {
  it('recovers the order, the extrapolated coefficient and the GCI of a second-order triplet, sorted finest first', () => {
    expectPure(recorded.doc, () => study());
    const result = ok(recorded.doc, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes }, ctx);
    expect(result.affected).toEqual(['c1']);
    const recordedStudy = result.document.cfd?.studies?.['c1'] as CfdGridStudy;
    expect(recordedStudy.levels.map((entry) => entry.resultsHash)).toEqual([fine.hash, medium.hash, coarse.hash]);
    expect(recordedStudy.status).toBe('monotone');
    expect(recordedStudy.orderP).toBeCloseTo(2, 9);
    expect(recordedStudy.extrapolated).toBeCloseTo(0.5 / (Q * AREA), 9);
    const expected = gciTriplet(
      recordedStudy.levels.map((entry) => ({ h: entry.cellM, value: entry.value })) as [
        { h: number; value: number },
        { h: number; value: number },
        { h: number; value: number },
      ],
      1.25,
    );
    expect(recordedStudy.gci21Fine).toBeCloseTo('gci21Fine' in expected ? (expected.gci21Fine ?? NaN) : NaN, 12);
    expect(recordedStudy.asymptoticRatio).toBeCloseTo(1.0588, 3);
    expect(recordedStudy.r21).toBeCloseTo(2, 12);
    expect(result.summary).toContain('order p 2');
    expect((result.data as { study: CfdGridStudy }).study).toEqual(recordedStudy);
    expect(result.document.order).toEqual(recorded.doc.order);
  });

  it('studies cl and cdAM2 with a chosen safety factor; accepts bundles whose case differs only in the grid', () => {
    const cfdCase = recorded.doc.cfd?.cases['c1'] as CfdCase;
    const tagged = level(0.05, drag(0.05), { caseHash: caseHashOf({ ...cfdCase, cellsPerReferenceLength: 20 }) });
    const withTagged = contextOf([tagged, medium, coarse]);
    const result = ok(
      recorded.doc,
      'record_cfd_grid_study',
      { caseId: 'c1', resultsHashes: [tagged.hash, medium.hash, coarse.hash], quantity: 'cdAM2', safetyFactor: 3 },
      withTagged,
    );
    const recordedStudy = result.document.cfd?.studies?.['c1'] as CfdGridStudy;
    expect(recordedStudy.quantity).toBe('cdAM2');
    expect(recordedStudy.safetyFactor).toBe(3);
    expect(recordedStudy.extrapolated).toBeCloseTo(0.5 / Q, 9);
    const lift = ok(recorded.doc, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes, quantity: 'cl' }, ctx);
    expect(lift.document.cfd?.studies?.['c1']?.status).toBe('converged_exactly');
  });

  it('records an oscillating triplet with its status and no GCI, and flags unconverged solves', () => {
    const a = level(0.05, 0.52, { converged: false });
    const b = level(0.1, 0.48);
    const c = level(0.2, 0.53);
    const result = ok(
      recorded.doc,
      'record_cfd_grid_study',
      { caseId: 'c1', resultsHashes: [a.hash, b.hash, c.hash] },
      contextOf([a, b, c]),
    );
    const recordedStudy = result.document.cfd?.studies?.['c1'] as CfdGridStudy;
    expect(recordedStudy.status).toBe('oscillatory');
    expect(recordedStudy.gci21Fine).toBeUndefined();
    expect(result.summary).toContain('no GCI');
    expect(result.summary).toContain('1 of 3 solves NOT converged');
  });

  it('refuses unknown cases, repeated hashes, missing or tampered bundles, other cases, surfaces and too small ratios (unchanged document)', () => {
    const refuse = (params: Record<string, unknown>, context = ctx, code = 'CFD_PARAM_INVALID'): void => {
      const result = execute(recorded.doc, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes, ...params }, context);
      expect(result.rejected, result.summary).toBe(true);
      expect(result.error?.code, result.summary).toBe(code);
      expect(result.document).toBe(recorded.doc);
      expect(result.affected).toEqual([]);
    };
    refuse({ caseId: 'nope' }, ctx, 'CFD_CASE_NOT_FOUND');
    refuse({ resultsHashes: [fine.hash, fine.hash, medium.hash] });
    refuse({ resultsHashes: [fine.hash, medium.hash, 'f'.repeat(64)] }, ctx, 'CFD_RESULT_MISSING');
    refuse({ resultsHashes: [fine.hash, medium.hash] }, ctx, 'CMD_INVALID_PARAMS');
    refuse({}, { ...ctx, cfdResults: undefined as never }, 'CFD_RESULT_MISSING');
    const forged: CfdResultPort = { get: () => fine.artifact };
    refuse({}, { ...ctx, cfdResults: forged }, 'CFD_RESULT_HASH_MISMATCH');
    const other = level(0.2, 0.7, { caseId: 'other' });
    refuse({ resultsHashes: [fine.hash, medium.hash, other.hash] }, contextOf([fine, medium, other]), 'CFD_RESULT_HASH_MISMATCH');
    const foreign = level(0.2, 0.7, { caseHash: 'e'.repeat(64) });
    refuse({ resultsHashes: [fine.hash, medium.hash, foreign.hash] }, contextOf([fine, medium, foreign]), 'CFD_INPUT_STALE');
    const surface = level(0.2, 0.7, { geometryHash: 'd'.repeat(64) });
    refuse({ resultsHashes: [fine.hash, medium.hash, surface.hash] }, contextOf([fine, medium, surface]), 'CFD_INPUT_STALE');
    const stale = level(0.05, 0.6, { geometryHash: 'd'.repeat(64) });
    const staleMedium = level(0.1, 0.6, { geometryHash: 'd'.repeat(64) });
    const staleCoarse = level(0.2, 0.6, { geometryHash: 'd'.repeat(64) });
    refuse(
      { resultsHashes: [stale.hash, staleMedium.hash, staleCoarse.hash] },
      contextOf([stale, staleMedium, staleCoarse]),
      'CFD_INPUT_STALE',
    );
    const close = level(0.052, 0.6);
    refuse({ resultsHashes: [fine.hash, close.hash, medium.hash] }, contextOf([fine, close, medium]));
  });

  it('stores the absolute GCI when the fine value is exactly 0', () => {
    const levels = [level(0.05, 0), level(0.1, 0.1), level(0.2, 0.3)];
    const result = ok(
      recorded.doc,
      'record_cfd_grid_study',
      { caseId: 'c1', resultsHashes: levels.map((entry) => entry.hash) },
      contextOf(levels),
    );
    const recordedStudy = result.document.cfd?.studies?.['c1'] as CfdGridStudy;
    expect(recordedStudy.relativeUndefined).toBe(true);
    expect(recordedStudy.gciAbs).toBeGreaterThan(0);
    expect(recordedStudy.gci21Fine).toBeUndefined();
    expect(result.summary).toContain('absolute');
    expect(result.summary).not.toContain('NaN');
  });

  it('records a monotone triplet whose observed order does not converge with its own status and message', () => {
    const levels = [level(0.05, 0.5), level(0.0551, 1), level(0.1102, 1.75)];
    const result = ok(
      recorded.doc,
      'record_cfd_grid_study',
      { caseId: 'c1', resultsHashes: levels.map((entry) => entry.hash) },
      contextOf(levels),
    );
    expect(result.document.cfd?.studies?.['c1']?.status).toBe('order_not_converged');
    expect(result.summary).toContain('observed order did not converge');
    expect(result.summary).not.toContain('does not converge monotonically');
  });

  it('says converged_exactly is not a non-convergence', () => {
    const levels = [level(0.05, 0.5), level(0.1, 0.5), level(0.2, 0.7)];
    const result = ok(
      recorded.doc,
      'record_cfd_grid_study',
      { caseId: 'c1', resultsHashes: levels.map((entry) => entry.hash) },
      contextOf(levels),
    );
    expect(result.document.cfd?.studies?.['c1']?.status).toBe('converged_exactly');
    expect(result.summary).toContain('same value');
  });

  it('overwrites an earlier study of the case', () => {
    const first = study().document;
    const second = ok(first, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes, quantity: 'cdAM2' }, ctx);
    expect(first.cfd?.studies?.['c1']?.quantity).toBe('cd');
    expect(second.document.cfd?.studies?.['c1']?.quantity).toBe('cdAM2');
    expect(Object.keys(second.document.cfd?.studies ?? {})).toEqual(['c1']);
  });

  it('runs without a kernel and with the Manifold kernel (surface staleness)', async () => {
    expect(study(recorded.doc, {}, { ...ctx, kernel: null }).rejected).not.toBe(true);
    const kernel = await createManifoldKernel();
    const withKernel = recordedSphere({}, kernel);
    const levels = [0.05, 0.1, 0.2].map((h) =>
      level(h, drag(h), { geometryHash: withKernel.artifact.geometryHash, kernel: withKernel.artifact.kernel }),
    );
    const result = execute(
      withKernel.doc,
      'record_cfd_grid_study',
      { caseId: 'c1', resultsHashes: levels.map((entry) => entry.hash) },
      { ...withKernel.ctx, cfdResults: portOf(levels) },
    );
    expect(result.rejected, result.summary).not.toBe(true);
    expect(result.document.cfd?.studies?.['c1']?.levels).toHaveLength(3);
    // the same bundles are stale once the body moved: the surface is re-prepared through the kernel
    const moved = execute(withKernel.doc, 'move_entities', { ids: [withKernel.ballId], delta: [0.5, 0, 0] }, withKernel.ctx).document;
    const stale = execute(
      moved,
      'record_cfd_grid_study',
      { caseId: 'c1', resultsHashes: levels.map((entry) => entry.hash) },
      { ...withKernel.ctx, cfdResults: portOf(levels) },
    );
    expect(stale.error?.code).toBe('CFD_INPUT_STALE');
  });

  it('accepts the resolution-only hash only for the matching grid: wrong cells or another quality are stale', () => {
    const cfdCase = recorded.doc.cfd?.cases['c1'] as CfdCase;
    const refuseWith = (caseHash: string): void => {
      const bad = level(0.05, drag(0.05), { caseHash });
      const result = execute(
        recorded.doc,
        'record_cfd_grid_study',
        { caseId: 'c1', resultsHashes: [bad.hash, medium.hash, coarse.hash] },
        contextOf([bad, medium, coarse]),
      );
      expect(result.error?.code, result.summary).toBe('CFD_INPUT_STALE');
      expect(result.document).toBe(recorded.doc);
    };
    refuseWith(caseHashOf({ ...cfdCase, cellsPerReferenceLength: 40 }));
    refuseWith(caseHashOf({ ...cfdCase, cellsPerReferenceLength: 20, quality: 'fine' }));
  });

  it('refuses when only the coarse ratio is below 1.1', () => {
    const near = level(0.105, drag(0.105));
    const result = execute(
      recorded.doc,
      'record_cfd_grid_study',
      { caseId: 'c1', resultsHashes: [fine.hash, medium.hash, near.hash] },
      contextOf([fine, medium, near]),
    );
    expect(result.error?.code).toBe('CFD_PARAM_INVALID');
  });

  it('keeps an echoed study unverified without the bundles, recomputes and compares it with them', () => {
    const echoed = (study().data as { study: CfdGridStudy }).study;
    const none: ExecutionContext = { ...recorded.ctx, cfdResults: null };
    const replay = execute(recorded.doc, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes, study: echoed }, none);
    expect(replay.rejected).not.toBe(true);
    expect(replay.document.cfd?.studies?.['c1']).toEqual({ ...echoed, verified: false });
    expect(replay.summary).toContain('UNVERIFIED');
    const codeOf = (params: Record<string, unknown>, context = none): string | undefined =>
      execute(recorded.doc, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes, ...params }, context).error?.code;
    expect(codeOf({})).toBe('CFD_RESULT_MISSING');
    expect(codeOf({ study: { ...echoed, levels: [] } })).toBe('CFD_RESULT_MISSING');
    expect(codeOf({ study: { ...echoed, caseId: 'other' } })).toBe('CFD_RESULT_MISSING');
    expect(codeOf({ study: { ...echoed, levels: echoed.levels.map((entry) => ({ ...entry, resultsHash: 'x' })) } })).toBe(
      'CFD_RESULT_MISSING',
    );
    const withBundles = execute(recorded.doc, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes, study: echoed }, ctx);
    expect(withBundles.rejected).not.toBe(true);
    expect(codeOf({ study: { ...echoed, orderP: 9 } }, ctx)).toBe('CFD_RESULT_HASH_MISMATCH');
  });

  it('takes the unverified path only without a result store: a store with a bundle missing refuses', () => {
    const echoed = (study().data as { study: CfdGridStudy }).study;
    const partial = contextOf([fine, medium]);
    const result = execute(recorded.doc, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes, study: echoed }, partial);
    expect(result.error?.code).toBe('CFD_RESULT_MISSING');
    expect(result.document).toBe(recorded.doc);
  });

  it('refuses an echoed study that does not match the request, the case state, or would replace a verified study', () => {
    const verified = study().document;
    const echoed = (study().data as { study: CfdGridStudy }).study;
    const none: ExecutionContext = { ...recorded.ctx, cfdResults: null };
    const codeOf = (doc: typeof verified, study: unknown, params: Record<string, unknown> = {}): string | undefined => {
      const result = execute(doc, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes, study, ...params }, none);
      expect(result.document).toBe(doc);
      return result.error?.code;
    };
    const [a] = echoed.levels;
    expect(codeOf(recorded.doc, { ...echoed, levels: [a, a, a] })).toBe('CFD_RESULT_MISSING');
    expect(codeOf(recorded.doc, echoed, { quantity: 'cl' })).toBe('CFD_PARAM_INVALID');
    expect(codeOf(recorded.doc, echoed, { safetyFactor: 2 })).toBe('CFD_PARAM_INVALID');
    expect(codeOf(recorded.doc, { ...echoed, caseHash: 'e'.repeat(64) })).toBe('CFD_INPUT_STALE');
    const result = execute(verified, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes, study: echoed }, none);
    expect(result.error?.code).toBe('CFD_RESULT_MISSING');
    expect(result.summary).toContain('verified study');
    expect(result.document).toBe(verified);
    const unverified = execute(
      recorded.doc,
      'record_cfd_grid_study',
      { caseId: 'c1', resultsHashes: hashes, study: echoed },
      none,
    ).document;
    expect(execute(unverified, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes, study: echoed }, none).rejected).not.toBe(
      true,
    );
  });

  it('is removed with its case; update_cfd_case reports it stale when the case hash changes', () => {
    const recordedStudy = study().document;
    expect(execute(recordedStudy, 'delete_cfd_case', { caseId: 'c1' }).document.cfd?.studies).toEqual({});
    const same = execute(recordedStudy, 'update_cfd_case', { caseId: 'c1', quality: 'fine' });
    expect((same.data as { gridStudyStale: boolean }).gridStudyStale).toBe(true);
    expect(same.summary).toContain('grid study is now stale');
    const without = execute(recorded.doc, 'update_cfd_case', { caseId: 'c1', quality: 'fine' });
    expect((without.data as { gridStudyStale: boolean }).gridStudyStale).toBe(false);
  });

  it('validates the slice on load: shape, every field, order, orphans', () => {
    const slice = study().document.cfd as unknown as Record<string, unknown>;
    const good = (slice['studies'] as Record<string, Record<string, unknown>>)['c1'] as Record<string, unknown>;
    const errorsOf = (studies: unknown): string[] => cfdDocument.validate({ cfd: { ...slice, studies } });
    expect(errorsOf(undefined)).toEqual([]);
    expect(errorsOf({ c1: good })).toEqual([]);
    for (const bad of [5, null, [], 'x']) expect(errorsOf(bad)).toEqual(['cfd.studies must be an object']);
    expect(errorsOf({ c1: 5 })).toEqual([expect.stringContaining('cfd.studies.c1')]);
    for (const field of ['geometryHash', 'r21', 'r32', 'verified', 'quantity', 'status', 'safetyFactor', 'caseHash'])
      expect(errorsOf({ c1: { ...good, [field]: undefined } }), field).not.toEqual([]);
    const levels = good['levels'] as Record<string, unknown>[];
    for (const field of ['cells', 'converged', 'cellM', 'value', 'resultsHash'])
      expect(errorsOf({ c1: { ...good, levels: [{ ...levels[0], [field]: undefined }, levels[1], levels[2]] } }), field).not.toEqual([]);
    for (const field of ['orderP', 'extrapolated', 'gci21Fine', 'gci32Fine', 'gciAbs', 'asymptoticRatio'])
      expect(errorsOf({ c1: { ...good, [field]: 'x' } }), field).not.toEqual([]);
    expect(errorsOf({ c1: { ...good, orderP: Number.NaN } })).not.toEqual([]);
    expect(errorsOf({ c1: { ...good, extra: 1 } })).not.toEqual([]);
    expect(errorsOf({ c1: { ...good, levels: [...levels].reverse() } })).toEqual([expect.stringContaining('finest first')]);
    expect(errorsOf({ c1: { ...good, levels: levels.slice(0, 2) } })).not.toEqual([]);
    expect(errorsOf({ c1: { ...good, caseId: 'zz' } })).toEqual([expect.stringContaining('caseId')]);
    expect(errorsOf({ zz: { ...good, caseId: 'zz' } })).toEqual([expect.stringContaining('orphan')]);
  });
});
