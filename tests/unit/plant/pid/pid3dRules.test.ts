/** Plant 04 PID M7: one positive and one negative fixture per P&ID <-> 3D rule, link_pid_item, purity, persistence, replay, budget. */

import { describe, expect, it } from 'vitest';
import { pidPlugin } from '@aec/index';
import { check3d } from '@aec/plant/pid/link3d/check';
import type { PidModel } from '@aec/plant/pid/model';
import { EMPTY_PID } from '@aec/plant/pid/state';
import { createEmptyBuilding } from '@aec/building/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { FEED_PUMP, FEED_PUMP_CONTROL, runSteps, type Step } from './authoringFixtures';

interface Answer {
  status: string;
  items: Array<{ code: string; item: string; ids: string[]; values: Record<string, unknown> }>;
  countsByCode: Record<string, number>;
  matched: { equipment: string[]; lines: string[]; inline: string[] };
  unmatchedPid: Array<{ label: string; reason: string }>;
  unmatched3d: Array<{ label: string; reason: string }>;
}

const SUCTION = '100-P-1001-A1';
const DISCHARGE = '80-P-1002-A1';

const equipment = (mark: string, x = 0): Step => ({
  command: 'add_equipment',
  params: { name: `eq ${mark}`, mark, location: [x, 0], size: [1000, 1000, 1000] },
});
const run = (line: string, dn: number | undefined, from: string | undefined, to: string | undefined, y: number): Step => ({
  command: 'add_pipe_run',
  params: {
    points: [
      [0, y, 100],
      [3000, y, 100],
    ],
    line,
    ...(dn === undefined ? {} : { dn }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  },
});

/** The consistent 3D side of FEED_PUMP: tank, pump, both lines. */
const CLEAN_3D: Step[] = [
  equipment('T-101'),
  equipment('P-101', 4000),
  run(SUCTION, 100, 'T-101', 'P-101', 5000),
  run(DISCHARGE, 80, 'P-101', 'BL-1', 6000),
];
/** CLEAN_3D with the suction run replaced by `suction`. */
const withSuction = (suction: Step): Step[] => [
  equipment('T-101'),
  equipment('P-101', 4000),
  suction,
  run(DISCHARGE, 80, 'P-101', 'BL-1', 6000),
];

const build = (extra: Step[], steps: readonly Step[] = CLEAN_3D, pid: readonly Step[] = FEED_PUMP): CadDocument => {
  const result = runSteps([...pid, ...steps, ...extra]);
  for (const r of result.results) expect(r.rejected, r.summary).toBeUndefined();
  return result.doc;
};
const check = (doc: CadDocument, params: Record<string, unknown> = {}): Answer => data<Answer>(doc, 'check_pid_3d', params);
const codes = (answer: Answer): string[] => answer.items.map((f) => f.code);
const pairs = (answer: Answer): string[][] => answer.items.map((f) => [f.code, f.item]);
const elementId = (doc: CadDocument, category: string, key: 'mark' | 'line', value: string): string =>
  Object.values(doc.building?.elements ?? {}).find(
    (e) => e.category === category && (e as unknown as Record<string, unknown>)[key] === value,
  )?.id ?? '';

describe('consistent models', () => {
  it('pass with both equipment and both lines matched and no finding', () => {
    const answer = check(build([]));
    expect(answer.status).toBe('pass');
    expect(answer.items).toEqual([]);
    expect(answer.matched).toEqual({ equipment: ['P-101', 'T-101'], lines: [DISCHARGE, SUCTION], inline: [] });
    expect(answer.unmatchedPid).toEqual([]);
    expect(Object.values(answer.countsByCode).every((n) => n === 0)).toBe(true);
  });

  it('an empty document passes with nothing matched', () => {
    const answer = check(runSteps([]).doc);
    expect(answer).toMatchObject({ status: 'pass', items: [], matched: { equipment: [], lines: [], inline: [] } });
  });
});

describe('P3D_UNPLACED', () => {
  const unplaced = (): CadDocument => build([], [equipment('T-101')], [...FEED_PUMP, ...FEED_PUMP_CONTROL]);

  it('positive: P&ID equipment and line without a 3D counterpart, and tagged inline items', () => {
    const answer = check(unplaced());
    expect(answer.items.filter((f) => f.code === 'P3D_UNPLACED').map((f) => f.item)).toEqual([
      DISCHARGE,
      SUCTION,
      'FV-101',
      'HV-102',
      'P-101',
    ]);
    expect(answer.unmatchedPid.map((u) => u.reason)).toEqual(Array(5).fill('unplaced'));
  });

  it('negative: nothing is unplaced when the 3D model has the equipment', () => {
    expect(codes(check(build([]), { scope: 'equipment' }))).toEqual([]);
  });

  it('scope narrows the comparison', () => {
    const doc = unplaced();
    expect(check(doc, { scope: 'equipment' }).items.map((f) => f.item)).toEqual(['P-101']);
    expect(check(doc, { scope: 'inline' }).items.map((f) => f.item)).toEqual(['FV-101', 'HV-102']);
    expect(check(doc, { scope: 'lines' }).items.map((f) => f.item)).toEqual([DISCHARGE, SUCTION]);
  });
});

describe('P3D_NOT_IN_PID', () => {
  it('positive: 3D equipment with a mark and a pipe line number the P&ID does not have', () => {
    const answer = check(build([equipment('E-201', 9000), run('L-77', 50, undefined, undefined, 7000)]));
    expect(pairs(answer)).toEqual([
      ['P3D_NOT_IN_PID', 'E-201'],
      ['P3D_NOT_IN_PID', 'L-77'],
    ]);
    expect(answer.unmatched3d.map((u) => u.reason)).toEqual(['not_in_pid', 'not_in_pid']);
  });

  it('negative: a pipe without a line number is not reported', () => {
    const doc = build([
      {
        command: 'add_pipe_run',
        params: {
          points: [
            [0, 8000, 0],
            [100, 8000, 0],
          ],
        },
      },
    ]);
    expect(codes(check(doc))).toEqual([]);
  });
});

describe('P3D_SIZE_MISMATCH', () => {
  it('positive: the 3D DN differs from the P&ID segment DN', () => {
    const found = check(build([], withSuction(run(SUCTION, 80, 'T-101', 'P-101', 5000)))).items;
    expect(found.map((f) => f.code)).toEqual(['P3D_SIZE_MISMATCH']);
    expect(found[0]?.values).toEqual({ pidDn: '100', modelDn: '80' });
  });

  it('negative: equal DN, and a 3D run without DN is not compared', () => {
    expect(codes(check(build([])))).toEqual([]);
    expect(codes(check(build([], withSuction(run(SUCTION, undefined, 'T-101', 'P-101', 5000)))))).toEqual([]);
  });

  it('a line made of two runs compares the union of their DN', () => {
    const doc = build([run(SUCTION, 80, undefined, undefined, 5500)]);
    expect(check(doc).items[0]).toMatchObject({ code: 'P3D_SIZE_MISMATCH', values: { modelDn: '80,100' } });
  });
});

describe('P3D_CONNECTIVITY_MISMATCH', () => {
  it('positive: a 3D end names another equipment', () => {
    const found = check(build([], withSuction(run(SUCTION, 100, 'T-102', 'P-101', 5000)))).items;
    expect(found.map((f) => f.code)).toEqual(['P3D_CONNECTIVITY_MISMATCH']);
    expect(found[0]?.values).toEqual({ pidEnds: 'T-101/N1 | P-101/N1', modelEnds: 'T-102 | P-101' });
  });

  it('negative: either direction, a matching nozzle sub-tag, and a missing end are accepted', () => {
    expect(codes(check(build([], withSuction(run(SUCTION, 100, 'P-101', 'T-101', 5000)))))).toEqual([]);
    expect(codes(check(build([], withSuction(run(SUCTION, 100, 't-101:n1', 'P-101:N1', 5000)))))).toEqual([]);
    expect(codes(check(build([], withSuction(run(SUCTION, 100, 'T-101', undefined, 5000)))))).toEqual([]);
  });

  it('a nozzle sub-tag the P&ID line does not use is a mismatch', () => {
    expect(codes(check(build([], withSuction(run(SUCTION, 100, 'T-101:N9', 'P-101', 5000)))))).toEqual(['P3D_CONNECTIVITY_MISMATCH']);
  });
});

describe('P3D_TAG_AMBIGUOUS and tag normalisation', () => {
  const ambiguous = (): CadDocument => build([equipment('P101', 8000)]);

  it('positive: two 3D marks normalise to one P&ID tag, nothing is paired', () => {
    const answer = check(ambiguous());
    expect(pairs(answer)).toEqual([['P3D_TAG_AMBIGUOUS', 'P-101']]);
    expect(answer.matched.equipment).toEqual(['T-101']);
    expect(answer.unmatchedPid.map((u) => u.reason)).toContain('ambiguous');
    expect(answer.unmatched3d.map((u) => u.reason)).toEqual(['ambiguous', 'ambiguous']);
  });

  it('negative: normaliseTags=false pairs exactly and reports the other mark as not in the P&ID', () => {
    const answer = check(ambiguous(), { normaliseTags: false });
    expect(pairs(answer)).toEqual([['P3D_NOT_IN_PID', 'P101']]);
    expect(answer.matched.equipment).toEqual(['P-101', 'T-101']);
  });

  it('a link resolves the ambiguity', () => {
    const doc = apply(ambiguous(), 'link_pid_item', { pidItem: 'P-101', element: 'P-101' });
    expect(pairs(check(doc))).toEqual([['P3D_NOT_IN_PID', 'P101']]);
  });

  it('normalisation ignores case, spaces, dash and underscore', () => {
    const doc = build(
      [],
      [
        equipment('t 101'),
        equipment('p_101', 4000),
        run('100 p 1001 a1', 100, 't-101', 'P101', 5000),
        run(DISCHARGE.toLowerCase(), 80, 'P-101', 'BL-1', 6000),
      ],
    );
    expect(codes(check(doc))).toEqual([]);
    expect(codes(check(doc, { normaliseTags: false }))).toEqual(expect.arrayContaining(['P3D_UNPLACED', 'P3D_NOT_IN_PID']));
  });
});

describe('link_pid_item', () => {
  const renamedPump = (): CadDocument =>
    build(
      [],
      [equipment('PMP-1', 4000), equipment('T-101'), run(SUCTION, 100, 'T-101', 'P-101', 5000), run(DISCHARGE, 80, 'P-101', 'BL-1', 6000)],
    );

  it('pairs items whose tags differ and clears the pair again', () => {
    const base = renamedPump();
    expect(pairs(check(base))).toEqual([
      ['P3D_UNPLACED', 'P-101'],
      ['P3D_NOT_IN_PID', 'PMP-1'],
    ]);
    const result = ok(base, 'link_pid_item', { pidItem: 'P-101', element: 'PMP-1' });
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toContain('PMP-1');
    expect(check(result.document).items).toEqual([]);
    expect(check(result.document).matched.equipment).toEqual(['P-101', 'T-101']);
    const cleared = ok(result.document, 'link_pid_item', { pidItem: 'P-101', element: null });
    expect(cleared.document.plant?.pid?.links).toBeUndefined();
    expect(codes(check(cleared.document))).toEqual(['P3D_UNPLACED', 'P3D_NOT_IN_PID']);
  });

  it('links a line to a pipe run by id and replaces an earlier link of the same item', () => {
    const base = build([run('OTHER', 100, 'T-101', 'P-101', 9000)]);
    const other = elementId(base, 'pipe', 'line', 'OTHER');
    const linked = apply(base, 'link_pid_item', { pidItem: SUCTION, element: other });
    const answer = check(linked);
    expect(answer.matched.lines).toEqual([DISCHARGE, SUCTION]);
    expect(pairs(answer)).toEqual([['P3D_NOT_IN_PID', SUCTION]]);
    const second = ok(linked, 'link_pid_item', { pidItem: SUCTION, element: elementId(base, 'pipe', 'line', SUCTION) });
    expect(second.summary).toContain('replacing');
    expect(codes(check(second.document))).toEqual(['P3D_NOT_IN_PID']);
  });

  it('a link to an element deleted later is reported as an unplaced item with a stale link', () => {
    const linked = apply(renamedPump(), 'link_pid_item', { pidItem: 'P-101', element: 'PMP-1' });
    const gone = apply(linked, 'delete_building_element', { elementIds: [elementId(linked, 'equipment', 'mark', 'PMP-1')] });
    const answer = check(gone);
    expect(answer.items[0]).toMatchObject({ code: 'P3D_UNPLACED', item: 'P-101', values: { stale: true } });
    expect(answer.unmatchedPid[0]?.reason).toBe('stale_link');
  });

  it('refuses with coded errors and leaves the document unchanged', () => {
    const doc = apply(build([equipment('E-9', 9000)]), 'link_pid_item', { pidItem: 'P-101', element: 'E-9' });
    expectRefusal(doc, 'link_pid_item', { pidItem: 'NOPE', element: 'E-9' }, 'PID_ITEM_NOT_FOUND', 'pidItem');
    expectRefusal(doc, 'link_pid_item', { pidItem: 'T-101', element: 'nothing-9' }, 'PID_ITEM_NOT_FOUND', 'element');
    expectRefusal(doc, 'link_pid_item', { pidItem: 'T-101', element: elementId(doc, 'pipe', 'line', SUCTION) }, 'PID_ITEM_KIND', 'element');
    expectRefusal(doc, 'link_pid_item', { pidItem: 'P-101', element: 'E-9' }, 'PID_LINK_DUPLICATE', 'element');
    expectRefusal(doc, 'link_pid_item', { pidItem: 'T-101', element: 'E-9' }, 'PID_LINK_DUPLICATE', 'element');
    expectRefusal(doc, 'link_pid_item', { pidItem: 'T-101', element: null }, 'PID_LINK_NOT_FOUND', 'element');
    expectRefusal(runSteps([]).doc, 'link_pid_item', { pidItem: 'T-101', element: 'E-9' }, 'PID_ITEM_NOT_FOUND', 'pidItem');
  });

  it('refuses a P&ID item that is neither equipment nor a line', () => {
    const doc = build([equipment('E-9', 9000)], CLEAN_3D, [...FEED_PUMP, ...FEED_PUMP_CONTROL]);
    expectRefusal(doc, 'link_pid_item', { pidItem: 'HV-102', element: 'E-9' }, 'PID_ITEM_KIND', 'pidItem');
  });

  it('delete_pid_item drops the links of what it removes and keeps the others', () => {
    const linked = apply(build([equipment('E-9', 9000)]), 'link_pid_item', { pidItem: 'P-101', element: 'E-9' });
    expect(linked.plant?.pid?.links).toBeDefined();
    expect(apply(linked, 'delete_pid_item', { item: 'T-101' }).plant?.pid?.links).toEqual(linked.plant?.pid?.links);
    expect(apply(linked, 'delete_pid_item', { item: 'P-101' }).plant?.pid?.links).toBeUndefined();
  });
});

describe('contract', () => {
  const linkedDoc = (): CadDocument => apply(build([equipment('E-9', 9000)]), 'link_pid_item', { pidItem: 'P-101', element: 'E-9' });

  it('check_pid_3d is read-only and pure; link_pid_item is pure', () => {
    const before = linkedDoc();
    const snapshot = JSON.stringify(before);
    const checked = ok(before, 'check_pid_3d', {});
    expect(checked.document).toBe(before);
    expect(checked.affected).toEqual([]);
    const linked = ok(before, 'link_pid_item', { pidItem: 'T-101', element: 'T-101' });
    expect(linked.document).not.toBe(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('links survive save and load, validate, and replay to the same document', () => {
    const doc = linkedDoc();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.plant?.pid?.links).toEqual(doc.plant?.pid?.links);
    expect(pidPlugin.document?.validate({ plant: { pid: JSON.parse(JSON.stringify(doc.plant?.pid)) as unknown } })).toEqual([]);
    expect(execute(doc, 'replay_history', {}).document.plant?.pid).toEqual(doc.plant?.pid);
  });

  it('load validation refuses a malformed links record', () => {
    const pid = JSON.parse(JSON.stringify(linkedDoc().plant?.pid)) as PidModel & { links: Record<string, string> };
    const equipmentId = Object.keys(pid.links)[0] ?? '';
    const other = pid.itemOrder.find((id) => id !== equipmentId && pid.items[id]?.kind === 'equipment') ?? '';
    const errors = (links: unknown): string => (pidPlugin.document?.validate({ plant: { pid: { ...pid, links } } }) ?? []).join(' | ');
    expect(errors('x')).toContain('plant.pid.links must be an object');
    expect(errors({ nope: 'E-9' })).toContain('must name an equipment or a line');
    expect(errors({ [equipmentId]: '' })).toContain('non-empty');
    expect(errors({ [equipmentId]: 'E-9', [other]: 'E-9' })).toContain('linked twice');
    expect(errors({ [Object.keys(pid.sheets)[0] ?? '']: 'E-9' })).toContain('must name an equipment or a line');
    expect(errors(JSON.parse('{"__proto__":"E-9"}'))).toContain('reserved');
    expect(errors({ [equipmentId]: 'E-9' })).toBe('');
  });
});

describe('budget (TECHNICAL_SPEC §8: 2 000 tags each side)', () => {
  it('joins 2 000 equipment and 2 000 lines on each side well inside a generous bound', () => {
    const n = 2000;
    const pidItems: Record<string, unknown> = {};
    const elements: Record<string, unknown> = {};
    const order: string[] = [];
    const elementOrder: string[] = [];
    for (let i = 0; i < n; i++) {
      pidItems[`e${i}`] = { id: `e${i}`, kind: 'equipment', tag: `P-${i}` };
      pidItems[`l${i}`] = { id: `l${i}`, kind: 'line', lineNumber: `L-${i}`, segmentIds: [], dn: 50 };
      elements[`q${i}`] = { id: `q${i}`, category: 'equipment', mark: `P${i}` };
      elements[`p${i}`] = { id: `p${i}`, category: 'pipe', mark: `PI${i}`, line: `L${i}`, dn: 50 };
      order.push(`e${i}`, `l${i}`);
      elementOrder.push(`q${i}`, `p${i}`);
    }
    const pid = { ...EMPTY_PID, items: pidItems, itemOrder: order } as unknown as PidModel;
    const building = { ...createEmptyBuilding(), elements, elementOrder } as unknown as ReturnType<typeof createEmptyBuilding>;
    const start = performance.now();
    const result = check3d(pid, building, 'all', true);
    const elapsed = performance.now() - start;
    expect(result.findings).toEqual([]);
    expect(result.matched.equipment).toHaveLength(n);
    expect(result.matched.lines).toHaveLength(n);
    expect(elapsed).toBeLessThan(1500);
  });
});
