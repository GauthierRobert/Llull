/**
 * commit_asbuilt_extraction for steel members (plant 10 §13.12, SC-SCN-05): the fit_steel_member extraction becomes an as-built
 * add_steel_member, the designation is normalised onto the catalogue, an unknown profile is refused by name, the human gate and replay keep
 * the pipe semantics; plus tw / tf and the axis refinement of fit_steel_member. Native answers are scripted (numerics: llull-cloud tests/steel.rs).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CloudOp, CloudOpResult } from '@core/model/pointCloud';
import type { ExecutionContext } from '@core/commands/types';
import { isRecord } from '@lib/isRecord';
import { normaliseDesignation } from '@aec/steel/profiles';
import { expectPure } from '../../helpers/expectNoOp';
import { fixturePort, KEY_A, opOk } from './fixturePort';

const thickness = (tw: number, tf: number): Record<string, unknown> => ({
  tw: { value: tw, residual: 0.0004, samples: 300 },
  tf: { value: tf, residual: 0.0005, samples: 900 },
  reason: null,
});

/** The native answer for an IPE 300 along +y at z = 4 m (metres), depth +x (a beam). */
const answer = (
  profile = 'IPE 300',
  extra: Record<string, unknown> = {},
  warnings: { code: string; message: string }[] = [],
): Record<string, unknown> => ({
  axisDirection: [0, 1, 0],
  start: [5, 1, 4],
  end: [5, 3, 4],
  length: 2,
  pointsInRegion: 8000,
  sectionPoints: 1500,
  rms: 0.0008,
  threshold: { value: 0.003, source: '3 x noiseSigma', spacing: 0.01 },
  warnings,
  thickness: thickness(0.0071, 0.0107),
  axisRefinement: { applied: true, deltaDeg: 0.4, faces: 8, facePoints: 6800, residual: 0.0006, reason: null },
  candidates: [
    {
      profile,
      score: 0.0008,
      rollDeg: 0,
      flipped: false,
      depthDirection: [1, 0, 0],
      widthDirection: [0, 0, 1],
      axisDirection: [0, 1, 0],
      h: 0.3004,
      b: 0.1502,
      centre: [5, 2, 4],
    },
  ],
  ...extra,
});

function context(reply: (op: CloudOp) => CloudOpResult): ExecutionContext {
  return { ...defaultContext(), pointClouds: fixturePort([{ key: KEY_A, points: [[0, 0, 0]] }], reply) };
}

function setup(ctx: ExecutionContext): { doc: CadDocument; cloudId: string } {
  const unitsDoc = execute({ ...createEmptyDocument(), units: 'm' }, 'add_level', { name: 'Ref', elevation: 0 }).document;
  const result = execute(unitsDoc, 'attach_point_cloud', { assetKey: KEY_A }, ctx);
  return { doc: result.document, cloudId: result.affected[0] ?? '' };
}

/** The `$fromStep` binding of SC-SCN-05: a dotted path into the data of an earlier query step. */
const fromStep = (data: unknown, dotted: string): unknown =>
  dotted
    .split('.')
    .reduce<unknown>((value, key) => (Array.isArray(value) ? value[Number(key)] : isRecord(value) ? value[key] : undefined), data);

const fit = (doc: CadDocument, cloudId: string, ctx: ExecutionContext): ReturnType<typeof execute> =>
  execute(doc, 'fit_steel_member', { cloudId, region: { kind: 'all' } }, ctx);

describe('fit_steel_member thickness and axis refinement', () => {
  it('reports tw / tf with their residual against the catalogue and the refinement, without a warning inside the band', () => {
    const ctx = context(() => opOk(answer()));
    const { doc, cloudId } = setup(ctx);
    const result = fit(doc, cloudId, ctx);
    const data = result.data as {
      measured: Record<string, unknown>;
      axisRefinement: { applied: boolean; faces: number };
      warnings: unknown[];
    };
    expect(data.measured['twMm']).toBeCloseTo(7.1, 9);
    expect(data.measured['tfMm']).toBeCloseTo(10.7, 9);
    expect(data.measured['twResidualMm']).toBeCloseTo(0.4, 9);
    expect(data.measured['twCatalogueMm']).toBe(7.1);
    expect(data.measured['twTfReason']).toBeNull();
    expect(data.axisRefinement).toMatchObject({ applied: true, faces: 8 });
    expect(data.warnings).toEqual([]);
  });

  it('warns SCN_STEEL_THICKNESS_MISMATCH by profile and plate when tw is further from the catalogue than the scan band', () => {
    const ctx = context(() => opOk(answer('IPE300', { thickness: thickness(0.011, 0.0107) })));
    const { doc, cloudId } = setup(ctx);
    const result = fit(doc, cloudId, ctx);
    const data = result.data as { warnings: { code: string; message: string }[]; unverified: boolean; unverifiedReasons: string[] };
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]?.code).toBe('SCN_STEEL_THICKNESS_MISMATCH');
    expect(data.warnings[0]?.message).toContain('IPE300 web thickness tw measures 11.00 mm');
    expect(data.unverified).toBe(true);
    expect(result.summary).toContain('SCN_STEEL_THICKNESS_MISMATCH');
  });

  it('keeps tw / tf null with the reason when the native answer carries none (non-I family)', () => {
    const ctx = context(() => opOk(answer('SHS100x5', { thickness: null })));
    const { doc, cloudId } = setup(ctx);
    const data = fit(doc, cloudId, ctx).data as { measured: { twMm: null; tfMm: null; twTfReason: string } };
    expect(data.measured.twMm).toBeNull();
    expect(data.measured.twTfReason).toContain('IPE, HEA and HEB');
  });
});

