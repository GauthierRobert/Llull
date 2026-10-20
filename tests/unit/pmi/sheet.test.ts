/** 03 GDT M4: PMI on drawing sheets: pmiMode auto selection, explicit lists, painter output, skip report (VC-GDT-10, 11). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { plateKernel } from '../../helpers/pmiPlateKernel';

interface Step {
  command: string;
  params: Record<string, unknown>;
  as?: string;
}
const plan = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../docs/aerospace/03-gdt-mbd-pmi/validation/draft_plan_gdt_plate.json'), 'utf8'),
) as Step[];

interface SheetData {
  svg: string;
  fits: boolean;
  views: Array<{ id: string; label: string }>;
  pmi?: { placed: Array<{ viewId: string; pmiIds: string[] }>; skipped: Array<{ pmiId: string; reason: string }> };
}

/** The plate with PMI and a sheet with front / top / right views, pmiMode left off. */
function build(): { document: CadDocument; ids: Record<string, string>; sheet: string } {
  const actions = plan.filter((s) => s.command !== 'export_step_ap242' && s.command !== 'update_sheet' && s.command !== 'export_sheet_svg');
  const document = execute(createEmptyDocument(), 'build_project', { actions, onError: 'continue' }).document;
  const items = Object.values(document.pmi?.items ?? {});
  const idOf = (pred: (i: (typeof items)[number]) => boolean): string => (items.find(pred) as { id: string }).id;
  const sizeId = (count: number): string => idOf((i) => i.kind === 'size_dimension' && i.count === count);
  const frame = (target: string): string =>
    idOf((i) => i.kind === 'geometric_tolerance' && 'pmiId' in i.target && i.target.pmiId === target);
  const ids = {
    holeSize: sizeId(4),
    boreSize: sizeId(1),
    posHoles: frame(sizeId(4)),
    posBore: frame(sizeId(1)),
    flat: idOf((i) => i.kind === 'geometric_tolerance' && i.characteristic === 'flatness'),
    perp: idOf((i) => i.kind === 'geometric_tolerance' && i.characteristic === 'perpendicularity'),
    dA: idOf((i) => i.kind === 'datum_feature' && i.label === 'A'),
    dB: idOf((i) => i.kind === 'datum_feature' && i.label === 'B'),
    dC: idOf((i) => i.kind === 'datum_feature' && i.label === 'C'),
    st: idOf((i) => i.kind === 'surface_texture'),
  };
  return { document, ids, sheet: Object.keys(document.drawings?.sheets ?? {})[0] as string };
}

beforeEach(() => setGeometryKernel(plateKernel()));
afterEach(() => setGeometryKernel(null));

const exportSvg = (doc: CadDocument, sheetId: string): SheetData => execute(doc, 'export_sheet_svg', { sheetId }).data as SheetData;
const placedOn = (data: SheetData, label: string): string[] => {
  const viewId = data.views.find((v) => v.label.startsWith(label))?.id;
  return [...(data.pmi?.placed.find((p) => p.viewId === viewId)?.pmiIds ?? [])].sort();
};

