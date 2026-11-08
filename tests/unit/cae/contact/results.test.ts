/** PHY-06 contact results (TR-CNT-10, FR-CNT-04, FR-CNT-17): frd CONTACT reader, contact_report and check_contact on recorded results. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { parseFrd } from '@cae/results/frdReader';
import { meshSummary } from '@cae/results/summary';
import { hashOf, portOf } from '../deckFixtures';
import { blocks, blocksMesh, frdContact, must, pairParams, solve, type Blocks } from './support';

/** [COPEN, CSLIP1, CSLIP2, CPRESS, CSHEAR1, CSHEAR2] at the four slave nodes 9..12. */
const uniform = (pressure: number, shear: number, open = -1e-5): Record<number, number[]> =>
  Object.fromEntries([9, 10, 11, 12].map((node) => [node, [open, 0.01, 0, pressure, shear, 0]]));

function solvedPair(
  extra: Record<string, unknown> = {},
  frd?: (b: Blocks) => string,
  holdUpper = true,
): ReturnType<typeof solve> & { b: Blocks; pairId: string } {
  const b = blocks({ holdUpper });
  const added = must(b.doc, 'add_contact_pair', pairParams(b, { friction: { mu: 0.2 }, ...extra }));
  const pairId = added.affected[1] ?? '';
  return { ...solve(b, added.doc, [pairId], frd?.(b) ?? frdContact(1, 1, uniform(10, 2))), b, pairId };
}

const rowsOf = (data: unknown): Record<string, unknown>[] => (data as { rows: Record<string, unknown>[] }).rows;
const codes = (data: unknown): string[] => (data as { items: { code: string }[] }).items.map((entry) => entry.code);

describe('frd CONTACT reader', () => {
  it('reads the CONTACT block of a real CalculiX 2.21 node-to-surface run (pinned excerpt): six components, values by slave node', () => {
    const [set] = parseFrd(readFileSync('tests/unit/cae/fixtures/ccx221_contact_excerpt.frd', 'utf8'));
    expect(set?.step).toBe(2);
    expect(set?.fields['CONTACT']?.components).toEqual(['COPEN', 'CSLIP1', 'CSLIP2', 'CPRESS', 'CSHEAR1', 'CSHEAR2']);
    const values = set?.fields['CONTACT']?.values['596'] ?? [];
    expect(values[0]).toBeLessThan(0);
    expect(values[3]).toBeCloseTo(8.02472, 5);
    expect((values[4] ?? 0) / (values[3] ?? 1)).toBeCloseTo(0.2, 4);
  });
});

