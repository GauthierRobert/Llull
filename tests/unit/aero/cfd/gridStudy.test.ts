/** 12 CFD M5 (first slice): `record_cfd_grid_study` - GCI of three recorded solves, trust and refusal ladder, purity, document validation. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { ExecutionContext, CommandResult } from '@core/commands/types';
import type { CfdResultArtifact, CfdResultPort } from '@core/model/cfdResult';
import type { CfdCase, CfdGridStudy } from '@aero/cfd/types';
import { gciTriplet } from '@lib/convergence';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { cfdDocument } from '@aero/cfd/document';
import { caseHashOf } from '@aero/cfd/caseDoc';
import { expectPure } from '../../../helpers/expectNoOp';
import { ok } from './fixtures';
import { recordedSphere } from './resultFixtures';

const recorded = recordedSphere();
const Q = 2;
const AREA = 0.7853981634;

/** An artifact of the recorded sphere solved at cell size `cellM` with drag `dragN` (the coefficient follows from the case reference). */
function level(cellM: number, dragN: number, patch: Partial<CfdResultArtifact> = {}): { artifact: CfdResultArtifact; hash: string } {
  const base = recorded.artifact;
  const artifact: CfdResultArtifact = {
    ...base,
    grid: { ...base.grid, cellM, cells: Math.round(1000 / cellM) },
    forces: { ...base.forces, totalN: [dragN, 0, 0.02] },
    ...patch,
  };
  return { artifact, hash: sha256Hex(canonicalJson(artifact)) };
}

const contextOf = (levels: readonly { artifact: CfdResultArtifact; hash: string }[]): ExecutionContext => {
  const port: CfdResultPort = { get: (key) => levels.find((entry) => entry.hash === key)?.artifact ?? null };
  return { ...recorded.ctx, cfdResults: port };
};

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

  it('is removed with its case and validated on load', () => {
    const recordedStudy = study().document;
    expect(execute(recordedStudy, 'delete_cfd_case', { caseId: 'c1' }).document.cfd?.studies).toEqual({});
    const slice = recordedStudy.cfd as unknown as Record<string, unknown>;
    expect(cfdDocument.validate({ cfd: slice })).toEqual([]);
    const broken = { ...slice, studies: { c1: { caseId: 'x' }, c2: 5 } };
    expect(cfdDocument.validate({ cfd: broken })).toEqual([
      expect.stringContaining('cfd.studies.c1 needs caseId equal to its key'),
      'cfd.studies.c2 must be an object',
    ]);
  });
});
