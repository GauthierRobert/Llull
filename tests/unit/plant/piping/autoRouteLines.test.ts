/**
 * Plant 02 RTE V2: several lines in one transaction (`auto_route_lines`, `route_lines_order`). The scene is a wall across x = 5000 with one 400 x 400
 * hole at the origin height (four keep-out boxes): a DN100 pipe in the hole (inflated by 57.15 + 50 = 107.15 mm each side) fills it, so the
 * second line has to go around the wall (only possible for a line given a wide gridMargin) or fails.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { cs150Document } from './rteFixtures';

type Box = { min: number[]; max: number[] };

/** Wall across x = 5000 (100 thick), 1000 each way from the origin, with a 400 x 400 hole. */
const WALL: Box[] = [
  { min: [4950, -1000, 200], max: [5050, 1000, 1000] },
  { min: [4950, -1000, -1000], max: [5050, 1000, -200] },
  { min: [4950, -1000, -200], max: [5050, -200, 200] },
  { min: [4950, 200, -200], max: [5050, 1000, 200] },
];

interface Scene {
  doc: CadDocument;
  /** X: straight through the hole (wide grid box, can go around); Y: 400 above it (narrow grid box, cannot). */
  lines: Record<string, unknown>[];
  x: string;
  y: string;
}

function scene(): Scene {
  let doc = cs150Document();
  const ids: string[] = [];
  for (const sequence of ['9001', '9002']) {
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence, spec: 'CS150', dn: 100 });
    ids.push(doc.plant?.piping?.lineOrder.at(-1) as string);
  }
  const [x, y] = ids as [string, string];
  const line = (lineId: string, x: number, z: number, gridMargin: number): Record<string, unknown> => ({
    lineId,
    from: { point: [x, 0, z], direction: [1, 0, 0] },
    to: { point: [10000 - x, 0, z], direction: [-1, 0, 0] },
    gridMargin,
  });
  return { doc, x, y, lines: [line(x, 0, 0, 1600), line(y, 1000, 400, 400)] };
}

interface LinesData {
  order: string[];
  attempts: { order: string[]; routed: number }[];
  lines: { lineId: string; status: string; runId?: string; code?: string; engine?: string; centrelineToPiLengthMm?: number }[];
  routed: number;
  failed: number;
  complete: boolean;
}

const params = (s: Scene, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  lines: s.lines,
  common: { keepOutBoxes: WALL, grid: 200 },
  ...extra,
});

