import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { analysisInputHash } from '@cae/hash/inputHash';
import { isProblem, thermalCaseOf } from '@cae/thermal/access';
import { limitRows } from '@cae/thermal/limitRows';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { expectRefusesWithoutUid } from '../../../helpers/documentBinding';
import { caseOf, machineContext, must } from './fixtures';
import { HOT_T, solvedWall, type SolvedWall } from './solved';

const source = { citation: 'test input of this validation case', locator: 'VC-THM-62' };
const withPorts = (wall: SolvedWall, signatures?: HumanSignaturePort): ExecutionContext => ({
  ...defaultContext(),
  feaArtifacts: wall.port,
  ...(signatures !== undefined ? { humanSignature: signatures } : {}),
});
const run = (doc: CadDocument, command: string, params: Record<string, unknown>, ctx = machineContext()): CommandResult =>
  execute(doc, command, params, ctx);

interface Row {
  rowId: string;
  limitId: string;
  bound: string;
  status: string;
  code?: string;
  marginK: number;
  computed: { value: number; unit: string };
  at: number[];
  timeS: number;
  unverified: boolean;
  reviewRequired: boolean;
  reviewReason: string;
  disposition: unknown;
  provenance: { citation: string };
}
interface Data {
  rows: Row[];
  items: { code: string; ids: string[] }[];
  summary: { pass: number; marginal: number; fail: number; pendingHuman: number };
  resultsHash: string;
}

/** The solved wall with a part limit of 150 degC (VC-THM-62) and a lower bound, recorded in the document. */
function limited(basis: 'company' | 'typical' = 'company'): { wall: SolvedWall; doc: CadDocument; limitId: string; targetId: string } {
  let limitId = '';
  let targetId = '';
  const wall = solvedWall({ basis }, 1, undefined, (fixture) => {
    const added = must(fixture.doc, 'add_temperature_limit', {
      analysisId: fixture.analysisId,
      name: 'wall max',
      entityId: fixture.boxId,
      max: { value: 150, unit: 'degC' },
      min: { value: -40, unit: 'degC' },
      source,
    });
    limitId = added.affected[0] ?? '';
    const targeted = must(added.document, 'add_temperature_limit', {
      analysisId: fixture.analysisId,
      name: 'face',
      target: { entityId: fixture.boxId, facesNear: [[0.5, 0.5, 0.05]] },
      max: { value: 200, unit: 'degC' },
      source,
    });
    targetId = targeted.affected[0] ?? '';
    return { doc: targeted.document, nodeSets: { [`T_${targetId}`]: [1, 2] } };
  });
  return { wall, doc: wall.solved, limitId, targetId };
}

