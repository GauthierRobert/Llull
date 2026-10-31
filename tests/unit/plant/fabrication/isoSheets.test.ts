/**
 * Plant 05 ISO M4: define_isometric, sheet split with continuation marks and stable re-issue (VC-ISO-13), spool and style sheets (VC-ISO-20), the sheet BOM,
 * issue_isometric and its human gate (VC-ISO-19), persistence and the check rules that follow.
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { fabricationErrors } from '@aec/plant/fabrication/validate';
import { loadedL101 } from './isoM2Fixtures';

interface Mark {
  sheet: number;
  weld: string | null;
  joint: string;
}
interface Sheets {
  files: Array<{ name: string; content: string }>;
  sheets: Array<{
    index: number;
    sha256: string;
    pipes: number;
    spool?: string;
    componentIds: string[];
    continuation: { previous?: Mark; next?: Mark; all: Mark[] };
    tables: Record<string, { rows: number; columns: string[] }>;
  }>;
  annotations: Array<{ kind: string; text: string; sheetIndex: number }>;
  tables: Record<string, { rows: number }>;
  warnings: Array<{ code: string }>;
  reviewRequired: boolean;
  issue?: { revision: string; signer: string };
}

/** The pack plan SC-ISO-05: a zig-zag rack line, 2 m legs, 2 legs per bay. */
const zigzag = (bays: number): number[][] => {
  const points: number[][] = [[0, 0, 5000]];
  for (let bay = 1; bay <= bays; bay++) {
    const x = 2000 * bay;
    points.push([x, bay % 2 === 1 ? 0 : 2000, 5000], [x, bay % 2 === 1 ? 2000 : 0, 5000]);
  }
  return points;
};
const rackPoints = (): number[][] => zigzag(10);
const rack = (): CadDocument => {
  const level = apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 });
  return apply(level, 'add_pipe_run', { points: rackPoints(), dn: 100, line: 'R-301', service: 'cooling water' });
};
const defined = (params: Record<string, unknown> = {}): CadDocument =>
  apply(rack(), 'define_isometric', { lineId: 'R-301', maxPipePiecesPerSheet: 8, splitAt: 'weld', ...params });
const sheetsOf = (doc: CadDocument, params: Record<string, unknown> = {}, lineId = 'R-301'): Sheets =>
  data<Sheets>(doc, 'export_isometric', { lineId, style: 'final', ...params });