describe('pmiMode auto', () => {
  it('puts each item on the view its annotation plane faces and reports placed / skipped (VC-GDT-10, 11)', () => {
    const { document, ids, sheet } = build();
    const data = exportSvg(execute(document, 'update_sheet', { sheetId: sheet, pmiMode: 'auto' }).document, sheet);
    expect(placedOn(data, 'TOP')).toEqual([ids.holeSize, ids.boreSize, ids.posHoles, ids.posBore].sort());
    expect(placedOn(data, 'FRONT')).toEqual([ids.flat, ids.dA, ids.st, ids.dC].sort());
    expect(placedOn(data, 'RIGHT')).toEqual([ids.dB, ids.perp].sort());
    expect(data.pmi?.skipped).toEqual([]);
    expect(data.fits).toBe(true);
    expect(data.svg).toContain(`id="pmi-${ids.posHoles}"`);
    expect(data.svg).toContain('data-kind="geometric_tolerance"');
    expect(data.svg).toContain('data-kind="datum_feature"');
    expect(data.svg).toContain('data-kind="surface_texture"');
  });

  it('draws nothing without pmiMode and leaves the export data unchanged', () => {
    const { document, sheet } = build();
    const data = exportSvg(document, sheet);
    expect(data.pmi).toBeUndefined();
    expect(data.svg).not.toContain('id="pmi-');
  });

  it('is deterministic and the document is not changed by the export', () => {
    const { document, sheet } = build();
    const on = execute(document, 'update_sheet', { sheetId: sheet, pmiMode: 'auto' }).document;
    const before = JSON.stringify(on);
    expect(exportSvg(on, sheet).svg).toBe(exportSvg(on, sheet).svg);
    expect(JSON.stringify(on)).toBe(before);
  });

  it('skips with a reason what no view can show: iso only, solid not in the view', () => {
    const { document } = build();
    const iso = execute(document, 'create_sheet', { name: 'Iso', views: ['iso'] });
    const isoSheet = iso.affected[0] as string;
    const onIso = execute(iso.document, 'update_sheet', { sheetId: isoSheet, pmiMode: 'auto' }).document;
    const skipped = exportSvg(onIso, isoSheet).pmi?.skipped ?? [];
    expect(skipped.length).toBe(10);
    expect(new Set(skipped.map((s) => s.reason))).toEqual(new Set(['GDT_SHEET_VIEW_KIND_UNSUPPORTED']));
    const box = execute(onIso, 'add_box', { size: [5, 5, 5] });
    const only = execute(box.document, 'create_sheet', { name: 'Box only', views: ['front'], entityIds: [box.affected[0] as string] });
    const onBox = execute(only.document, 'update_sheet', { sheetId: only.affected[0] as string, pmiMode: 'auto' }).document;
    const reasons = exportSvg(onBox, only.affected[0] as string).pmi?.skipped ?? [];
    expect(reasons.length).toBe(10);
    expect(new Set(reasons.map((s) => s.reason))).toEqual(new Set(['GDT_SHEET_SOLID_NOT_IN_VIEW']));
  });
});

describe('explicit PMI lists', () => {
  it('update_drawing_view pmiIds overrides the automatic selection and rejects unknown ids', () => {
    const { document, ids, sheet } = build();
    const view = document.drawings?.sheets[sheet]?.views.find((v) => v.direction === 'front')?.id as string;
    const bad = execute(document, 'update_drawing_view', { sheetId: sheet, viewId: view, pmiIds: ['nope'] });
    expect(bad.document).toBe(document);
    expect(bad.summary).toContain('GDT_PMI_UNKNOWN');
    const set = execute(document, 'update_drawing_view', { sheetId: sheet, viewId: view, pmiIds: [ids.holeSize, ids.dA] });
    expect(set.affected).toEqual([view]);
    const data = exportSvg(set.document, sheet);
    expect(placedOn(data, 'FRONT')).toEqual([ids.holeSize, ids.dA].sort());
    const auto = execute(set.document, 'update_drawing_view', { sheetId: sheet, viewId: view, pmiAuto: true });
    expect(auto.document.drawings?.sheets[sheet]?.views.find((v) => v.id === view)?.pmiIds).toBeUndefined();
  });

  it('reports an explicit id that was deleted since', () => {
    const { document, ids, sheet } = build();
    const view = document.drawings?.sheets[sheet]?.views[0]?.id as string;
    const set = execute(document, 'update_drawing_view', { sheetId: sheet, viewId: view, pmiIds: [ids.st] });
    const gone = execute(set.document, 'delete_pmi', { pmiId: ids.st });
    const data = exportSvg(gone.document, sheet);
    expect(data.pmi?.skipped).toEqual([{ pmiId: ids.st, reason: 'GDT_PMI_UNKNOWN' }]);
  });
});