describe('check_temperature_limits', () => {
  it('VC-THM-62: a 150 degC limit on the 170.81 degC wall FAILs with the margin, review flag and a pending human disposition', () => {
    const { wall, doc, limitId } = limited();
    const result = run(doc, 'check_temperature_limits', { analysisId: wall.analysisId }, withPorts(wall));
    const data = result.data as Data;
    expect(result.rejected).toBeUndefined();
    const max = data.rows.find((row) => row.bound === 'max');
    expect(max).toMatchObject({
      rowId: `${limitId}:max`,
      limitId,
      status: 'FAIL',
      code: 'THM_LIMIT_EXCEEDED',
      reviewRequired: true,
      disposition: 'pending_human',
      unverified: false,
      timeS: 0,
      provenance: source,
    });
    expect(max?.computed.unit).toBe('degC');
    expect(Math.abs((max?.marginK ?? 0) - -20.8108108108)).toBeLessThan(1e-6);
    expect(max?.reviewReason).toContain('not approved');
    expect(max?.at).toEqual([0, 0, 0]);
    const min = data.rows.find((row) => row.bound === 'min');
    expect(min).toMatchObject({ status: 'PASS', disposition: 'not_required' });
    expect(min?.computed.value).toBeLessThan(HOT_T);
    expect(data.summary).toEqual({ pass: 2, marginal: 0, fail: 1, pendingHuman: 1 });
    expect(data.items.map((item) => item.code)).toEqual(['THM_MARGINAL_BAND_UNSET', 'THM_LIMIT_EXCEEDED', 'THM_DISPOSITION_PENDING']);
    expect(data.resultsHash).toBe(wall.resultsHash);
    expect(result.summary).toContain('1 FAIL');
    expectPure(doc, () => run(doc, 'check_temperature_limits', { analysisId: wall.analysisId }, withPorts(wall)));
  });

  it('uses the marginal band only when given, bound by bound, and (limitRows) resolves target limits through node sets or faces', () => {
    const { wall, doc, targetId } = limited();
    const mesh = wall.mesh;
    const result = run(doc, 'check_temperature_limits', { analysisId: wall.analysisId, marginalBandK: 50 }, withPorts(wall));
    const data = result.data as Data;
    const row = data.rows.find((entry) => entry.limitId === targetId);
    expect(row).toMatchObject({ status: 'MARGINAL', code: 'THM_LIMIT_MARGINAL' });
    expect(row?.marginK).toBeCloseTo(200 - HOT_T, 9);
    expect(data.items.map((item) => item.code)).not.toContain('THM_MARGINAL_BAND_UNSET');
    expect(data.items.map((item) => item.code)).toContain('THM_LIMIT_MARGINAL');
    expect(data.summary).toMatchObject({ marginal: 1, fail: 1, pass: 1 });
    const found = thermalCaseOf(doc, wall.analysisId);
    if (isProblem(found)) throw new Error(found.message);
    const viaFaces = { ...mesh, nodeSets: {}, faceSets: { ...mesh.faceSets, [`T_${targetId}`]: [[1, 1]] as [number, number][] } };
    const byFaces = limitRows(doc, found, viaFaces, wall.results, undefined);
    expect(byFaces).toHaveLength(3);
    const emptyFaces = { ...viaFaces, faceSets: {} };
    expect(limitRows(doc, found, emptyFaces, wall.results, undefined)).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED' });
    expect(limitRows(doc, found, { ...mesh, blocks: [] }, wall.results, undefined)).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED' });
  });

  it('VC-THM-63: unverified conductivity marks every row', () => {
    const { wall, doc } = limited('typical');
    const data = run(doc, 'check_temperature_limits', { analysisId: wall.analysisId }, withPorts(wall)).data as Data;
    expect(data.rows.every((row) => row.unverified)).toBe(true);
  });

  it('VC-THM-50: refuses with FEA_RESULTS_STALE after a change, FEA_RESULTS_MISSING without results or artifacts', () => {
    const { wall, doc } = limited();
    const edited = must(doc, 'update_thermal_bc', {
      analysisId: wall.analysisId,
      bcId: wall.hotId,
      filmCoefficient: { value: 60, unit: 'W/(m^2*K)' },
    }).document;
    const stale = run(edited, 'check_temperature_limits', { analysisId: wall.analysisId }, withPorts(wall));
    expectNoOp(stale, edited);
    expect(stale.rejected).toBe(true);
    expect(stale.error?.code).toBe('FEA_RESULTS_STALE');
    expect(stale.error?.remediation).toContain('fea_solve');
    const withoutPort = run(doc, 'check_temperature_limits', { analysisId: wall.analysisId }, defaultContext());
    expect(withoutPort.error?.code).toBe('FEA_RESULTS_MISSING');
    const noResults = must(wall.doc, 'add_temperature_limit', {
      analysisId: wall.analysisId,
      name: 'l',
      entityId: wall.boxId,
      max: { value: 1, unit: 'K' },
      source,
    });
    expect(run(noResults.document, 'check_temperature_limits', { analysisId: wall.analysisId }, withPorts(wall)).error?.code).toBe(
      'FEA_RESULTS_MISSING',
    );
    const noMesh = { get: (hash: string) => (hash === wall.resultsHash ? wall.results : null) };
    expect(
      run(doc, 'check_temperature_limits', { analysisId: wall.analysisId }, { ...defaultContext(), feaArtifacts: noMesh }).error?.code,
    ).toBe('FEA_RESULTS_MISSING');
    expect(run(doc, 'check_temperature_limits', { analysisId: 'ghost' }).error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
  });

  it('warns THM_NO_LIMITS when there is no limit, without needing results', () => {
    const wall = solvedWall();
    const result = run(wall.doc, 'check_temperature_limits', { analysisId: wall.analysisId });
    expect(result.rejected).toBeUndefined();
    expect(result.data).toMatchObject({ rows: [], items: [{ code: 'THM_NO_LIMITS', severity: 'warning' }], reviewRequired: true });
  });
});

const payload = (wall: SolvedWall, rowId: string, decision: string, justification: string): string =>
  sha256Hex(
    canonicalJson({
      kind: 'thermal_limit_disposition',
      documentUid: wall.doc.uid ?? '',
      analysisId: wall.analysisId,
      rowId,
      decision,
      justification,
      resultsHash: wall.resultsHash,
    }),
  );
const signer = (seen: string[] = []): HumanSignaturePort => ({
  verify: (signature, hash) => {
    seen.push(hash);
    return signature === 'good' ? { signer: 'alice', signatureId: 'sig-7' } : null;
  },
});

describe('dispose_thermal_limit (human gate)', () => {
  const justification = 'accepted for the qualification test, margin covered by the 5 K thermostat';

  it('VC-THM-62: refuses an agent call (no port) with THM_HUMAN_GATE and leaves the document unchanged', () => {
    const { wall, doc, limitId } = limited();
    const params = { analysisId: wall.analysisId, rowId: `${limitId}:max`, decision: 'accepted', justification };
    const result = run(doc, 'dispose_thermal_limit', params, withPorts(wall));
    expectNoOp(result, doc);
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('THM_HUMAN_GATE');
    expect(JSON.stringify(result.document)).toBe(JSON.stringify(doc));
    expect(analysisInputHash(result.document, wall.analysisId, 'full')).toBe(analysisInputHash(doc, wall.analysisId, 'full'));
    const forged = run(doc, 'dispose_thermal_limit', { ...params, confirmation: 'forged' }, withPorts(wall, signer()));
    expectNoOp(forged, doc);
    expect(forged.error?.code).toBe('THM_HUMAN_GATE');
  });

  it('records decision, justification, results hash and signer for a verified signature; the results stay current', () => {
    const { wall, doc, limitId } = limited();
    const rowId = `${limitId}:max`;
    const seen: string[] = [];
    const params = { analysisId: wall.analysisId, rowId, decision: 'accepted', justification, confirmation: 'good' };
    const result = run(doc, 'dispose_thermal_limit', params, withPorts(wall, signer(seen)));
    expect(result.rejected).toBeUndefined();
    expect(seen).toEqual([payload(wall, rowId, 'accepted', justification)]);
    expect(result.affected).toEqual([rowId]);
    expect(caseOf(result.document, wall.analysisId).thermal?.dispositions[rowId]).toEqual({
      decision: 'accepted',
      justification,
      resultsHash: wall.resultsHash,
      signer: 'alice',
      signatureId: 'sig-7',
      signature: 'good',
      documentUid: doc.uid,
    });
    expectPure(doc, () => run(doc, 'dispose_thermal_limit', params, withPorts(wall, signer())));
    const after = run(result.document, 'check_temperature_limits', { analysisId: wall.analysisId }, withPorts(wall, signer()));
    const row = (after.data as Data).rows.find((entry) => entry.rowId === rowId);
    expect(row?.disposition).toMatchObject({ decision: 'accepted', signer: 'alice' });
    expect((after.data as Data).items.map((item) => item.code)).not.toContain('THM_DISPOSITION_PENDING');
    expect(run(result.document, 'analysis_report', { view: 'thermal', analysisId: wall.analysisId }).data).toMatchObject({
      state: 'solved',
    });
    // a disposition made on other results is pending again
    const rebound = {
      ...result.document,
      analysis: {
        ...result.document.analysis!,
        cases: {
          [wall.analysisId]: {
            ...caseOf(result.document, wall.analysisId),
            thermal: {
              ...caseOf(result.document, wall.analysisId).thermal!,
              dispositions: {
                [rowId]: { ...caseOf(result.document, wall.analysisId).thermal!.dispositions[rowId]!, resultsHash: 'older' },
              },
            },
          },
        },
      },
    };
    const pending = run(rebound, 'check_temperature_limits', { analysisId: wall.analysisId }, withPorts(wall, signer()));
    expect((pending.data as Data).rows.find((entry) => entry.rowId === rowId)?.disposition).toBe('pending_human');
  });

  it('refuses unknown rows, empty justifications, stale or missing results and unknown analyses', () => {
    const { wall, doc, limitId } = limited();
    const base = { analysisId: wall.analysisId, rowId: `${limitId}:max`, decision: 'rejected', justification, confirmation: 'good' };
    const ctx = withPorts(wall, signer());
    expect(run(doc, 'dispose_thermal_limit', { ...base, rowId: `${limitId}:nope` }, ctx).error?.code).toBe('THM_LIMIT_NOT_FOUND');
    expect(run(doc, 'dispose_thermal_limit', { ...base, rowId: 'ghost:max' }, ctx).error?.code).toBe('THM_LIMIT_NOT_FOUND');
    const maxOnly = must(wall.solved, 'add_temperature_limit', {
      analysisId: wall.analysisId,
      name: 'm',
      entityId: wall.boxId,
      max: { value: 1, unit: 'K' },
      source,
    });
    expect(run(maxOnly.document, 'dispose_thermal_limit', { ...base, rowId: `${maxOnly.affected[0]}:min` }, ctx).error?.code).toBe(
      'THM_LIMIT_NOT_FOUND',
    );
    expect(run(doc, 'dispose_thermal_limit', { ...base, justification: '  ' }, ctx).error?.code).toBe('THM_LIMIT_INVALID');
    expect(run(doc, 'dispose_thermal_limit', { ...base, analysisId: 'ghost' }, ctx).error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    const edited = must(doc, 'update_thermal_bc', {
      analysisId: wall.analysisId,
      bcId: wall.hotId,
      filmCoefficient: { value: 60, unit: 'W/(m^2*K)' },
    }).document;
    const stale = run(edited, 'dispose_thermal_limit', base, ctx);
    expect(stale.error?.code).toBe('FEA_RESULTS_STALE');
    expectNoOp(stale, edited);
    const none = must(wall.doc, 'add_temperature_limit', {
      analysisId: wall.analysisId,
      name: 'l',
      entityId: wall.boxId,
      max: { value: 1, unit: 'K' },
      source,
    });
    const unsolved = run(none.document, 'dispose_thermal_limit', { ...base, rowId: `${none.affected[0]}:max` }, ctx);
    expect(unsolved.error?.code).toBe('FEA_RESULTS_MISSING');
  });
});

describe('dispose_thermal_limit: the signature is bound to the document (GATE-UID)', () => {
  const justification = 'accepted for the qualification test, margin covered by the 5 K thermostat';
  const pinned = (): HumanSignaturePort => ({
    verify: (signature, hash) =>
      (signature as { payload?: string } | null)?.payload === hash ? { signer: 'alice', signatureId: 'sig-7' } : null,
  });
  const setup = (): { wall: SolvedWall; doc: CadDocument; rowId: string; params: Record<string, unknown>; disposed: CommandResult } => {
    const { wall, doc, limitId } = limited();
    const rowId = `${limitId}:max`;
    const signature = { payload: payload(wall, rowId, 'accepted', justification) };
    const params = { analysisId: wall.analysisId, rowId, decision: 'accepted', justification, confirmation: signature };
    return { wall, doc, rowId, params, disposed: run(doc, 'dispose_thermal_limit', params, withPorts(wall, pinned())) };
  };
  const codes = (wall: SolvedWall, doc: CadDocument): Record<string, unknown>[] =>
    (run(doc, 'check_temperature_limits', { analysisId: wall.analysisId }, withPorts(wall, pinned())).data as Data).items;

  it('records the uid of the document it was signed in, and counts there', () => {
    const { wall, doc, rowId, disposed } = setup();
    expect(disposed.error, disposed.summary).toBeUndefined();
    expect(caseOf(disposed.document, wall.analysisId).thermal?.dispositions[rowId]?.documentUid).toBe(doc.uid);
    expect(codes(wall, disposed.document).map((item) => item.code)).not.toContain('THM_DISPOSITION_PENDING');
  });

  it('a disposition copied into another document does not count: THM_DISPOSITION_FOREIGN_DOCUMENT (error), the row pending', () => {
    const { wall, rowId, disposed } = setup();
    const copied = { ...disposed.document, uid: 'f'.repeat(32) };
    const checked = run(copied, 'check_temperature_limits', { analysisId: wall.analysisId }, withPorts(wall, pinned()));
    const items = (checked.data as Data).items;
    expect(items).toContainEqual(expect.objectContaining({ code: 'THM_DISPOSITION_FOREIGN_DOCUMENT', severity: 'error' }));
    expect((checked.data as Data).rows.find((entry) => entry.rowId === rowId)?.disposition).toBe('pending_human');
    expect(items.map((item) => item.code)).toContain('THM_DISPOSITION_PENDING');
  });

  it('every re-verified gate refuses a uid-less document after the port check (shared helper)', () => {
    const { wall, doc, params } = setup();
    expectRefusesWithoutUid(
      doc,
      (document, signature, ctx) =>
        run(document, 'dispose_thermal_limit', { ...params, confirmation: signature }, withPorts(wall, ctx.humanSignature ?? undefined)),
      'THM_DOCUMENT_UNIDENTIFIED',
      'THM_HUMAN_GATE',
    );
  });

  it('a disposition that records no document uid does not count: THM_DISPOSITION_UNBOUND', () => {
    const { wall, rowId, disposed } = setup();
    const analysis = caseOf(disposed.document, wall.analysisId);
    const { documentUid, ...stored } = analysis.thermal!.dispositions[rowId]!;
    void documentUid;
    const unbound = {
      ...disposed.document,
      analysis: {
        ...disposed.document.analysis!,
        cases: { [wall.analysisId]: { ...analysis, thermal: { ...analysis.thermal!, dispositions: { [rowId]: stored } } } },
      },
    };
    expect(codes(wall, unbound)).toContainEqual(expect.objectContaining({ code: 'THM_DISPOSITION_UNBOUND', severity: 'error' }));
  });

  it('a signature made in this document is refused in a copy of it (THM_HUMAN_GATE); a document without a uid refuses to sign (THM_DOCUMENT_UNIDENTIFIED)', () => {
    const { wall, doc, params } = setup();
    const copy = { ...doc, uid: 'f'.repeat(32) };
    const refused = run(copy, 'dispose_thermal_limit', params, withPorts(wall, pinned()));
    expect(refused.error?.code).toBe('THM_HUMAN_GATE');
    expect(refused.document).toBe(copy);
    const { uid, ...unidentified } = doc;
    void uid;
    const noUid = run(unidentified, 'dispose_thermal_limit', params, withPorts(wall, pinned()));
    expect(noUid.error?.code).toBe('THM_DOCUMENT_UNIDENTIFIED');
    expect(noUid.document).toBe(unidentified);
  });
});