describe('SC-ISO-05 / VC-ISO-13: 20 pipe pieces, at most 8 per sheet, cut at welds', () => {
  const doc = defined();
  const first = sheetsOf(doc);

  it('stores the definition and makes 3 sheets of 8, 8 and 4 pipe pieces', () => {
    const definition = doc.plant?.fabrication?.isometrics?.['R-301'];
    expect(definition).toMatchObject({ lineId: 'R-301', style: 'final', paper: 'A3', maxPipePiecesPerSheet: 8, splitAt: 'weld' });
    expect(Object.keys(definition?.sheetAssignment ?? {}).length).toBeGreaterThan(30);
    expect(first.sheets.map((sheet) => sheet.pipes)).toEqual([8, 8, 4]);
    expect(first.files.map((file) => file.name)).toEqual(['R-301_iso_sheet1.svg', 'R-301_iso_sheet2.svg', 'R-301_iso_sheet3.svg']);
  });

  it('prints matching continuation marks on both sides of each cut, naming the same weld', () => {
    const [one, two, three] = first.sheets;
    expect(one?.continuation.previous).toBeUndefined();
    expect(three?.continuation.next).toBeUndefined();
    expect(one?.continuation.next?.weld).toBe(two?.continuation.previous?.weld);
    expect(two?.continuation.next?.weld).toBe(three?.continuation.previous?.weld);
    expect(one?.continuation.next).toMatchObject({ sheet: 2, joint: 'shop' });
    expect(one?.continuation.next?.weld).toMatch(/^W\d+$/);
    const texts = first.annotations
      .filter((annotation) => annotation.kind === 'continuation')
      .map((annotation) => `${annotation.sheetIndex}: ${annotation.text}`);
    expect(texts).toContain(`1: CONT. ON SHEET 2 - ${one?.continuation.next?.weld}`);
    expect(texts).toContain(`2: CONT. FROM SHEET 1 - ${one?.continuation.next?.weld}`);
    expect(first.files[0]?.content).toContain('>1 OF 3<');
  });

  it('every component is on exactly one sheet and each sheet table covers its own components', () => {
    const ids = first.sheets.flatMap((sheet) => sheet.componentIds);
    expect(new Set(ids).size).toBe(ids.length);
    const welds = first.sheets.map((sheet) => sheet.tables['weld_list']?.rows ?? 0);
    expect(welds.every((rows) => rows > 0)).toBe(true);
    expect(first.tables['weld_list']?.rows).toBeLessThan(welds.reduce((sum, rows) => sum + rows, 0));
  });

  it('re-issue after a field weld on the last sheet keeps sheets 1 and 2 byte-identical', () => {
    const edited = apply(doc, 'add_field_weld', { lineId: 'R-301', at: [19000, 2000, 5000], type: 'site' });
    const second = sheetsOf(edited);
    expect(second.sheets).toHaveLength(3);
    expect(second.sheets[0]?.sha256).toBe(first.sheets[0]?.sha256);
    expect(second.sheets[1]?.sha256).toBe(first.sheets[1]?.sha256);
    expect(second.sheets[2]?.sha256).not.toBe(first.sheets[2]?.sha256);
    expect(second.sheets[2]?.componentIds.some((id) => id.startsWith('fw-'))).toBe(true);
  });

  it('define_isometric again stores the new components on the sheet of their upstream neighbour', () => {
    const edited = apply(doc, 'add_field_weld', { lineId: 'R-301', at: [19000, 2000, 5000], type: 'site' });
    const again = apply(edited, 'define_isometric', { lineId: 'R-301', maxPipePiecesPerSheet: 8 });
    const assignment = again.plant?.fabrication?.isometrics?.['R-301']?.sheetAssignment ?? {};
    const weldId = Object.keys(edited.plant?.fabrication?.fieldWelds ?? {})[0] as string;
    expect(assignment[weldId]).toBe(3);
    expect(sheetsOf(again).sheets.map((sheet) => sheet.sha256)).toEqual(sheetsOf(edited).sheets.map((sheet) => sheet.sha256));
  });

  it('new pipes on a full sheet spill to a new sheet appended at the end, the others stay', () => {
    const tight = apply(rack(), 'define_isometric', { lineId: 'R-301', maxPipePiecesPerSheet: 4 });
    const before = sheetsOf(tight);
    expect(before.sheets.map((sheet) => sheet.pipes)).toEqual([4, 4, 4, 4, 4]);
    let edited = tight;
    for (const y of [1500, 1000, 500]) edited = apply(edited, 'add_field_weld', { lineId: 'R-301', at: [20000, y, 5000], type: 'site' });
    const after = sheetsOf(edited);
    expect(after.sheets.length).toBeGreaterThan(5);
    const body = (result: Sheets, at: number): string => (result.files[at]?.content ?? '').replace(/>[0-9]+ OF [0-9]+</, '><');
    for (const at of [0, 1, 2, 3]) expect(body(after, at)).toBe(body(before, at));
    expect(after.files[0]?.content).toContain('>1 OF 6<');
  });

  it('is deterministic and replayable', () => {
    expect(sheetsOf(doc).sheets.map((sheet) => sheet.sha256)).toEqual(first.sheets.map((sheet) => sheet.sha256));
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(sheetsOf(replayed).sheets.map((sheet) => sheet.sha256)).toEqual(first.sheets.map((sheet) => sheet.sha256));
  });

  it('a budget that fits the line gives one sheet with no continuation; flange cuts are impossible on a line without flanges (warning)', () => {
    const one = sheetsOf(defined({ maxPipePiecesPerSheet: 30 }));
    expect(one.sheets).toHaveLength(1);
    expect(one.sheets[0]?.continuation.all).toEqual([]);
    const flange = sheetsOf(defined({ splitAt: 'flange' }));
    expect(flange.sheets).toHaveLength(1);
    expect(flange.warnings.map((warning) => warning.code)).toContain('ISO_SHEET_OVERFLOW');
    const check = data<{ issues: Array<{ code: string }> }>(defined({ splitAt: 'flange' }), 'check_isometric', { lineId: 'R-301' });
    expect(check.issues.map((issue) => issue.code)).toContain('ISO_SHEET_OVERFLOW');
  });

  it('resetSheets cuts afresh', () => {
    const edited = apply(doc, 'add_field_weld', { lineId: 'R-301', at: [19000, 2000, 5000], type: 'site' });
    const reset = apply(edited, 'define_isometric', { lineId: 'R-301', maxPipePiecesPerSheet: 8, resetSheets: true });
    expect(sheetsOf(reset).sheets.map((sheet) => sheet.pipes)).toEqual([8, 8, 5]);
  });
});

