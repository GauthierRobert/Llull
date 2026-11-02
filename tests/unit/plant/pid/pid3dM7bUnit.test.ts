/** Plant 04 PID M7b on hand-built models: the bounded LCS, legacy spec bindings, merged legacy + routed lines, hostile keys, branch runs, end resolution. */

import { describe, expect, it } from 'vitest';
import { check3d } from '@aec/plant/pid/link3d/check';
import type { Run } from '@aec/plant/pid/link3d/common';
import { compareOrder } from '@aec/plant/pid/link3d/orderCompare';
import { longestCommonSubsequence, MAX_ORDER_CELLS, withinOrderBudget } from '@aec/plant/pid/link3d/sequence';
import type { PidLine, PidModel } from '@aec/plant/pid/model';
import { EMPTY_PID } from '@aec/plant/pid/state';
import { EMPTY_PIPING } from '@aec/plant/piping/model';
import { createEmptyBuilding } from '@aec/building/types';
import type { PipingModel } from '@aec/plant/types';

type Building = ReturnType<typeof createEmptyBuilding>;
const building = (elements: Record<string, unknown>): Building =>
  ({ ...createEmptyBuilding(), elements, elementOrder: Object.keys(elements) }) as unknown as Building;
const pidOf = (items: Record<string, unknown>): PidModel => ({ ...EMPTY_PID, items, itemOrder: Object.keys(items) }) as unknown as PidModel;
const norm = (s: string): string => s.toUpperCase().replace(/[\s_-]+/g, '');

/** A line L-1 from nozzle P-101/N1 to nozzle V-101/N1 whose primary segments carry the inline items `tags` in order. */
function pidWithLine(tags: readonly string[], pipingClass = 'A1'): PidModel {
  const items: Record<string, unknown> = {
    p: { id: 'p', kind: 'equipment', tag: 'P-101' },
    v: { id: 'v', kind: 'equipment', tag: 'V-101' },
    np: { id: 'np', kind: 'nozzle', equipmentId: 'p', subTag: 'N1' },
    nv: { id: 'nv', kind: 'nozzle', equipmentId: 'v', subTag: 'N1' },
  };
  const segmentIds: string[] = [];
  let from: unknown = { type: 'nozzle', itemId: 'np' };
  [...tags, undefined].forEach((tag, k) => {
    if (tag !== undefined) items[`i${k}`] = { id: `i${k}`, kind: 'inline', tag, dexpiClass: 'GateValve' };
    const to = tag === undefined ? { type: 'nozzle', itemId: 'nv' } : { type: 'inline', itemId: `i${k}`, node: 0 };
    items[`s${k}`] = { id: `s${k}`, kind: 'segment', lineId: 'l', from, to, primary: true };
    segmentIds.push(`s${k}`);
    from = tag === undefined ? from : { type: 'inline', itemId: `i${k}`, node: 1 };
  });
  items['l'] = { id: 'l', kind: 'line', lineNumber: 'L-1', segmentIds, pipingClass, dn: 100 };
  return pidOf(items);
}

const line = (pid: PidModel): PidLine => pid.items['l'] as PidLine;
const runOf = (tags: readonly string[]): Run => ({
  ids: ['r1'],
  label: 'L-1',
  key: 'L1',
  pipes: [],
  dns: [],
  specs: [],
  from: undefined,
  to: undefined,
  sequence: tags.map((tag, k) => ({ ids: [`c${k}`], label: tag, componentId: `c${k}`, type: 'valveGate', runId: 'r1', lineId: 'ln' })),
});

