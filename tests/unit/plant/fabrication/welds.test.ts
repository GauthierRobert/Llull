/**
 * Plant 05 ISO M2: weld detection and persistent numbering (VC-ISO-05, VC-ISO-14), add_field_weld, set_weld_type, number_welds, and their refusals.
 * The expected values are those of docs/plant/05-isometrics-fabrication/validation/data/iso-01-L101-dn100.expected.json.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { loadedL101, refNumbers, withoutWeld } from './isoM2Fixtures';

interface Weld {
  weldId: string | null;
  number: string;
  numbered: boolean;
  kind: string;
  field: boolean;
  at: number[];
  componentIds: string[];
  boreMm: number;
  endType: string;
  spool: string | null;
  spools: string[];
}
interface WeldData {
  welds: Weld[];
  orphaned: Array<{ weldId: string; number: string }>;
  counts: { total: number; shop: number; site: number; fieldFit: number; unnumbered: number };
  highest: number;
  flangedTerminals: number;
  warnings: Array<{ code: string }>;
}

const expected = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../../../docs/plant/05-isometrics-fabrication/validation/data/iso-01-L101-dn100.expected.json'),
    'utf8',
  ),
) as { welds: Array<{ number: string; kind: string; at: number[]; components: string[] }>; terminals: unknown[] };

const list = (doc: ReturnType<typeof loadedL101>, params: Record<string, unknown> = {}): WeldData =>
  data<WeldData>(doc, 'weld_list', { lineId: 'L-101', ...params });

describe('VC-ISO-05: weld_list on the fixture', () => {
  const doc = loadedL101();
  const welds = list(doc);

  it('13 welds W1..W13 in depth-first order, the branch welds last, matching the reference script', () => {
    expect(welds.welds.map((weld) => weld.number)).toEqual(expected.welds.map((weld) => weld.number));
    expect(welds.welds.map((weld) => weld.at)).toEqual(expected.welds.map((weld) => weld.at));
    expect(welds.welds.map((weld) => refNumbers(weld.componentIds))).toEqual(expected.welds.map((weld) => weld.components));
    expect(welds.welds[11]?.at).toEqual([7105, 4000, 1105]);
  });

  it('12 shop welds and 1 field weld (W2, site, SKEY WS) at (2500, 0, 3000); 3 flanged ends are not welds', () => {
    expect(welds.counts).toEqual({ total: 13, shop: 12, site: 1, fieldFit: 0, unnumbered: 13 });
    const w2 = welds.welds.find((weld) => weld.number === 'W2');
    expect(w2).toMatchObject({ kind: 'site', field: true, at: [2500, 0, 3000], boreMm: 100, endType: 'BW' });
    expect(welds.flangedTerminals).toBe(expected.terminals.length);
  });

  it('is a query: unnumbered joints are provisional and warned (ISO_WELDS_UNNUMBERED), the document is the same object', () => {
    expect(welds.welds.every((weld) => !weld.numbered && weld.weldId === null)).toBe(true);
    expect(welds.warnings.map((warning) => warning.code)).toEqual(['ISO_WELDS_UNNUMBERED']);
    expect(execute(doc, 'weld_list', { lineId: 'L-101' }).document).toBe(doc);
  });

  it('spoolId keeps the welds touching that spool; W2 touches both', () => {
    const first = list(doc, { spoolId: 'L-101-SP01' });
    expect(first.welds.map((weld) => weld.number)).toEqual(['W1', 'W2']);
    expect(first.welds[1]?.spools).toEqual(['L-101-SP01', 'L-101-SP02']);
    expect(list(doc, { spoolId: 'L-101-SP02' }).welds).toHaveLength(12);
  });

  it('a fixture without the WELD record has the same 13 joints, all shop (VC-ISO-06 variant)', () => {
    const plain = list(loadedL101(withoutWeld()));
    expect(plain.counts).toMatchObject({ total: 13, shop: 13, site: 0 });
  });

  it('refuses an unknown line and an unknown spool without touching the document', () => {
    expectRefusal(doc, 'weld_list', { lineId: 'NOPE' }, 'ISO_LINE_NOT_FOUND');
    expectRefusal(doc, 'weld_list', { lineId: 'L-101', spoolId: 'L-101-SP09' }, 'ISO_SPOOL_NOT_FOUND', 'spoolId');
  });
});

describe('number_welds: persistence (VC-ISO-14)', () => {
  const numbered = apply(loadedL101(), 'number_welds', { lineId: 'L-101' });

  it('stores W1..W13 and the highest number; weld_list then shows them numbered', () => {
    const result = ok(loadedL101(), 'number_welds', { lineId: 'L-101' });
    const stored = data<{ assigned: unknown[]; kept: unknown[]; highest: Record<string, number> }>(loadedL101(), 'number_welds', {
      lineId: 'L-101',
    });
    expect(stored.assigned).toHaveLength(13);
    expect(stored.kept).toEqual([]);
    expect(stored.highest).toEqual({ 'L-101': 13 });
    expect(result.affected).toHaveLength(13);
    const welds = list(numbered);
    expect(welds.welds.every((weld) => weld.numbered && weld.weldId === `L-101#${weld.number.slice(1)}`)).toBe(true);
    expect(welds.counts.unnumbered).toBe(0);
    expect(welds.warnings).toEqual([]);
  });

  it('running it again keeps everything (nothing assigned)', () => {
    const again = data<{ assigned: unknown[]; kept: unknown[] }>(numbered, 'number_welds', { lineId: 'L-101' });
    expect(again.assigned).toEqual([]);
    expect(again.kept).toHaveLength(13);
  });

  it('a weld added at x = 3500 gets W14 and every old number stays on its joint', () => {
    const before = list(numbered).welds;
    const added = ok(numbered, 'add_field_weld', { lineId: 'L-101', at: [3500, 0, 3000] });
    expect(added.data).toMatchObject({ lineId: 'L-101', at: [3500, 0, 3000], type: 'site' });
    const result = data<{ assigned: Array<{ number: string; at: number[] }>; kept: unknown[]; highest: Record<string, number> }>(
      added.document,
      'number_welds',
      { lineId: 'L-101' },
    );
    expect(result.assigned.map((weld) => weld.number)).toEqual(['W14']);
    expect(result.assigned[0]?.at).toEqual([3500, 0, 3000]);
    expect(result.kept).toHaveLength(13);
    expect(result.highest['L-101']).toBe(14);
    const after = list(apply(added.document, 'number_welds', { lineId: 'L-101' })).welds;
    for (const old of before) expect(after.find((weld) => weld.number === old.number)?.at).toEqual(old.at);
  });

  it('orphans: a joint that disappears keeps its number out of reuse', () => {
    const stored = numbered.plant?.fabrication;
    expect(stored).toBeDefined();
    // Move one numbered weld record onto a joint that does not exist (as if the line had been edited).
    const w13 = stored?.welds?.['L-101#13'];
    expect(w13).toBeDefined();
    const edited = {
      ...numbered,
      plant: {
        ...numbered.plant,
        fabrication: {
          ...stored,
          version: 1 as const,
          pcfLines: stored?.pcfLines ?? {},
          welds: {
            ...stored?.welds,
            'L-101#13': {
              ...(w13 as NonNullable<typeof w13>),
              joint: { ...(w13 as NonNullable<typeof w13>).joint, xyz: [1, 2, 3] as [number, number, number], componentIds: ['gone'] },
            },
          },
        },
      },
    };
    // The joint of W13 is found again by nothing: but W13's original joint is unmatched -> a stored weld keeps matching by id sets / position; here neither matches.
    const welds = list(edited);
    expect(welds.orphaned.map((weld) => weld.number)).toEqual(['W13']);
    const renumbered = data<{ assigned: Array<{ number: string }>; orphaned: Array<{ number: string }>; highest: Record<string, number> }>(
      edited,
      'number_welds',
      { lineId: 'L-101' },
    );
    expect(renumbered.assigned.map((weld) => weld.number)).toEqual(['W14']);
    expect(renumbered.orphaned.map((weld) => weld.number)).toEqual(['W13']);
    expect(renumbered.highest['L-101']).toBe(14);
  });

  it('renumber: true restarts from 1, drops orphans and says so', () => {
    const result = ok(numbered, 'number_welds', { lineId: 'L-101', renumber: true });
    expect(result.summary).toContain('RENUMBERED');
    expect(data<{ highest: Record<string, number> }>(numbered, 'number_welds', { lineId: 'L-101', renumber: true }).highest['L-101']).toBe(
      13,
    );
  });

  it('honours the file HIGHEST-WELD-NUMBER and the weld prefixes', () => {
    const text =
      (loadedL101().plant?.fabrication ? '' : '') + readFixtureWith('    REVISION 0', '    REVISION 0\n    HIGHEST-WELD-NUMBER 20');
    const doc = apply(createEmptyDocument(), 'import_pcf', { text });
    const prefixed = apply(doc, 'set_fabrication_rules', { source: 'shop std', weldPrefixFabrication: 'S', weldPrefixErection: 'F' });
    const numbers = list(prefixed).welds.map((weld) => weld.number);
    expect(numbers[0]).toBe('S21');
    expect(numbers[1]).toBe('F22');
    expect(numbers.at(-1)).toBe('S33');
  });

  it('accepts lineIds and refuses a call without a line or with an unknown one', () => {
    expect(data<{ lines: unknown[] }>(loadedL101(), 'number_welds', { lineIds: ['L-101'] }).lines).toHaveLength(1);
    expectRefusal(numbered, 'number_welds', {}, 'ISO_PARAM_INVALID');
    expectRefusal(numbered, 'number_welds', { lineId: 'NOPE' }, 'ISO_LINE_NOT_FOUND');
  });
});

function readFixtureWith(from: string, to: string): string {
  const text = readFileSync(
    path.resolve(__dirname, '../../../../docs/plant/05-isometrics-fabrication/validation/data/iso-01-L101-dn100.pcf'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  return text.replace(from, to);
}

describe('add_field_weld', () => {
  const doc = loadedL101(withoutWeld());

  it('splits the pipe, adds a WELD between the pieces, and a second weld on the same pipe works', () => {
    const first = ok(doc, 'add_field_weld', { lineId: 'L-101', at: [2000, 0, 3000], type: 'field_fit' });
    const weldId = first.affected[0] as string;
    expect(weldId).toMatch(/^fw-/);
    expect((first.data as { splitPipeIds: string[] }).splitPipeIds).toEqual(['pcf:L-101:2.s1', 'pcf:L-101:2.s2']);
    const second = ok(first.document, 'add_field_weld', { lineId: 'L-101', at: [1000, 0, 3000] });
    expect((second.data as { splitPipeIds: string[] }).splitPipeIds[1]).toBe('pcf:L-101:2.s2');
    const welds = list(second.document);
    expect(welds.counts).toMatchObject({ total: 15, site: 1, fieldFit: 1 });
  });

  it('projects a point within 1 mm onto the centreline and stores mm for a document in other units', () => {
    const result = ok(doc, 'add_field_weld', { lineId: 'L-101', at: [2000, 0.4, 3000.3] });
    expect((result.data as { at: number[] }).at).toEqual([2000, 0, 3000]);
    const metres = { ...doc, units: 'm' as const };
    const inMetres = ok(metres, 'add_field_weld', { lineId: 'L-101', at: [2, 0, 3] });
    expect((inMetres.data as { at: number[] }).at).toEqual([2000, 0, 3000]);
  });

  it('the exported PCF carries the weld as a WELD record (SKEY WS, ERECTION-ITEM) and re-imports to the same weld list', () => {
    const welded = apply(doc, 'add_field_weld', { lineId: 'L-101', at: [2000, 0, 3000] });
    const exported = data<{ files: Array<{ content: string; componentCount: number; countsByType: Record<string, number> }> }>(
      welded,
      'export_pcf',
      {},
    );
    const file = exported.files[0];
    expect(file?.countsByType).toMatchObject({ WELD: 1, PIPE: 8 });
    expect(file?.content).toMatch(
      /WELD\n {4}COMPONENT-IDENTIFIER 3\n {4}UNIQUE-COMPONENT-IDENTIFIER fw-[\d.]+\n {4}END-POINT 2000\.0 0\.0 3000\.0 100 BW/,
    );
    expect(file?.content).toContain('    SKEY WS\n    ERECTION-ITEM');
    const back = apply(createEmptyDocument(), 'import_pcf', { text: file?.content ?? '' });
    expect(list(back).welds.map((weld) => weld.kind)).toEqual(list(welded).welds.map((weld) => weld.kind));
  });

  it('refuses a point off the pipes, a point too close to a joint, and an unknown line (document unchanged)', () => {
    expectRefusal(doc, 'add_field_weld', { lineId: 'L-101', at: [2000, 50, 3000] }, 'ISO_WELD_NOT_ON_PIPE', 'at');
    expectRefusal(doc, 'add_field_weld', { lineId: 'L-101', at: [76.4, 0, 3000] }, 'ISO_WELD_TOO_CLOSE');
    expectRefusal(doc, 'add_field_weld', { lineId: 'NOPE', at: [0, 0, 0] }, 'ISO_LINE_NOT_FOUND');
    const ruled = apply(doc, 'set_fabrication_rules', { source: 's', minCutPieceMm: 200 });
    expectRefusal(ruled, 'add_field_weld', { lineId: 'L-101', at: [200, 0, 3000] }, 'ISO_WELD_TOO_CLOSE');
  });

  it('a second weld on the very same point is too close', () => {
    const once = apply(doc, 'add_field_weld', { lineId: 'L-101', at: [2000, 0, 3000] });
    expectRefusal(once, 'add_field_weld', { lineId: 'L-101', at: [2000, 0, 3000] }, 'ISO_WELD_TOO_CLOSE');
  });

  it('deleting the imported line removes its field welds and numbers', () => {
    const welded = apply(apply(doc, 'add_field_weld', { lineId: 'L-101', at: [2000, 0, 3000] }), 'number_welds', { lineId: 'L-101' });
    const removed = apply(welded, 'delete_pcf_line', { lineId: 'L-101' });
    expect(removed.plant?.fabrication?.fieldWelds).toEqual({});
    expect(removed.plant?.fabrication?.welds).toEqual({});
  });
});

describe('set_weld_type', () => {
  const numbered = apply(loadedL101(), 'number_welds', { lineId: 'L-101' });

  it('turns a shop weld into a field-fit weld by id or by point; the type then shows in weld_list and ends the spool', () => {
    const byId = ok(numbered, 'set_weld_type', { weldId: 'L-101#5', type: 'field_fit' });
    expect(byId.data).toMatchObject({ weldId: 'L-101#5', previous: 'shop', type: 'field_fit', number: 'W5' });
    expect(list(byId.document).welds.find((weld) => weld.number === 'W5')?.kind).toBe('field_fit');
    const spools = data<{ count: number }>(byId.document, 'spool_list', { lineId: 'L-101' });
    expect(spools.count).toBe(3);
    const byPoint = ok(numbered, 'set_weld_type', { lineId: 'L-101', at: [5000, 3848, 3000], type: 'site' });
    expect((byPoint.data as { weldId: string }).weldId).toBe('L-101#5');
  });

  it('re-prefixes the number from the rules and keeps the type over a re-detection', () => {
    const rules = apply(numbered, 'set_fabrication_rules', { source: 's', weldPrefixErection: 'E' });
    const changed = apply(rules, 'set_weld_type', { weldId: 'L-101#3', type: 'site' });
    expect(changed.plant?.fabrication?.welds?.['L-101#3']?.number).toBe('E3');
    const again = apply(changed, 'number_welds', { lineId: 'L-101' });
    expect(again.plant?.fabrication?.welds?.['L-101#3']).toMatchObject({ kind: 'site', kindSet: true, number: 'E3' });
  });

  it('refuses an unknown weld, an unnumbered line and a call without a locator', () => {
    expectRefusal(numbered, 'set_weld_type', { weldId: 'L-101#99', type: 'site' }, 'ISO_WELD_NOT_FOUND', 'weldId');
    expectRefusal(loadedL101(), 'set_weld_type', { lineId: 'L-101', at: [76, 0, 3000], type: 'site' }, 'ISO_WELD_NOT_FOUND', 'at');
    expectRefusal(numbered, 'set_weld_type', { type: 'site' }, 'ISO_PARAM_INVALID');
  });
});

describe('set_fabrication_rules', () => {
  it('stores values with their source, merges later calls, and refuses an empty call or a bad prefix', () => {
    const first = apply(createEmptyDocument(), 'set_fabrication_rules', {
      source: 'shop A',
      weldGapMm: 3,
      maxSpoolLengthMm: 12000,
      maxSpoolWidthMm: 2500,
      maxSpoolHeightMm: 2500,
      maxSpoolWeightKg: 500,
    });
    const second = ok(first, 'set_fabrication_rules', { source: 'shop B', fieldFitAllowanceMm: 100, maxSpoolPieces: 8 });
    expect((second.data as { rules: unknown }).rules).toEqual({
      weldGapMm: { value: 3, source: 'shop A' },
      fieldFitAllowanceMm: { value: 100, source: 'shop B' },
      maxSpool: { lengthMm: 12000, widthMm: 2500, heightMm: 2500, weightKg: 500, pieces: 8, source: 'shop B' },
    });
    expectRefusal(createEmptyDocument(), 'set_fabrication_rules', { source: 'x' }, 'ISO_PARAM_INVALID');
    expectRefusal(createEmptyDocument(), 'set_fabrication_rules', { source: 'x', spoolPrefix: 'bad prefix!' }, 'ISO_PARAM_INVALID');
  });
});

describe('is pure and replays', () => {
  it('mutating commands do not change their input and replay_history reproduces the weld data', () => {
    const base = loadedL101();
    const before = JSON.stringify(base);
    const welded = execute(base, 'add_field_weld', { lineId: 'L-101', at: [3500, 0, 3000] }).document;
    expect(JSON.stringify(base)).toBe(before);
    const numberedDoc = execute(welded, 'number_welds', { lineId: 'L-101' }).document;
    const ruled = execute(numberedDoc, 'set_weld_type', { weldId: 'L-101#3', type: 'field_fit' }).document;
    const replayed = execute(ruled, 'replay_history', {}).document;
    expect(replayed.plant?.fabrication).toEqual(ruled.plant?.fabrication);
  });

  it('the slice validates after the commands (load-time check of the stored welds)', () => {
    const doc = apply(apply(loadedL101(), 'add_field_weld', { lineId: 'L-101', at: [3500, 0, 3000] }), 'number_welds', { lineId: 'L-101' });
    const raw = JSON.parse(JSON.stringify(doc)) as { plant: { fabrication: Record<string, unknown> } };
    expect(fabricationErrorsOf(raw.plant.fabrication)).toEqual([]);
    const broken = {
      ...raw.plant.fabrication,
      welds: {
        'L-101#1': {
          id: 'L-101#9',
          lineId: 'L-101',
          n: 1,
          number: 'W1',
          kind: 'shop',
          kindSet: false,
          status: 'active',
          joint: { xyz: [0, 0, 0], componentIds: [], boreMm: 1, endType: 'BW' },
        },
      },
    };
    expect(fabricationErrorsOf(broken).join('|')).toContain('must equal its key');
  });
});

import { fabricationErrors as fabricationErrorsOf } from '@aec/plant/fabrication/validate';
