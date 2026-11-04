/**
 * Plant 04 PID-FU-5: P&ID nozzles against the 03 EQP nozzle records, P3D_SIZE_MISMATCH of an inline item, and link_pid_item for a routed line.
 * Scene: SC-RTE-01 (pump P-101 with nozzle N2, vessel V-101 with nozzle N1, DN100 routed line) with three gate valves and the matching P&ID.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { PidInline, PidNozzle } from '@aec/plant/pid/model';
import { getPid, withPid as withPidModel } from '@aec/plant/pid/state';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { byTag, ofKind, runSteps } from './authoringFixtures';
import { CLEAN_INLINE, routedWithValves, withPid } from './pid3dM7b';

interface Answer {
  status: string;
  items: Array<{ code: string; item: string; values: Record<string, unknown>; pidIds: string[]; elementIds: string[] }>;
  skipped: Array<{ code: string; reason: string; item: string }>;
  matched: { equipment: string[]; lines: string[]; inline: string[]; nozzles: string[] };
  unmatchedPid: Array<{ label: string; kind: string; reason: string }>;
  unmatched3d: Array<{ label: string; category: string; reason: string }>;
}
const check = (doc: CadDocument, params: Record<string, unknown> = {}): Answer => data<Answer>(doc, 'check_pid_3d', params);
const scene = routedWithValves();
const clean = (options: Parameters<typeof withPid>[1] = {}): CadDocument =>
  withPid(scene, { pipingClass: 'CS150', inline: CLEAN_INLINE, ...options });
const pairs = (answer: Answer): string[][] => answer.items.map((f) => [f.code, f.item]);

/** Hand edit of one stored P&ID item (what an imported file can hold). */
const editItem = (doc: CadDocument, id: string, patch: Record<string, unknown>): CadDocument => {
  const pid = getPid(doc);
  const item = pid.items[id] as unknown as Record<string, unknown>;
  const next = { ...item, ...patch };
  for (const key of Object.keys(patch)) if (patch[key] === undefined) delete next[key];
  return withPidModel(doc, { ...pid, items: { ...pid.items, [id]: next as never } });
};
const nozzleOf = (doc: CadDocument, equipmentTag: string, subTag: string): PidNozzle => {
  const equipment = byTag(doc, equipmentTag);
  return ofKind(doc, 'nozzle').find((n) => n.equipmentId === equipment.id && n.subTag === subTag) as PidNozzle;
};

