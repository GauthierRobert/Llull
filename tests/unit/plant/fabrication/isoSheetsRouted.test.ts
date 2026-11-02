/**
 * Plant 05 ISO M5: VC-ISO-13 on a spec-driven line - 20 pipe pieces, at most 8 per sheet, cut at welds -> 3 sheets, matching continuation welds, stable re-issue - with
 * the line coming from a PCF imported as route (the zig-zag rack of SC-ISO-05, real elbows and flange sets from the spec).
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';
import { addTie, cs150Document, cs150Line } from '../piping/rteFixtures';

interface Mark {
  sheet: number;
  weld: string | null;
  joint: string;
}
interface Sheets {
  files: Array<{ name: string; sha256: string }>;
  sheets: Array<{ index: number; sha256: string; pipes: number; continuation: { previous?: Mark; next?: Mark; all: Mark[] } }>;
  annotations: Array<{ kind: string; text: string; sheetIndex: number }>;
  warnings: Array<{ code: string }>;
}

/** A zig-zag of 2 m legs at z = 5000: +X, +Y, +X, -Y ... 20 legs, so 20 pipe pieces between 19 elbows. */
function rackText(): string {
  const line = cs150Line(100, '9001');
  const a = addTie(line.doc, 'RK-A', [0, 0, 5000], [1, 0, 0], { endType: 'BW' });
  const legs = Array.from({ length: 20 }, (_unused, k) => ({
    direction: k % 2 === 0 ? '+X' : Math.floor(k / 2) % 2 === 0 ? '+Y' : '-Y',
    length: 2000,
  }));
  const doc = apply(a.doc, 'route_pipe', { lineId: line.lineId, from: { portId: a.id }, legs });
  const files = data<{ files: Array<{ content: string }> }>(doc, 'export_pcf', { lineIds: [line.lineId] }).files;
  return (files[0] as { content: string }).content.replace(/PIPELINE-REFERENCE .*/, 'PIPELINE-REFERENCE R-301');
}

function routedRack(): { doc: CadDocument; lineId: string } {
  const imported = apply(cs150Document(), 'import_pcf', { text: rackText(), as: 'route', spec: 'CS150' });
  return { doc: imported, lineId: imported.plant?.piping?.lineOrder[0] as string };
}

const sheetsOf = (doc: CadDocument, lineId: string): Sheets => data<Sheets>(doc, 'export_isometric', { lineId, style: 'final' });

describe('VC-ISO-13 on a routed line (import_pcf as route)', () => {
  const { doc: base, lineId } = routedRack();
  const doc = apply(base, 'define_isometric', { lineId, maxPipePiecesPerSheet: 8, splitAt: 'weld' });
  const first = sheetsOf(doc, lineId);

  it('the rack has 20 pipe pieces and 19 elbows', () => {
    const counts = data<{ rows: Array<{ type: string; quantity: number }> }>(base, 'piping_bom', { scope: 'line', lineId });
    expect(counts.rows.find((row) => row.type === 'ELBOW')?.quantity).toBe(19);
  });

  it('is cut into 3 sheets of 8, 8 and 4 pipe pieces', () => {
    expect(first.sheets.map((sheet) => sheet.pipes)).toEqual([8, 8, 4]);
  });

  it('prints matching continuation marks naming the same weld on both sides of each cut', () => {
    const [one, two, three] = first.sheets;
    expect(one?.continuation.next?.weld).toBe(two?.continuation.previous?.weld);
    expect(two?.continuation.next?.weld).toBe(three?.continuation.previous?.weld);
    expect(one?.continuation.next).toMatchObject({ sheet: 2, joint: 'shop' });
    const texts = first.annotations
      .filter((annotation) => annotation.kind === 'continuation')
      .map((annotation) => `${annotation.sheetIndex}: ${annotation.text}`);
    expect(texts).toContain(`1: CONT. ON SHEET 2 - ${one?.continuation.next?.weld}`);
    expect(texts).toContain(`2: CONT. FROM SHEET 1 - ${one?.continuation.next?.weld}`);
  });

  it('re-issue is stable: a field weld on the last sheet leaves sheets 1 and 2 byte-identical, and the sheet count stays 3', () => {
    const edited = apply(doc, 'add_field_weld', { lineId, at: [20000, 1000, 5000], type: 'site' });
    const second = sheetsOf(edited, lineId);
    const welds = (document: CadDocument): number => data<{ welds: unknown[] }>(document, 'weld_list', { lineId }).welds.length;
    expect(welds(edited)).toBe(welds(doc) + 1);
    expect(second.sheets).toHaveLength(3);
    expect(second.sheets[0]?.sha256).toBe(first.sheets[0]?.sha256);
    expect(second.sheets[1]?.sha256).toBe(first.sheets[1]?.sha256);
  });

  it('the same document gives the same bytes twice', () => {
    expect(sheetsOf(doc, lineId).files.map((file) => file.sha256)).toEqual(first.files.map((file) => file.sha256));
  });
});