describe('longestCommonSubsequence and its bound', () => {
  it('finds a longest common subsequence', () => {
    expect(longestCommonSubsequence(['a', 'b', 'c', 'd'], ['b', 'd', 'a'])).toHaveLength(2);
    expect(longestCommonSubsequence(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(longestCommonSubsequence(['a'], ['b'])).toEqual([]);
    expect(longestCommonSubsequence([], ['b'])).toEqual([]);
  });

  it('states the cell cap', () => {
    expect(MAX_ORDER_CELLS).toBe(250_000);
    expect(withinOrderBudget(500, 500)).toBe(true);
    expect(withinOrderBudget(501, 500)).toBe(false);
  });

  it('compareOrder skips (coded) a line above the cap instead of running the quadratic table', () => {
    const tags = Array.from({ length: 501 }, (_, k) => `V-${k}`);
    const pid = pidWithLine(tags);
    const result = compareOrder(pid, line(pid), runOf(tags), norm);
    expect(result.findings).toEqual([]);
    expect(result.skips).toMatchObject([{ code: 'P3D_INLINE_ORDER_MISMATCH', reason: 'sequence_too_long', item: 'L-1' }]);
  });

  it('compareOrder at the cap still compares (500 x 500 shuffled tail is a finding)', () => {
    const tags = Array.from({ length: 500 }, (_, k) => `V-${k}`);
    const pid = pidWithLine(tags);
    const swapped = [...tags];
    [swapped[10], swapped[11]] = [tags[11] as string, tags[10] as string];
    const result = compareOrder(pid, line(pid), runOf(swapped), norm);
    expect(result.skips).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.values).toMatchObject({ lcsLength: 499 });
  });

  it('compareOrder has nothing to compare below two common tags', () => {
    const pid = pidWithLine(['V-1']);
    expect(compareOrder(pid, line(pid), runOf(['V-1']), norm)).toEqual({ findings: [], skips: [] });
  });

  it('counts a duplicated tag as an order difference (2 on the P&ID, 1 in 3D)', () => {
    const pid = pidWithLine(['V-1', 'V-2', 'V-1']);
    const result = compareOrder(pid, line(pid), runOf(['V-1', 'V-2']), norm);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.values['outOfPlace']).toBe('V-1');
  });
});

describe('legacy pipes with a spec binding', () => {
  const pipe = (specId: string | undefined, id = 'pipe-1'): Record<string, unknown> => ({
    id,
    category: 'pipe',
    mark: id,
    line: 'L-1',
    dn: 100,
    ...(specId === undefined ? {} : { spec: { specId } }),
  });
  const run = (specs: string[], pid = pidWithLine([])): ReturnType<typeof check3d> =>
    check3d(pid, building(Object.fromEntries(specs.map((s, k) => [`pipe-${k}`, pipe(s, `pipe-${k}`)]))), EMPTY_PIPING, 'lines', true);

  it('flags a different spec id and accepts the same one', () => {
    expect(run(['B2']).findings.map((f) => f.code)).toEqual(['P3D_SPEC_MISMATCH']);
    expect(run(['a1']).findings).toEqual([]);
  });

  it('compares the set of specs of a line with a spec break', () => {
    expect(run(['A1', 'B2']).findings.map((f) => f.values['modelSpec'])).toEqual(['A1/B2']);
  });

  it('skips (coded) a legacy pipe without a spec binding', () => {
    const result = check3d(pidWithLine([]), building({ 'pipe-1': pipe(undefined) }), EMPTY_PIPING, 'lines', true);
    expect(result.findings).toEqual([]);
    expect(result.skipped).toMatchObject([{ code: 'P3D_SPEC_MISMATCH', reason: 'no_3d_spec' }]);
  });

  it('uses the segment piping class over the line class', () => {
    const base = pidWithLine([]);
    const pid = pidOf({ ...base.items, s0: { ...base.items['s0'], pipingClass: 'B2' } });
    expect(run(['B2'], pid).findings).toEqual([]);
  });
});

const piping = (extra: Partial<PipingModel>): PipingModel => ({ ...EMPTY_PIPING, ...extra });
const routedLine = { id: 'ln1', lineNumber: 'L-1', service: 'P', sequence: '1', spec: 'A1', dn: 100 };
const runBase = { id: 'r1', lineId: 'ln1', pis: [], start: { point: [0, 0, 0] }, end: { point: [1, 0, 0] } };
const component = (id: string, tag: string | undefined, type = 'valveGate', leg = 0, centreDistance = 0): Record<string, unknown> => ({
  id,
  type,
  leg,
  centreDistance,
  ...(tag === undefined ? {} : { tag }),
});