describe('commit_asbuilt_extraction for a steel member (SC-SCN-05)', () => {
  it('resolves $fromStep extractions.0.extraction, maps "IPE 300" onto IPE300 and creates the as-built member on the level', () => {
    const ctx = context(() => opOk(answer('IPE 300')));
    const { doc, cloudId } = setup(ctx);
    const fitted = fit(doc, cloudId, ctx);
    const extraction = fromStep(fitted.data, 'extractions.0.extraction');
    expect(isRecord(extraction) && extraction['kind']).toBe('steel_member');
    const committed = execute(doc, 'commit_asbuilt_extraction', { extraction }, ctx);
    expect(committed.rejected, committed.summary).toBeUndefined();
    const [extractionId, memberId] = committed.affected;
    expect(committed.affected.slice(0, 2)).toEqual([extractionId, memberId]);
    const member = committed.document.building?.elements[memberId ?? ''];
    if (member === undefined || member.category !== 'member') throw new Error('no member created');
    expect(member).toMatchObject({ profile: 'IPE300', role: 'beam', start: [5, 1, 4], end: [5, 3, 4] });
    expect(member.asBuilt).toEqual({ extractionId, unverified: false });
    const record = committed.document.scan?.extractions[extractionId ?? ''];
    expect(record).toMatchObject({ kind: 'steel_member', status: 'computed', createdElementIds: [memberId] });
    expect(committed.summary).toContain("IPE300, from 'IPE 300'");
    expect(committed.document.order).toEqual(['member-1:body']);
    expect(execute(committed.document, 'commit_asbuilt_extraction', { extraction }, ctx).summary).toContain('SCN_EXTRACTION_DUPLICATE');
  });

  it('turns a vertical member into a column, honours an explicit role and subtracts the level elevation', () => {
    const upright = answer('HEA 200', { axisDirection: [0, 0, 1], start: [1, 1, 3], end: [1, 1, 6] });
    const ctx = context(() => opOk(upright));
    const { doc, cloudId } = setup(ctx);
    const leveled = execute(doc, 'add_level', { name: 'L2', elevation: 3 }).document;
    const levelId = Object.values(leveled.building?.levels ?? {}).find((level) => level.elevation === 3)?.id;
    const extraction = fromStep(fit(leveled, cloudId, ctx).data, 'extractions.0.extraction');
    const committed = execute(leveled, 'commit_asbuilt_extraction', { extraction, levelId }, ctx);
    const member = committed.document.building?.elements[committed.affected[1] ?? ''];
    if (member === undefined || member.category !== 'member') throw new Error('no member created');
    expect(member).toMatchObject({ profile: 'HEA200', role: 'column', start: [1, 1, 0], end: [1, 1, 3], levelId });
    const brace = execute(leveled, 'commit_asbuilt_extraction', { extraction, levelId, role: 'brace' }, ctx);
    expect(brace.document.building?.elements[brace.affected[1] ?? '']).toMatchObject({ role: 'brace' });
  });

  it('refuses a profile that is not in the catalogue by name, without touching the document', () => {
    const ctx = context(() => opOk(answer('IPE 301')));
    const { doc, cloudId } = setup(ctx);
    const extraction = fromStep(fit(doc, cloudId, ctx).data, 'extractions.0.extraction');
    const result = execute(doc, 'commit_asbuilt_extraction', { extraction }, ctx);
    expect(result.summary).toContain('SCN_STEEL_PROFILE_UNKNOWN');
    expect(result.summary).toContain("'IPE 301'");
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });

  it('refuses a tampered extraction, and a steel fit without its axis', () => {
    const ctx = context(() => opOk(answer()));
    const { doc, cloudId } = setup(ctx);
    const extraction = fromStep(fit(doc, cloudId, ctx).data, 'extractions.0.extraction') as Record<string, unknown>;
    const fitRecord = extraction['fit'] as Record<string, unknown>;
    const tampered = { ...extraction, fit: { ...fitRecord, profile: 'HEB300' } };
    expect(execute(doc, 'commit_asbuilt_extraction', { extraction: tampered }, ctx).summary).toContain('SCN_EXTRACTION_TAMPERED');
    const bare = { ...extraction, fit: { profile: 'IPE300' }, extractionHash: 'x' };
    expect(execute(doc, 'commit_asbuilt_extraction', { extraction: bare }, ctx).summary).toContain('SCN_EXTRACTION_TAMPERED');
  });

  it('flags the member unverified from the fit quality, keeps the human gate, replays without the port and is pure', () => {
    const ctx = context(() => opOk(answer('IPE300', {}, [{ code: 'SCN_STEEL_LOW_COVERAGE', message: 'one-sided' }])));
    const { doc, cloudId } = setup(ctx);
    const extraction = fromStep(fit(doc, cloudId, ctx).data, 'extractions.0.extraction');
    expectPure(doc, () => execute(doc, 'commit_asbuilt_extraction', { extraction }, ctx));
    const committed = execute(doc, 'commit_asbuilt_extraction', { extraction }, ctx);
    const member = committed.document.building?.elements[committed.affected[1] ?? ''];
    expect(member).toMatchObject({ asBuilt: { unverified: true } });
    const accepted = execute(committed.document, 'accept_asbuilt_extraction', { extractionId: committed.affected[0] }, ctx);
    expect(accepted.summary).toContain('SCN_HUMAN_GATE');
    const replayed = execute(committed.document, 'replay_history', {});
    expect(JSON.stringify(replayed.document.building)).toBe(JSON.stringify(committed.document.building));
  });

  it('normalises designations by one documented rule', () => {
    expect(['IPE 300', 'ipe300', 'IPE-300', 'Ipe_300', ' IPE  300 '].map(normaliseDesignation)).toEqual(Array(5).fill('IPE300'));
  });
});