describe('P&ID nozzles against the 03 EQP nozzle records', () => {
  it('pairs the P&ID nozzles with the records of the same mark: matched.nozzles lists them, nothing is found', () => {
    const answer = check(clean());
    expect(answer.items).toEqual([]);
    expect(answer.status).toBe('pass');
    expect(answer.matched.nozzles).toEqual(['P-101/N2', 'V-101/N1']);
    expect(answer.skipped.filter((skip) => skip.code === 'P3D_UNPLACED')).toEqual([]);
  });

  it('a P&ID nozzle DN that differs from the 3D record is P3D_SIZE_MISMATCH at the nozzle (V-101/N1: P&ID DN 80, 3D DN 100)', () => {
    const doc = clean();
    const answer = check(editItem(doc, nozzleOf(doc, 'V-101', 'N1').id, { dn: 80 }));
    expect(pairs(answer)).toEqual([['P3D_SIZE_MISMATCH', 'V-101/N1']]);
    expect(answer.items[0]?.values).toEqual({ pidDn: 80, modelDn: 100 });
    expect(answer.items[0]?.elementIds).toHaveLength(1);
  });

  it('a P&ID nozzle with no record is P3D_UNPLACED (nozzle kind in unmatchedPid)', () => {
    const doc = apply(clean(), 'add_pid_nozzle', { equipment: 'V-101', subTag: 'N9', side: 'top', dn: 50 });
    const answer = check(doc);
    expect(pairs(answer)).toEqual([['P3D_UNPLACED', 'V-101/N9']]);
    expect(answer.unmatchedPid).toEqual([{ id: expect.any(String), kind: 'nozzle', label: 'V-101/N9', reason: 'unplaced' }]);
    expect(answer.matched.nozzles).toEqual(['P-101/N2', 'V-101/N1']);
  });

  it('a record a 3D line ends on that the P&ID does not draw is P3D_NOT_IN_PID; a spare record with no line is not an inconsistency', () => {
    const spare = apply(clean(), 'add_nozzle', {
      equipment: 'V-101',
      mark: 'M9',
      dn: 50,
      rating: 'CL150',
      facing: 'RF',
      location: { on: 'shell', elevation: 500, orientationDeg: 90 },
      projection: 1000,
    });
    expect(check(spare).items).toEqual([]);
    const renamed = check(clean({ pumpNozzle: 'N5' }));
    expect(renamed.items.map((f) => [f.code, f.item])).toEqual(
      expect.arrayContaining([
        ['P3D_UNPLACED', 'P-101/N5'],
        ['P3D_NOT_IN_PID', 'P-101/N2'],
        ['P3D_CONNECTIVITY_MISMATCH', scene.lineNumber],
      ]),
    );
    expect(renamed.unmatched3d).toContainEqual({ ids: expect.anything(), category: 'nozzle', label: 'P-101/N2', reason: 'not_in_pid' });
  });

  it('a nozzle with no DN on the P&ID is a coded skip, never a pass; tags normalise (n1 = N1)', () => {
    const doc = clean();
    const answer = check(editItem(doc, nozzleOf(doc, 'V-101', 'N1').id, { dn: undefined, subTag: 'n1' }));
    expect(answer.items).toEqual([]);
    expect(answer.skipped).toContainEqual(expect.objectContaining({ code: 'P3D_SIZE_MISMATCH', reason: 'no_pid_dn', item: 'V-101/n1' }));
  });

  it('a 3D equipment without nozzle records (a legacy block) is ONE coded skip per equipment, not a finding per nozzle; scope lines does not compare nozzles', () => {
    const pidDoc = runSteps([
      { command: 'create_pid_sheet', params: { number: 'PID-001', paper: 'A3' }, as: 'sheet' },
      {
        command: 'add_pid_equipment',
        params: {
          sheet: '$sheet',
          class: 'Tank',
          tag: 'T-101',
          at: [60, 150],
          nozzles: [
            { subTag: 'N1', side: 'bottom', dn: 100 },
            { subTag: 'N2', side: 'top', dn: 50 },
          ],
        },
      },
    ]).doc;
    const doc = apply(pidDoc, 'add_equipment', { name: 'Tank', mark: 'T-101', location: [0, 0], size: [1000, 1000, 1000], weight: 100 });
    const answer = check(doc);
    expect(answer.items).toEqual([]);
    expect(answer.skipped.filter((skip) => skip.reason === 'no_3d_nozzles')).toEqual([
      expect.objectContaining({ item: 'T-101', code: 'P3D_UNPLACED' }),
    ]);
    expect(check(doc, { scope: 'lines' }).skipped).toEqual([]);
  });
});

describe('P3D_SIZE_MISMATCH of an inline item', () => {
  const inlineId = (doc: CadDocument, tag: string): string => (byTag(doc, tag) as PidInline).id;

  it('an inline DN that differs from the 3D line at the component is a finding (XV-2: P&ID DN 150, 3D DN 100); the same DN passes', () => {
    const doc = clean();
    expect(check(doc).items).toEqual([]);
    const answer = check(editItem(doc, inlineId(doc, 'XV-2'), { dn: 150 }));
    expect(pairs(answer)).toEqual([['P3D_SIZE_MISMATCH', 'XV-2']]);
    expect(answer.items[0]?.values).toEqual({ pidDn: 150, modelDn: 100 });
  });

  it('an inline item with no DN is a coded skip; a reducer is a coded skip (two sizes)', () => {
    const doc = clean();
    const answer = check(editItem(doc, inlineId(doc, 'XV-1'), { dn: undefined }));
    expect(answer.items).toEqual([]);
    expect(answer.skipped).toContainEqual(expect.objectContaining({ code: 'P3D_SIZE_MISMATCH', reason: 'no_pid_dn', item: 'XV-1' }));
  });

  it('the DN after a reducer is its outlet: XV-2 between a DN100 -> DN80 and a DN80 -> DN100 reducer is compared with DN80, XV-3 after the second with DN100', () => {
    // the stored run is edited directly: insert_inline_component refuses a reducer that leaves the run size different from the port
    const piping = scene.doc.plant?.piping as NonNullable<NonNullable<CadDocument['plant']>['piping']>;
    const run = piping.runs[scene.runId] as NonNullable<(typeof piping.runs)[string]>;
    const reducer = (id: string, tag: string, dn2: number, leg: number, centreDistance: number): NonNullable<typeof run.inline>[number] =>
      ({ id, type: 'reducerConcentric', tag, dn2, leg, centreDistance }) as unknown as NonNullable<typeof run.inline>[number];
    const edited = { ...run, inline: [...(run.inline ?? []), reducer('rd-1', 'RD-1', 80, 1, 500), reducer('rd-2', 'RD-2', 100, 2, 300)] };
    const reduced: CadDocument = {
      ...scene.doc,
      plant: { ...scene.doc.plant, piping: { ...piping, runs: { ...piping.runs, [scene.runId]: edited } } },
    };

    const inline = [
      CLEAN_INLINE[0],
      { tag: 'RD-1', class: 'PipeReducer' },
      CLEAN_INLINE[1],
      { tag: 'RD-2', class: 'PipeReducer' },
      CLEAN_INLINE[2],
    ];
    const pidDoc = withPid({ ...scene, doc: reduced }, { pipingClass: 'CS150', inline: inline as never });
    const sizeFindings = (answer: Answer, tag: string): unknown[] =>
      answer.items.filter((f) => f.item === tag && f.code === 'P3D_SIZE_MISMATCH');
    const middle = byTag(pidDoc, 'XV-2').id;
    expect(sizeFindings(check(editItem(pidDoc, middle, { dn: 80 })), 'XV-2')).toEqual([]);
    const wrong = check(editItem(pidDoc, middle, { dn: 100 }));
    expect(sizeFindings(wrong, 'XV-2')).toHaveLength(1);
    expect(wrong.items.find((f) => f.item === 'XV-2')?.values).toEqual({ pidDn: 100, modelDn: 80 });
    expect(sizeFindings(wrong, 'XV-3')).toEqual([]);
    expect(wrong.skipped).toContainEqual(expect.objectContaining({ code: 'P3D_SIZE_MISMATCH', reason: 'reducer', item: 'RD-1' }));
  });
});