describe('auto_route_lines: automatic order and retry', () => {
  it('routes the first line through the hole, fails the second, promotes it and routes both on the second pass', () => {
    const s = scene();
    const result = ok(s.doc, 'auto_route_lines', params(s));
    const routed = result.data as LinesData;
    expect(routed.complete).toBe(true);
    expect(routed.attempts.map((attempt) => [attempt.order, attempt.routed])).toEqual([
      [[s.x, s.y], 1],
      [[s.y, s.x], 2],
    ]);
    expect(routed.order).toEqual([s.y, s.x]);
    const piping = result.document.plant?.piping;
    // The committed order is the routing order; run ids follow the request position (X first in the request, so .1).
    expect(piping?.runOrder.map((id) => piping.runs[id]?.lineId)).toEqual([s.y, s.x]);
    const [runY, runX] = piping?.runOrder as [string, string];
    expect(runX).toMatch(/\.1$/);
    expect(runY).toMatch(/\.2$/);
    expect(result.affected).toEqual([runY, runX]);
    expect(routed.lines.map((line) => [line.lineId, line.status, line.runId, line.engine])).toEqual([
      [s.y, 'routed', runY, 'ts'],
      [s.x, 'routed', runX, 'ts'],
    ]);
    // Y (8000 apart, 400 up) went through the hole: 8000 + 2 x 400; X went around the wall edge: 1000 + 107.15 clears on the next 200 mm lattice line, y or z 1200: 10000 + 2 x 1200.
    const length = (lineId: string): number => routed.lines.find((line) => line.lineId === lineId)?.centrelineToPiLengthMm ?? 0;
    expect(length(s.y)).toBeCloseTo(8800, 6);
    expect(length(s.x)).toBeCloseTo(12400, 6);
    expect(result.summary).toContain('routed 2 of 2 line(s)');
    expect(result.summary).toContain('pass 2 of 2');
  });

  it('is deterministic and pure: the same document gives the same document and the input is untouched', () => {
    const s = scene();
    const before = JSON.stringify(s.doc);
    const first = execute(s.doc, 'auto_route_lines', params(s));
    expect(JSON.stringify(s.doc)).toBe(before);
    const second = execute(s.doc, 'auto_route_lines', params(s));
    expect(JSON.stringify(second.document.plant)).toBe(JSON.stringify(first.document.plant));
    expect(second.data).toEqual(first.data);
  });

  it('order given: the request order, one pass (here the second line first, so both route at once)', () => {
    const s = scene();
    const result = ok(s.doc, 'auto_route_lines', { ...params(s), lines: [...s.lines].reverse(), order: 'given' });
    const routed = result.data as LinesData;
    expect(routed.attempts).toHaveLength(1);
    expect(routed.order).toEqual([s.y, s.x]);
    expect(routed.complete).toBe(true);
  });

  it('all or nothing: with one pass the second line fails and nothing changes (RTE_AUTOROUTE_LINES_FAILED, per-line detail)', () => {
    const s = scene();
    const refusal = expectRefusal(s.doc, 'auto_route_lines', params(s, { maxAttempts: 1 }), 'RTE_AUTOROUTE_LINES_FAILED', 'lines.1');
    expect(refusal.error?.ids).toEqual([s.y]);
    expect(refusal.summary).toContain(`${s.y} RTE_AUTOROUTE_NO_PATH`);
    const detail = refusal.error?.detail as unknown as LinesData;
    expect(detail.lines.map((line) => [line.lineId, line.status])).toEqual([
      [s.x, 'routed'],
      [s.y, 'failed'],
    ]);
  });

  it('partial: keeps the line that routed and reports the other', () => {
    const s = scene();
    const result = ok(s.doc, 'auto_route_lines', params(s, { maxAttempts: 1, partial: true }));
    expect(result.data as LinesData).toMatchObject({ routed: 1, failed: 1, complete: false });
    expect(result.document.plant?.piping?.runOrder).toHaveLength(1);
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toContain('routed 1 of 2 line(s)');
    expect(result.summary).toContain('not routed:');
  });

  it('nothing routable is a refusal even with partial, and a line that fails first is not retried', () => {
    const s = scene();
    const closed = [...WALL, { min: [4950, -200, -200], max: [5050, 200, 200] }];
    const lonely = { ...params(s), lines: [s.lines[1]], partial: true, common: { keepOutBoxes: closed, grid: 200 } };
    const refusal = expectRefusal(s.doc, 'auto_route_lines', lonely, 'RTE_AUTOROUTE_LINES_FAILED', 'lines.0');
    expect((refusal.error?.detail as unknown as LinesData).attempts).toHaveLength(1);
    expect(refusal.summary).toContain('RTE_AUTOROUTE_NO_PATH');
  });

  it('sequence: routes the listed lines in that order, skips the others, and mints ids by request position', () => {
    const s = scene();
    const result = ok(s.doc, 'auto_route_lines', { ...params(s), order: 'given', sequence: [s.y], partial: true });
    const routed = result.data as LinesData;
    expect(routed.lines.map((line) => [line.lineId, line.status])).toEqual([
      [s.y, 'routed'],
      [s.x, 'skipped'],
    ]);
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0]).toMatch(/.2$/);
    expectRefusal(s.doc, 'auto_route_lines', { ...params(s), order: 'given', sequence: [s.y] }, 'RTE_AUTOROUTE_LINES_FAILED');
    expectRefusal(s.doc, 'auto_route_lines', { ...params(s), sequence: [s.y] }, 'RTE_AUTOROUTE_LINES_INVALID', 'sequence');
    expectRefusal(
      s.doc,
      'auto_route_lines',
      { ...params(s), order: 'given', sequence: [s.y, s.y] },
      'RTE_AUTOROUTE_LINES_INVALID',
      'sequence',
    );
    expectRefusal(
      s.doc,
      'auto_route_lines',
      { ...params(s), order: 'given', sequence: ['nope'] },
      'RTE_AUTOROUTE_LINES_INVALID',
      'sequence',
    );
  });

  it('refuses a line listed twice and solutions without order given', () => {
    const s = scene();
    expectRefusal(
      s.doc,
      'auto_route_lines',
      { ...params(s), lines: [s.lines[0], s.lines[0]] },
      'RTE_AUTOROUTE_LINES_INVALID',
      'lines.1.lineId',
    );
    const solution = { problemHash: 'x', pis: [], lengthMm: 0, bends: 0, cost: 0, optimal: true, expansions: 0, engine: 'x' };
    expectRefusal(
      s.doc,
      'auto_route_lines',
      { ...params(s), lines: [{ ...(s.lines[0] as object), solution }] },
      'RTE_AUTOROUTE_LINES_INVALID',
      'lines.0.solution',
    );
  });

  it('given + solutions: each solution is validated against the problem of its turn (hashes do not depend on run ids)', () => {
    const s = scene();
    const extra = { keepOutBoxes: WALL, grid: 200 };
    interface Routed {
      pis: number[][];
      centrelineToPiLengthMm: number;
      bends: number;
      cost: number;
      problemHash: string;
    }
    const first = ok(s.doc, 'auto_route_pipe', { ...(s.lines[1] as object), ...extra });
    const second = ok(first.document, 'auto_route_pipe', { ...(s.lines[0] as object), ...extra });
    const solved = (entry: Routed): Record<string, unknown> => ({
      problemHash: entry.problemHash,
      pis: entry.pis,
      lengthMm: entry.centrelineToPiLengthMm,
      bends: entry.bends,
      cost: entry.cost,
      optimal: true,
      expansions: 1,
      engine: 'llull-route',
    });
    const lines = [
      { ...(s.lines[1] as object), solution: solved(first.data as unknown as Routed) },
      { ...(s.lines[0] as object), solution: solved(second.data as unknown as Routed) },
    ];
    const result = ok(s.doc, 'auto_route_lines', { ...params(s), lines, order: 'given' });
    expect((result.data as LinesData).lines.map((line) => line.engine)).toEqual(['llull-route', 'llull-route']);
    const stale = [lines[0], { ...lines[1], solution: { ...solved(second.data as unknown as Routed), problemHash: 'stale' } }];
    const refusal = expectRefusal(s.doc, 'auto_route_lines', { ...params(s), lines: stale, order: 'given' }, 'RTE_AUTOROUTE_LINES_FAILED');
    expect(refusal.summary).toContain('RTE_AUTOROUTE_SOLUTION_INVALID');
  });
});