describe('routed lines, ends and branches', () => {
  it('merges the legacy pipes and the routed line of one line number into one 3D line (ids of both, DN union)', () => {
    const model = piping({
      lines: { ln1: routedLine },
      lineOrder: ['ln1'],
      runs: { r1: { ...runBase, dn: 80 } },
      runOrder: ['r1'],
    } as unknown as Partial<PipingModel>);
    const pipe = { id: 'pipe-1', category: 'pipe', mark: 'pipe-1', line: 'l-1', dn: 100 };
    const result = check3d(pidWithLine([]), building({ 'pipe-1': pipe }), model, 'lines', true);
    expect(result.matched.lines).toEqual(['L-1']);
    expect(result.findings.map((f) => f.code)).toEqual(['P3D_SIZE_MISMATCH']);
    expect(result.findings[0]?.elementIds).toEqual(['ln1', 'pipe-1', 'r1']);
    expect(result.findings[0]?.values['modelDn']).toBe('80,100');
  });

  it('reads a tie-in tag as the end, falls back to the line from / to for an unknown reference, and ignores prototype keys', () => {
    const ends = (startRef: unknown, from?: string): ReturnType<typeof check3d> => {
      const model = piping({
        tieIns: { T1: { id: 'T1', tag: 'BL-1', kind: 'battery_limit' } },
        lines: { ln1: { ...routedLine, ...(from === undefined ? {} : { from }), to: 'V-101' } },
        lineOrder: ['ln1'],
        runs: { r1: { ...runBase, start: { point: [0, 0, 0], ref: startRef } } },
        runOrder: ['r1'],
      } as unknown as Partial<PipingModel>);
      return check3d(pidWithLine([]), building({}), model, 'lines', true);
    };
    const tie = ends({ kind: 'tieIn', id: 'T1' }).findings.find((f) => f.code === 'P3D_CONNECTIVITY_MISMATCH');
    expect(tie?.values['modelEnds']).toBe('BL-1 | V-101');
    const proto = ends({ kind: 'tieIn', id: '__proto__' }, 'P-101').findings;
    expect(proto).toEqual([]);
    const missing = ends({ kind: 'nozzle', equipmentId: 'constructor', nozzleId: 'N1' }, 'X-9').findings.find(
      (f) => f.code === 'P3D_CONNECTIVITY_MISMATCH',
    );
    expect(missing?.values['modelEnds']).toBe('X-9 | V-101');
  });

  it('keeps branch-run valves out of the line order but still pairs their tags', () => {
    const model = piping({
      lines: { ln1: routedLine },
      lineOrder: ['ln1'],
      runs: {
        r1: {
          ...runBase,
          inline: [component('c1', 'V-2', 'valveGate', 0, 20), component('c0', 'V-1', 'valveGate', 0, 10), component('cu', undefined)],
        },
        r2: {
          ...runBase,
          id: 'r2',
          start: { point: [0, 0, 0], ref: { kind: 'branch', runId: 'r1', branchId: 'b1' } },
          inline: [component('c3', 'V-3')],
        },
      },
      runOrder: ['r1', 'r2'],
    } as unknown as Partial<PipingModel>);
    const result = check3d(pidWithLine(['V-1', 'V-2', 'V-3']), building({}), model, 'all', true);
    expect(result.matched.inline).toEqual(['V-1', 'V-2', 'V-3']);
    expect(result.findings.filter((f) => f.code === 'P3D_INLINE_ORDER_MISMATCH')).toEqual([]);
    expect(result.unmatched3d).toEqual([]);
  });

  it('survives hostile segment ids and inline tags named like object prototype keys', () => {
    const base = pidWithLine(['constructor', '__proto__']);
    const pid = pidOf({
      ...base.items,
      l: { ...base.items['l'], segmentIds: ['constructor', '__proto__', ...(base.items['l'] as PidLine).segmentIds] },
    });
    const model = piping({
      lines: { ln1: routedLine },
      lineOrder: ['ln1', '__proto__'],
      runs: { r1: { ...runBase, inline: [component('c1', 'constructor'), component('c2', '__proto__', 'valveGate', 0, 5)] } },
      runOrder: ['r1', 'toString'],
    } as unknown as Partial<PipingModel>);
    const result = check3d(pid, building({}), model, 'all', true);
    expect(result.matched.inline).toEqual(['__proto__', 'constructor']);
    expect(result.findings.filter((f) => f.code !== 'P3D_UNPLACED' && f.code !== 'P3D_CLASS_MISMATCH')).toEqual([]);
  });

  it('scope inline pairs the lines silently for the order check and reports no line-level code', () => {
    const model = piping({
      lines: { ln1: routedLine },
      lineOrder: ['ln1'],
      runs: {
        r1: {
          ...runBase,
          inline: [
            component('c1', 'V-1', 'valveGate', 0, 1),
            component('c2', 'V-2', 'valveGate', 0, 2),
            component('c3', 'V-3', 'valveGate', 0, 3),
          ],
        },
      },
      runOrder: ['r1'],
    } as unknown as Partial<PipingModel>);
    const result = check3d(pidWithLine(['V-1', 'V-3', 'V-2'], 'Z9'), building({}), model, 'inline', true);
    expect(result.findings.map((f) => f.code)).toEqual(['P3D_INLINE_ORDER_MISMATCH']);
    expect(result.matched.lines).toEqual([]);
  });
});