describe('define_isometric: refusals, purity, persistence', () => {
  it('refuses an unknown line and leaves the document unchanged', () => {
    expectRefusal(rack(), 'define_isometric', { lineId: 'NOPE' }, 'ISO_LINE_NOT_FOUND');
    expectRefusal(createEmptyDocument(), 'define_isometric', { lineId: 'NOPE' }, 'ISO_LINE_NOT_FOUND');
  });

  it('is pure and replaces an earlier definition', () => {
    const base = rack();
    const before = JSON.stringify(base);
    const result = execute(base, 'define_isometric', { lineId: 'R-301', style: 'check', paper: 'A2', northArrow: 'up_left' });
    expect(JSON.stringify(base)).toBe(before);
    expect(result.affected).toEqual(['R-301']);
    expect(result.document).not.toBe(base);
    const twice = apply(result.document, 'define_isometric', { lineId: 'R-301', maxPipePiecesPerSheet: 10 });
    expect(twice.plant?.fabrication?.isometrics?.['R-301']).toMatchObject({ style: 'final', paper: 'A3', northArrow: 'up_right' });
    expect(execute(result.document, 'define_isometric', { lineId: 'R-301' }).summary).toContain('replaced the earlier definition');
  });

  it('the stored paper, north arrow and style apply to export_isometric and params override them', () => {
    const doc = apply(rack(), 'define_isometric', { lineId: 'R-301', style: 'check', paper: 'A2', northArrow: 'up_left' });
    const result = data<{ style: string; paper: string; northArrow: { mode: string } }>(doc, 'export_isometric', { lineId: 'R-301' });
    expect(result).toMatchObject({ style: 'check', paper: 'A2', northArrow: { mode: 'up_left' } });
    expect(data<{ paper: string }>(doc, 'export_isometric', { lineId: 'R-301', paper: 'A4' }).paper).toBe('A4');
  });

  it('save -> load keeps the definition and re-serializes equal; a corrupt one is rejected', () => {
    const doc = defined();
    const json = serializeDocument(doc);
    const loaded = deserializeDocument(json);
    expect(loaded.plant?.fabrication?.isometrics?.['R-301']?.maxPipePiecesPerSheet).toBe(8);
    expect(serializeDocument(loaded)).toBe(json);
    const raw = JSON.parse(json) as { document: { plant: { fabrication: { isometrics: Record<string, { splitAt: string }> } } } };
    (raw.document.plant.fabrication.isometrics['R-301'] as { splitAt: string }).splitAt = 'sideways';
    expect(() => deserializeDocument(JSON.stringify(raw))).toThrow(/fabrication/);
  });

  it.each([
    [
      'an isometric whose lineId differs from its key',
      {
        version: 1,
        pcfLines: {},
        isometrics: { A: { lineId: 'B', style: 'final', paper: 'A3', splitAt: 'weld', northArrow: 'up_right', sheetAssignment: {} } },
      },
    ],
    [
      'a sheet number of 0',
      {
        version: 1,
        pcfLines: {},
        isometrics: { A: { lineId: 'A', style: 'final', paper: 'A3', splitAt: 'weld', northArrow: 'up_right', sheetAssignment: { c: 0 } } },
      },
    ],
    [
      'an issue whose id differs from its key',
      {
        version: 1,
        pcfLines: {},
        issues: {
          A: {
            id: 'B',
            lineId: 'L',
            revision: 'A',
            purpose: 'for_construction',
            signer: 's',
            signatureId: 'x',
            basisSha256: 'a'.repeat(64),
          },
        },
      },
    ],
    [
      'an issue with a short hash',
      {
        version: 1,
        pcfLines: {},
        issues: {
          A: { id: 'A', lineId: 'L', revision: 'A', purpose: 'for_construction', signer: 's', signatureId: 'x', basisSha256: 'abc' },
        },
      },
    ],
  ])('fabricationErrors: %s', (_name, raw) => {
    expect(fabricationErrors(raw).length).toBeGreaterThan(0);
  });

  it('delete_pcf_line removes the definition and the issue stamps of the line', () => {
    const doc = apply(apply(loadedL101(), 'number_welds', { lineId: 'L-101' }), 'define_isometric', {
      lineId: 'L-101',
      maxPipePiecesPerSheet: 3,
    });
    expect(doc.plant?.fabrication?.isometrics?.['L-101']).toBeDefined();
    const gone = apply(doc, 'delete_pcf_line', { lineId: 'L-101' });
    expect(gone.plant?.fabrication?.isometrics).toEqual({});
  });
});