describe('route_lines_order', () => {
  it('orders by DN descending, then distance descending, then request position; promoted lines first', () => {
    let doc = cs150Document();
    const make = (sequence: string, dn: number): string => {
      doc = apply(doc, 'create_pipeline', { service: 'P', sequence, spec: 'CS150', dn });
      return doc.plant?.piping?.lineOrder.at(-1) as string;
    };
    const small = make('1', 100);
    const wideShort = make('2', 150);
    const wideLong = make('3', 150);
    const tie = make('4', 150);
    const line = (lineId: string, length: number): Record<string, unknown> => ({
      lineId,
      from: { point: [0, 0, 0], direction: [1, 0, 0] },
      to: { point: [length, 0, 0], direction: [-1, 0, 0] },
    });
    const lines = [line(small, 9000), line(wideShort, 2000), line(wideLong, 6000), line(tie, 2000)];
    const answer = data<{ order: string[]; rule: string; lines: { dn: number; distanceMm: number }[] }>(doc, 'route_lines_order', {
      lines,
    });
    expect(answer.order).toEqual([wideLong, wideShort, tie, small]);
    expect(answer.lines.map((entry) => [entry.dn, entry.distanceMm])).toEqual([
      [100, 9000],
      [150, 2000],
      [150, 6000],
      [150, 2000],
    ]);
    expect(answer.rule).toContain('DN descending');
    expect(data<{ order: string[] }>(doc, 'route_lines_order', { lines, promote: [small, tie] }).order).toEqual([
      small,
      tie,
      wideLong,
      wideShort,
    ]);
    const unknown = data<{ order: string[] }>(doc, 'route_lines_order', { lines: [line('nope', 5000), line(small, 1)] });
    expect(unknown.order).toEqual([small, 'nope']);
  });
});