describe('contact_report', () => {
  it('integrates a uniform contact over the slave face: closed 100 %, sliding at mu p, force = p x area, penetration = -COPEN, is pure', () => {
    const { doc, ctx, b, pairId } = solvedPair();
    const before = structuredClone(doc);
    const result = execute(doc, 'contact_report', { analysisId: b.analysisId }, ctx);
    expect(result.error).toBeUndefined();
    expect(doc).toEqual(before);
    expect(result.affected).toEqual([]);
    const [row] = rowsOf(result.data);
    expect(row).toMatchObject({
      pairId,
      stepId: b.stepId,
      solverStep: 1,
      closedAreaFraction: 1,
      slidingAreaFraction: 1,
      maxSlip: 0.01,
      maxPenetration: 1e-5,
    });
    expect(row?.['normalForce']).toBeCloseTo(10, 12);
    expect(row?.['shearForce']).toBeCloseTo(2, 12);
    expect(row?.['meanPressure']).toBeCloseTo(10, 12);
    expect(row?.['totalArea']).toBeCloseTo(1, 12);
    expect(row?.['closedBox']).toEqual({ min: [0, 0, 1], max: [1, 1, 1] });
    const data = result.data as { pairs: { friction: { stickSlope: { value: number; defaulted: boolean } } }[]; reviewRequired: boolean };
    expect(data.pairs[0]?.friction.stickSlope).toMatchObject({ value: 105000, defaulted: true });
    expect(data.reviewRequired).toBe(true);
    expect(result.summary).toContain('not approved');
  });

  it('half-open contact: only the pressed nodes count, sticking nodes do not slide, filters by pair / step name, increments all', () => {
    const half = (): string =>
      [
        frdContact(1, 0.5, {
          9: [-1e-5, 0, 0, 10, 1, 0],
          10: [-1e-5, 0, 0, 10, 1, 0],
          11: [0.001, 0, 0, 0, 0, 0],
          12: [0.001, 0, 0, 0, 0, 0],
        }),
        frdContact(
          1,
          1,
          { 9: [-1e-5, 0, 0, 10, 1, 0], 10: [-1e-5, 0, 0, 10, 1, 0], 11: [0.001, 0, 0, 0, 0, 0], 12: [0.001, 0, 0, 0, 0, 0] },
          undefined,
          2,
        ),
      ].join('\n');
    const { doc, ctx, b } = solvedPair({}, half);
    const all = execute(doc, 'contact_report', { analysisId: b.analysisId, pair: 'stack', step: 'press', increments: 'all' }, ctx);
    const rows = rowsOf(all.data);
    expect(rows.map((row) => row['time'])).toEqual([0.5, 1]);
    const last = rows[1] ?? {};
    expect(last['closedAreaFraction']).toBeGreaterThan(0);
    expect(last['closedAreaFraction']).toBeLessThan(1);
    expect(last['slidingAreaFraction']).toBe(0);
    expect(rowsOf(execute(doc, 'contact_report', { analysisId: b.analysisId }, ctx).data)).toHaveLength(1);
  });

  it('refuses without pairs, an unknown pair / step, stale, missing or contact-less results', () => {
    const { doc, ctx, b } = solvedPair();
    const refuse = (params: Record<string, unknown>, context: ExecutionContext = ctx, on = doc): string | undefined =>
      execute(on, 'contact_report', { analysisId: b.analysisId, ...params }, context).error?.code;
    expect(refuse({ pair: 'nope' })).toBe('CNT_PAIR_NOT_FOUND');
    expect(refuse({ step: 'nope' })).toBe('NLS_STEP_NOT_FOUND');
    expect(refuse({}, defaultContext())).toBe('FEA_RESULTS_MISSING');
    const changed = must(doc, 'update_contact_pair', { analysisId: b.analysisId, pair: 'stack', friction: { mu: 0.3 } }).doc;
    expect(refuse({}, ctx, changed)).toBe('FEA_RESULTS_STALE');
    const judged = must(doc, 'update_contact_pair', { analysisId: b.analysisId, pair: 'stack', noSlipRequired: true }).doc;
    expect(refuse({}, ctx, judged)).toBeUndefined();
    expect(refuse({}, ctx, blocks().doc)).toBe('CNT_PAIR_NOT_FOUND');
    const other = solvedPair({}, () => frdContact(1, 1, uniform(10, 2), ['COPEN', 'CPRESS']));
    expect(execute(other.doc, 'contact_report', { analysisId: other.b.analysisId }, other.ctx).error?.code).toBe(
      'CNT_CONTACT_RESULTS_MISSING',
    );
    expect(execute(other.doc, 'contact_report', { analysisId: 'an-404' }, other.ctx).error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
  });
});

describe('check_contact', () => {
  it('set-up: a part held only by contact (VC-CNT-65), then passes the same model with a guide; is pure', () => {
    const b = blocks();
    const added = must(b.doc, 'add_contact_pair', pairParams(b));
    const before = structuredClone(added.doc);
    const loose = execute(added.doc, 'check_contact', { analysisId: b.analysisId });
    expect(added.doc).toEqual(before);
    expect(codes(loose.data)).toEqual(['CNT_RIGID_BODY_BY_CONTACT_ONLY']);
    expect((loose.data as { status: string }).status).toBe('warn');
    const held = blocks({ holdUpper: true });
    const ok = execute(must(held.doc, 'add_contact_pair', pairParams(held)).doc, 'check_contact', { analysisId: held.analysisId });
    expect((ok.data as { status: string; notes: string[] }).status).toBe('pass');
    expect((ok.data as { notes: string[] }).notes.join()).toContain('initial overclosure not measured');
    expect(codes(execute(blocks().doc, 'check_contact', { analysisId: b.analysisId }).data)).toEqual([]);
  });

  it('measures the initial overclosure on the recorded mesh beyond adjust (VC-CNT-65: CNT_INITIAL_OVERCLOSURE)', () => {
    const meshed = (adjust: number | undefined): string[] => {
      const b = blocks({ holdUpper: true });
      const added = must(
        b.doc,
        'add_contact_pair',
        pairParams(b, adjust === undefined ? {} : { adjust: { kind: 'clearance', value: adjust } }),
      );
      const mesh = blocksMesh(b, added.doc, [added.affected[1] ?? ''], -0.01);
      const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: portOf(mesh) };
      const recorded = must(added.doc, 'record_fe_mesh', { analysisId: b.analysisId, summary: meshSummary(mesh, hashOf(mesh)) }, ctx);
      return codes(execute(recorded.doc, 'check_contact', { analysisId: b.analysisId }, ctx).data);
    };
    expect(meshed(undefined)).toEqual(['CNT_INITIAL_OVERCLOSURE']);
    expect(meshed(0.02)).toEqual([]);
  });

  it('results: penetration against the tolerance, tolerance unset, slip on a no-slip pair, non-convergence, stale results', () => {
    const { doc, ctx, b } = solvedPair({ noSlipRequired: true });
    expect(codes(execute(doc, 'check_contact', { analysisId: b.analysisId }, ctx).data)).toEqual([
      'CNT_PENETRATION_TOLERANCE_UNSET',
      'CNT_SLIP',
    ]);
    const strict = execute(doc, 'check_contact', { analysisId: b.analysisId, penetrationTolerance: { value: 1e-6, source: 'test' } }, ctx);
    expect(codes(strict.data)).toEqual(['CNT_PENETRATION_EXCESSIVE', 'CNT_SLIP']);
    expect((strict.data as { status: string }).status).toBe('fail');
    const short = solvedPair({}, () => frdContact(1, 0.5, uniform(10, 1)));
    expect(
      codes(
        execute(
          short.doc,
          'check_contact',
          { analysisId: short.b.analysisId, penetrationTolerance: { value: 1, source: 'test' } },
          short.ctx,
        ).data,
      ),
    ).toEqual(['CNT_CONTACT_NOT_CONVERGED']);
    const changed = must(doc, 'update_contact_pair', { analysisId: b.analysisId, pair: 'stack', friction: { mu: 0.3 } }).doc;
    expect(codes(execute(changed, 'check_contact', { analysisId: b.analysisId }, ctx).data)).toContain('FEA_RESULTS_STALE');
    const missing = solvedPair({}, () => frdContact(1, 1, uniform(10, 2), ['COPEN']));
    expect(codes(execute(missing.doc, 'check_contact', { analysisId: missing.b.analysisId }, missing.ctx).data)).toContain(
      'CNT_CONTACT_RESULTS_MISSING',
    );
  });

  it('refuses a non-positive tolerance and a case that is not nonlinear', () => {
    const b = blocks();
    expect(execute(b.doc, 'check_contact', { analysisId: b.analysisId, penetrationTolerance: { value: 0, source: 'x' } }).error?.code).toBe(
      'CNT_INPUT_INVALID',
    );
    const linear = must(b.doc, 'create_analysis', { name: 'lin', analysisType: 'static' });
    expect(execute(linear.doc, 'check_contact', { analysisId: linear.affected[0] }).error?.code).toBe('NLS_CASE_NOT_NONLINEAR');
  });
});