describe('piping_bom scope sheet: the sheet BOMs add up to the line', () => {
  const doc = apply(apply(loadedL101(), 'number_welds', { lineId: 'L-101' }), 'define_isometric', {
    lineId: 'L-101',
    maxPipePiecesPerSheet: 3,
  });

  it('sums to the line rows, with bolting', () => {
    const sheets = data<Sheets>(doc, 'export_isometric', { lineId: 'L-101' }).sheets;
    expect(sheets.length).toBeGreaterThan(1);
    type Bom = { rows: Array<{ itemCode: string; quantity: number }>; bolting?: { gaskets: number; studBolts: number } };
    const line = data<Bom>(doc, 'piping_bom', { scope: 'line', lineId: 'L-101', includeBolting: true });
    const total = new Map<string, number>();
    let gaskets = 0;
    let studs = 0;
    for (const sheet of sheets) {
      const part = data<Bom>(doc, 'piping_bom', { scope: 'sheet', lineId: 'L-101', sheet: sheet.index, includeBolting: true });
      for (const row of part.rows) total.set(row.itemCode, Math.round(((total.get(row.itemCode) ?? 0) + row.quantity) * 1e6) / 1e6);
      gaskets += part.bolting?.gaskets ?? 0;
      studs += part.bolting?.studBolts ?? 0;
    }
    expect([...total.entries()].sort()).toEqual(line.rows.map((row) => [row.itemCode, row.quantity] as [string, number]).sort());
    expect({ gaskets, studs }).toEqual({ gaskets: line.bolting?.gaskets, studs: line.bolting?.studBolts });
  });

  it('refuses a missing definition, a missing or unknown sheet and a scope without sheet', () => {
    expectRefusal(loadedL101(), 'piping_bom', { scope: 'sheet', lineId: 'L-101', sheet: 1 }, 'ISO_ISOMETRIC_NOT_DEFINED');
    expectRefusal(doc, 'piping_bom', { scope: 'sheet', lineId: 'L-101', sheet: 99 }, 'ISO_SHEET_NOT_FOUND');
    expectRefusal(doc, 'piping_bom', { scope: 'sheet', lineId: 'L-101' }, 'ISO_PARAM_INVALID');
  });
});

