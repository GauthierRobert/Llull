/**
 * fit_steel_member (plant 10 §5.7, VC-SCN-23): the outlines sent to the native op, unit conversion of its answer, the add_steel_member roll,
 * parameter and native refusals, purity. The section matching is tested natively (llull-cloud tests/steel.rs).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CloudOp, CloudOpResult } from '@core/model/pointCloud';
import type { ExecutionContext } from '@core/commands/types';
import { memberRoll } from '@aec/scan/steelFitCommand';
import { sweepFrame } from '@aec/shared/mesh';
import { expectPure } from '../../helpers/expectNoOp';
import { fixturePort, KEY_A, opOk } from './fixturePort';

/** The native answer for an IPE 300 along +x at z = 3 m (metres): depth up, so the roll is 0. */
const answer = (warnings: { code: string; message: string }[] = []): Record<string, unknown> => ({
  axisDirection: [1, 0, 0],
  start: [0, 0, 3],
  end: [2, 0, 3],
  length: 2,
  pointsInRegion: 5000,
  sectionPoints: 1500,
  rms: 0.0004,
  threshold: { value: 0.0015, source: '3 x noiseSigma', spacing: 0.01 },
  warnings,
  candidates: [
    {
      profile: 'IPE300',
      score: 0.0004,
      rollDeg: 0,
      flipped: false,
      depthDirection: [0, 0, 1],
      widthDirection: [0, -1, 0],
      axisDirection: [1, 0, 0],
      h: 0.3012,
      b: 0.1491,
      centre: [1, 0, 3],
    },
    { profile: 'NOT_IN_CATALOGUE', score: 0.002, rollDeg: 10, flipped: true, h: 0.3, b: 0.15 },
  ],
});

function context(reply: (op: CloudOp) => CloudOpResult): { ctx: ExecutionContext; ops: CloudOp[] } {
  const port = fixturePort([{ key: KEY_A, points: [[0, 0, 0]] }], reply);
  return { ctx: { ...defaultContext(), pointClouds: port }, ops: port.ops };
}

function attached(ctx: ExecutionContext): { doc: CadDocument; cloudId: string } {
  const result = execute(createEmptyDocument(), 'attach_point_cloud', { assetKey: KEY_A }, ctx);
  return { doc: result.document, cloudId: result.affected[0] ?? '' };
}