describe('link_pid_item for a routed line', () => {
  const lineId = (): string => scene.doc.plant?.piping?.lineOrder[0] as string;
  const renumbered = (): CadDocument => withPid({ ...scene, lineNumber: 'DRAWING-1' }, { pipingClass: 'CS150', inline: CLEAN_INLINE });

  it('pairs a P&ID line whose number differs from the routed line with the routed line (by id or by line number); check_pid_3d then compares the pair', () => {
    const unlinked = check(renumbered());
    expect(unlinked.items.map((f) => f.code)).toEqual(expect.arrayContaining(['P3D_UNPLACED', 'P3D_NOT_IN_PID']));
    const linked = apply(renumbered(), 'link_pid_item', { pidItem: 'DRAWING-1', element: lineId() });
    expect(getPid(linked).links).toEqual({ [ofKind(linked, 'line')[0]?.id as string]: lineId() });
    const answer = check(linked);
    expect(answer.matched.lines).toEqual(['DRAWING-1']);
    expect(answer.items.filter((f) => f.code === 'P3D_UNPLACED' && f.item === 'DRAWING-1')).toEqual([]);
    const byNumber = apply(renumbered(), 'link_pid_item', { pidItem: 'DRAWING-1', element: scene.lineNumber });
    expect(getPid(byNumber).links).toEqual(getPid(linked).links);
  });

  it('refuses a second P&ID line on the same routed line (PID_LINK_DUPLICATE) and an unknown routed line (PID_ITEM_NOT_FOUND); null clears', () => {
    const linked = apply(renumbered(), 'link_pid_item', { pidItem: 'DRAWING-1', element: lineId() });
    const other = apply(linked, 'add_pid_line', {
      sheet: Object.keys(getPid(linked).sheets)[0],
      from: { free: [10, 10] },
      to: { free: [30, 10] },
      lineNumber: 'DRAWING-2',
      dn: 50,
    });
    expectRefusal(other, 'link_pid_item', { pidItem: 'DRAWING-2', element: lineId() }, 'PID_LINK_DUPLICATE', 'element');
    expectRefusal(linked, 'link_pid_item', { pidItem: 'DRAWING-1', element: 'line-404' }, 'PID_ITEM_NOT_FOUND', 'element');
    const cleared = apply(linked, 'link_pid_item', { pidItem: 'DRAWING-1', element: null });
    expect(getPid(cleared).links ?? {}).toEqual({});
  });

  it('an equipment links to equipment only: a routed line id is not an equipment element (PID_ITEM_NOT_FOUND)', () => {
    expectRefusal(clean(), 'link_pid_item', { pidItem: 'P-101', element: lineId() }, 'PID_ITEM_NOT_FOUND', 'element');
  });
});