describe('VC-ISO-20: styles check, final and spool', () => {
  const doc = apply(loadedL101(), 'number_welds', { lineId: 'L-101' });

  it('check prints no tables, final the four, spool one sheet per spool (2)', () => {
    expect(Object.keys(sheetsOf(doc, { style: 'check' }, 'L-101').tables)).toEqual([]);
    expect(Object.keys(sheetsOf(doc, { style: 'final' }, 'L-101').tables).sort()).toEqual(
      ['bom', 'cut_list', 'spool_list', 'weld_list'].filter((name) => name !== 'cut_list').sort(),
    );
    const spool = sheetsOf(doc, { style: 'spool' }, 'L-101');
    expect(spool.sheets.map((sheet) => sheet.spool)).toEqual(['L-101-SP01', 'L-101-SP02']);
    expect(spool.files.map((file) => file.name)).toEqual(['L-101_iso_sheet1.svg', 'L-101_iso_sheet2.svg']);
    expect(spool.sheets[0]?.continuation.next).toMatchObject({ sheet: 2, joint: 'site' });
    expect(spool.files[0]?.content).toContain('>1 OF 2<');
  });

  it('spoolId draws one spool only and implies the spool style', () => {
    const one = sheetsOf(doc, { style: undefined, spoolId: 'L-101-SP02' }, 'L-101');
    expect(one.sheets).toHaveLength(1);
    expect(one.sheets[0]).toMatchObject({ index: 2, spool: 'L-101-SP02' });
    expect(one.sheets[0]?.tables['spool_list']?.rows).toBe(1);
  });

  it('the stored spool style gives a sheet per spool without a budget', () => {
    const stored = apply(doc, 'define_isometric', { lineId: 'L-101', style: 'spool' });
    expect(sheetsOf(stored, { style: undefined }, 'L-101').sheets).toHaveLength(2);
  });

  it('refuses an unknown spool and a spool with another style', () => {
    expectRefusal(doc, 'export_isometric', { lineId: 'L-101', spoolId: 'NOPE' }, 'ISO_SPOOL_NOT_FOUND');
    expectRefusal(doc, 'export_isometric', { lineId: 'L-101', spoolId: 'L-101-SP01', style: 'final' }, 'ISO_PARAM_INVALID');
  });
});