const region = { kind: 'all' };
const fit = (doc: CadDocument, cloudId: string, ctx: ExecutionContext, extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(doc, 'fit_steel_member', { cloudId, region, ...extra }, ctx);

describe('fit_steel_member', () => {
  it('sends catalogue outlines in metres and returns the ranked candidates in document units', () => {
    const { ctx, ops } = context(() => opOk(answer()));
    const { doc, cloudId } = attached(ctx);
    const result = fit(doc, cloudId, ctx, { noiseSigma: 0.5, axisHint: [1, 0, 0], maxCandidates: 2, seed: 4 });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('best IPE300');
    const op = ops[ops.length - 1];
    expect(op?.kind).toBe('steel');
    const params = op?.params as { outlines: { name: string; loopXy: number[][] }[]; noiseSigma: number; axisHint: number[]; seed: number };
    const ipe = params.outlines.find((o) => o.name === 'IPE300');
    expect(Math.max(...(ipe?.loopXy.map((p) => p[1] ?? 0) ?? []))).toBeCloseTo(0.15, 9);
    expect(params.outlines.some((o) => o.name.startsWith('FL') || o.name.startsWith('RD'))).toBe(false);
    expect(params.outlines.some((o) => o.name.startsWith('SHS') || o.name.startsWith('L'))).toBe(true);
    expect(params.noiseSigma).toBeCloseTo(0.0005, 12);
    expect(params.axisHint).toEqual([1, 0, 0]);
    const data = result.data as {
      candidates: { profile: string; family: string | null; hDeltaMm: number | null; scoreMm: number }[];
      addSteelMember: { profile: string; start: number[]; end: number[]; roll: number };
      measured: { hMm: number; twMm: null };
      member: { length: number };
    };
    expect(data.candidates[0]).toMatchObject({ profile: 'IPE300', family: 'IPE' });
    expect(data.candidates[0]?.hDeltaMm).toBeCloseTo(1.2, 6);
    expect(data.candidates[1]).toMatchObject({ family: null, hDeltaMm: null });
    expect(data.addSteelMember).toMatchObject({ profile: 'IPE300', start: [0, 0, 3000], end: [2000, 0, 3000] });
    expect(data.addSteelMember.roll).toBeCloseTo(0, 9);
    expect(data.member.length).toBeCloseTo(2000, 6);
    expect(data.measured.twMm).toBeNull();
  });

  it('searches the named families only, flat and round bars included on request', () => {
    const { ctx, ops } = context(() => opOk(answer()));
    const { doc, cloudId } = attached(ctx);
    fit(doc, cloudId, ctx, { families: ['FL'] });
    const names = (ops[ops.length - 1]?.params as { outlines: { name: string }[] }).outlines.map((o) => o.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.startsWith('FL'))).toBe(true);
  });

  it('carries the no-match warning', () => {
    const { ctx } = context(() => opOk(answer([{ code: 'SCN_STEEL_NO_MATCH', message: 'built-up' }])));
    const { doc, cloudId } = attached(ctx);
    const result = fit(doc, cloudId, ctx);
    expect(result.summary).toContain('SCN_STEEL_NO_MATCH');
    expect((result.data as { warnings: unknown[] }).warnings).toHaveLength(1);
  });

  it('is pure', () => {
    const { ctx } = context(() => opOk(answer()));
    const { doc, cloudId } = attached(ctx);
    expectPure(doc, () => fit(doc, cloudId, ctx));
  });

  it('refuses bad parameters by name without calling the port', () => {
    const { ctx, ops } = context(() => opOk(answer()));
    const { doc, cloudId } = attached(ctx);
    for (const extra of [
      { families: ['XYZ'] },
      { families: [] },
      { noiseSigma: 0 },
      { distanceThreshold: -1 },
      { axisHint: [0, 0, 0] },
      { axisHint: [1e-12, 0, 0] },
    ]) {
      const result = fit(doc, cloudId, ctx, extra);
      expect(result.summary).toContain('SCN_PARAM_INVALID');
      expect(result.affected).toEqual([]);
    }
    expect(ops).toHaveLength(0);
  });

  it('refuses an unknown cloud, a bad region and a malformed answer', () => {
    const { ctx } = context(() => opOk({ candidates: [] }));
    const { doc, cloudId } = attached(ctx);
    expect(fit(doc, 'cloud-9.9', ctx).summary).toContain('SCN_CLOUD_NOT_FOUND');
    expect(fit(doc, cloudId, ctx, { region: { kind: 'crop', cropId: 'nope' } }).summary).toContain('SCN_CROP_NOT_FOUND');
    expect(fit(doc, cloudId, ctx).summary).toContain('NATIVE_PROTOCOL');
  });

  it('turns a native refusal into its coded no-op', () => {
    const { ctx } = context(() => ({ ok: false, code: 'SCN_STEEL_NO_CANDIDATE', message: 'no outline within the gate' }));
    const { doc, cloudId } = attached(ctx);
    const result = fit(doc, cloudId, ctx);
    expect(result.summary).toContain('SCN_STEEL_NO_CANDIDATE');
    expect(result.document).toBe(doc);
  });

  it('derives the add_steel_member roll from the depth direction (sweep frame: up, then side = up x axis)', () => {
    expect(memberRoll([0, 0, 0], [1, 0, 0], [0, 0, 1])).toBeCloseTo(0, 9);
    expect(memberRoll([0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeCloseTo(Math.PI / 2, 9);
    expect(memberRoll([0, 0, 0], [0, 0, 1], [1, 0, 0])).toBeCloseTo(0, 9);
    expect(memberRoll([0, 0, 0], [0, 0, 2], [0, 1, 0])).toBeCloseTo(-Math.PI / 2, 9);
    expect(memberRoll([1, 1, 1], [1, 1, 1], [0, 0, 1])).toBe(0);
  });

  it('subtracts the level elevation: add_steel_member on the proposal reproduces the fitted frame and position', () => {
    const tilted = {
      ...answer(),
      candidates: [{ ...(answer()['candidates'] as Record<string, unknown>[])[0], depthDirection: [0, 0.6, 0.8] }],
    };
    const { ctx } = context(() => opOk({ ...tilted, start: [0, 0, 7.2], end: [2, 0, 7.2] }));
    const attachedDoc = attached(ctx);
    const { cloudId } = attachedDoc;
    let { doc } = attachedDoc;
    doc = execute(doc, 'add_level', { name: 'L1', elevation: 0 }).document;
    doc = execute(doc, 'add_level', { name: 'L2', elevation: 3600 }).document;
    const levels = Object.values(doc.building?.levels ?? {});
    const second = levels.find((level) => level.elevation === 3600);
    expect(second).toBeDefined();
    for (const levelId of [undefined, second?.id]) {
      const fitted = fit(doc, cloudId, ctx, levelId === undefined ? {} : { levelId });
      const proposal = (
        fitted.data as { addSteelMember: { profile: string; start: number[]; end: number[]; roll: number; levelId?: string } }
      ).addSteelMember;
      expect(proposal.levelId).toBe(second?.id);
      expect(proposal.start).toEqual([0, 0, 3600]);
      const built = execute(fitted.document, 'add_steel_member', proposal, ctx);
      const element = Object.values(built.document.building?.elements ?? {}).find((e) => e.category === 'member');
      if (element === undefined || element.category !== 'member') throw new Error('no member created');
      const world = [element.start[0], element.start[1], element.start[2] + (second?.elevation ?? 0)];
      expect(world).toEqual([0, 0, 7200]);
      const frame = sweepFrame(world as [number, number, number], [2000, 0, 7200], element.roll);
      expect(frame?.v[1]).toBeCloseTo(0.6, 9);
      expect(frame?.v[2]).toBeCloseTo(0.8, 9);
    }
  });

  it('refuses an unknown level and a non-finite axis hint, converts the threshold to document units', () => {
    const { ctx } = context(() => opOk(answer()));
    const { doc, cloudId } = attached(ctx);
    expect(fit(doc, cloudId, ctx, { levelId: 'level-9' }).summary).toContain('SCN_PARAM_INVALID');
    expect(fit(doc, cloudId, ctx, { axisHint: [1e-12, 0, 0] }).summary).toContain('SCN_PARAM_INVALID');
    const ok = fit(doc, cloudId, ctx);
    expect((ok.data as { threshold: { value: number; spacing: number } }).threshold).toMatchObject({ value: 1.5, spacing: 10 });
  });

  it('flags a low-coverage fit as unverified and turns the new native refusals into coded no-ops', () => {
    const low = context(() => opOk(answer([{ code: 'SCN_STEEL_LOW_COVERAGE', message: 'one-sided' }])));
    const { doc, cloudId } = attached(low.ctx);
    expect((fit(doc, cloudId, low.ctx).data as { unverified: boolean }).unverified).toBe(true);
    for (const code of ['SCN_STEEL_AXIS_AMBIGUOUS', 'SCN_STEEL_NO_CANDIDATE']) {
      const refused = context(() => ({ ok: false, code, message: 'x' }));
      const result = fit(doc, cloudId, refused.ctx);
      expect(result.summary).toContain(code);
      expect(result.affected).toEqual([]);
    }
  });
});