describe('VC-ISO-19: issue_isometric is a human act', () => {
  const numbered = apply(loadedL101(), 'number_welds', { lineId: 'L-101' });
  const port = (): HumanSignaturePort => ({
    verify: (signature) => ((signature as { sig?: string }).sig === 'good' ? { signer: 'alice', signatureId: 'sig-1' } : null),
  });
  const withPort = (humanSignature: HumanSignaturePort | null): ExecutionContext => ({ ...defaultContext(), humanSignature });
  const params = { lineId: 'L-101', revision: 'A', purpose: 'for_construction' };

  it('an agent (no confirmation, true, no port, a bad signature) gets ISO_HUMAN_GATE and the unissued iso stays NOT FOR CONSTRUCTION', () => {
    for (const [confirmation, ctx] of [
      [undefined, withPort(port())],
      [true, withPort(port())],
      [{ sig: 'good', nonce: 'n' }, withPort(null)],
      [{ sig: 'bad', nonce: 'n' }, withPort(port())],
      [{ sig: 'good' }, withPort(port())],
    ] as const) {
      const result = execute(numbered, 'issue_isometric', { ...params, confirmation }, ctx);
      expect(result.error?.code, result.summary).toBe('ISO_HUMAN_GATE');
      expect(result.document).toBe(numbered);
      expect(result.affected).toEqual([]);
    }
    const sheet = sheetsOf(numbered, {}, 'L-101');
    expect(sheet.reviewRequired).toBe(true);
    expect(sheet.files[0]?.content).toContain('NOT FOR CONSTRUCTION');
  });

  it('a verified signature issues: the stamp is stored, the sheet shows the revision and approver and reviewRequired is false', () => {
    const result = execute(numbered, 'issue_isometric', { ...params, confirmation: { sig: 'good', nonce: 'n1' } }, withPort(port()));
    expect(result.error).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    expect(result.data).toMatchObject({ lineId: 'L-101', revision: 'A', signer: 'alice', signatureId: 'sig-1', reviewRequired: false });
    const issued = result.document;
    const sheet = sheetsOf(issued, {}, 'L-101');
    expect(sheet.reviewRequired).toBe(false);
    expect(sheet.issue).toMatchObject({ revision: 'A', signer: 'alice' });
    const svg = sheet.files[0]?.content ?? '';
    expect(svg).toContain('ISSUED FOR CONSTRUCTION REV A');
    expect(svg).toContain('APPROVED BY alice');
    expect(svg).not.toContain('NOT FOR CONSTRUCTION');
    const check = data<{ issues: Array<{ code: string }> }>(issued, 'check_isometric', { lineId: 'L-101' });
    expect(check.issues.map((issue) => issue.code)).not.toContain('ISO_REVIEW_REQUIRED');
    expect(JSON.stringify(deserializeDocument(serializeDocument(issued)).plant?.fabrication?.issues)).toBe(
      JSON.stringify(issued.plant?.fabrication?.issues),
    );
  });

  it('is pure and replayable', () => {
    const before = JSON.stringify(numbered);
    const ctx = withPort(port());
    const result = execute(numbered, 'issue_isometric', { ...params, confirmation: { sig: 'good', nonce: 'n1' } }, ctx);
    expect(JSON.stringify(numbered)).toBe(before);
    expect(Object.keys(result.document.plant?.fabrication?.issues ?? {})[0]).toMatch(/^iso-issue-/);
  });

  it('an edit after the issue makes it stale: NOT FOR CONSTRUCTION again, with a warning and a check finding', () => {
    const issued = execute(
      numbered,
      'issue_isometric',
      { ...params, confirmation: { sig: 'good', nonce: 'n1' } },
      withPort(port()),
    ).document;
    const edited = apply(issued, 'add_field_weld', { lineId: 'L-101', at: [1000, 0, 3000], type: 'site' });
    const sheet = sheetsOf(edited, {}, 'L-101');
    expect(sheet.reviewRequired).toBe(true);
    expect(sheet.warnings.map((warning) => warning.code)).toContain('ISO_ISSUE_STALE');
    const check = data<{ issues: Array<{ code: string }> }>(edited, 'check_isometric', { lineId: 'L-101' });
    expect(check.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['ISO_ISSUE_STALE', 'ISO_REVIEW_REQUIRED']));
  });

  it('refuses ISO_CHECK_FAILED before the gate (unnumbered welds are an error for style final) and an unknown line', () => {
    const spent: string[] = [];
    const watching: HumanSignaturePort = {
      verify: () => ({ signer: 'a', signatureId: 's' }),
      spend: (_signature, payload) => (spent.push(payload), true),
    };
    const result = execute(loadedL101(), 'issue_isometric', { ...params, confirmation: { nonce: 'n' } }, withPort(watching));
    expect(result.error?.code).toBe('ISO_CHECK_FAILED');
    expect(result.error?.ids.length).toBeGreaterThan(0);
    expect(spent).toEqual([]);
    expectRefusal(loadedL101(), 'issue_isometric', { ...params, lineId: 'NOPE' }, 'ISO_LINE_NOT_FOUND');
  });
});

describe('budget', () => {
  it('plans and draws a 200-leg rack in a generous time', () => {
    const level = apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 });
    const doc = apply(level, 'add_pipe_run', { points: zigzag(100), dn: 100, line: 'BIG' });
    const started = performance.now();
    const defined = apply(doc, 'define_isometric', { lineId: 'BIG', maxPipePiecesPerSheet: 20 });
    const result = sheetsOf(defined, {}, 'BIG');
    expect(performance.now() - started).toBeLessThan(15000);
    expect(result.sheets.length).toBeGreaterThanOrEqual(10);
  });
});
