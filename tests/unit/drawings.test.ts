import { describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { SheetPainter, n, paperDimension } from '@core/commands/drawings/svgPainter';
import { scaleText, nextMark } from '@core/commands/drawings/sheetOps';
import { layoutViews } from '@core/commands/drawings/layout';
import type { DrawingView } from '@core/model/sheet';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { run } from '../helpers/runFixtures';

interface Exported {
  svg: string;
  sheetId: string;
  paper: string;
  scale: number;
  fits: boolean;
  views: Array<{ id: string; label: string; kind: string; scale: number; scaleText: string; bounds: number[] }>;
  skipped: Array<{ id: string; reason: string }>;
}

const boxDoc = (size: [number, number, number] = [100, 60, 40]): CadDocument => run(createEmptyDocument(), 'add_box', { size });

const exportSheet = (doc: CadDocument, sheetId: string, showDimensions = false): Exported =>
  execute(doc, 'export_sheet_svg', { sheetId, showDimensions }).data as Exported;

/** Visible-edge lines (thick) inside the group of `viewId`. */
const visibleLines = (svg: string, viewId: string): number => {
  const group = svg.split(`<g id="view-${viewId}"`)[1]?.split('</g>')[0] ?? '';
  return (group.match(/class="cut-line"/g) ?? []).length;
};

function sheetWithViews(
  doc = boxDoc(),
  views: string[] = ['front', 'top', 'right'],
): { doc: CadDocument; sheetId: string; viewIds: string[] } {
  const result = execute(doc, 'create_sheet', { name: 'Part', views, title: 'Box', date: '2026-01-02' });
  return { doc: result.document, sheetId: result.affected[0] as string, viewIds: result.affected.slice(1) };
}

describe('create_sheet', () => {
  it('creates a sheet with front/top/right views and reports ids', () => {
    const base = boxDoc();
    const result = execute(base, 'create_sheet', { name: 'Part', views: ['front', 'top', 'right'], paper: 'A4' });
    expect(result.affected).toHaveLength(4);
    const sheet = result.document.drawings?.sheets[result.affected[0] as string];
    expect(sheet?.paper).toBe('A4');
    expect(sheet?.projectionAngle).toBe('first');
    expect(sheet?.views.map((v) => v.direction)).toEqual(['front', 'top', 'right']);
    expect(result.document.drawings?.order).toEqual([result.affected[0]]);
    expect(result.document.order).toEqual(base.order);
    expect(result.summary).toContain(result.affected[0]);
  });

  it('is pure and defaults name / title', () => {
    const base = boxDoc();
    expectPure(base, () => execute(base, 'create_sheet', { views: ['front'] }));
    const result = execute(base, 'create_sheet', {});
    const sheet = result.document.drawings?.sheets[result.affected[0] as string];
    expect(sheet?.name).toBe('Sheet 1');
    expect(sheet?.titleBlock.title).toBe('Sheet 1');
    expect(sheet?.views).toEqual([]);
  });

  it('rejects views on an empty model, unknown and 2D entities', () => {
    const empty = createEmptyDocument();
    expectNoOp(execute(empty, 'create_sheet', { views: ['front'] }), empty, 'create_sheet rejected');
    expect(execute(empty, 'create_sheet', {}).affected).toHaveLength(1);
    const doc = run(boxDoc(), 'draw_rectangle', { width: 2, height: 2 });
    const flat = Object.keys(doc.entities).find((id) => doc.entities[id]?.kind === 'rectangle' || doc.entities[id]?.kind === 'polyline');
    expectNoOp(execute(doc, 'create_sheet', { views: ['front'], entityIds: ['nope'] }), doc, "no entity 'nope'");
    expectNoOp(execute(doc, 'create_sheet', { views: ['front'], entityIds: [flat as string] }), doc, '2D shape');
  });
});

describe('export_sheet_svg (acceptance)', () => {
  it('draws front/top/right views with visible edges and follows model edits without touching the sheet', () => {
    const { doc, sheetId, viewIds } = sheetWithViews();
    const before = exportSheet(doc, sheetId);
    expect(before.views.map((v) => v.label)).toEqual(['FRONT', 'TOP', 'RIGHT']);
    for (const id of viewIds) expect(visibleLines(before.svg, id)).toBeGreaterThanOrEqual(4);
    expect(before.svg).toContain('<svg');
    expect(before.svg).toContain('2026-01-02');
    expect(before.fits).toBe(true);

    const boxId = doc.order[0] as string;
    const resized = execute(doc, 'scale_entity', { id: boxId, factor: 2 }).document;
    expect(resized.drawings).toBe(doc.drawings);
    const after = exportSheet(resized, sheetId);
    expect(after.svg).not.toBe(before.svg);
    const width = (v: { bounds: number[] }): number => (v.bounds[2] as number) - (v.bounds[0] as number);
    const frontBefore = width(before.views[0] as { bounds: number[] }) * before.scale;
    const frontAfter = width(after.views[0] as { bounds: number[] }) * after.scale;
    expect(frontAfter).toBeCloseTo(frontBefore * 2, 0);
  });

  it('is read-only, deterministic and does not store geometry', () => {
    const { doc, sheetId } = sheetWithViews();
    const first = execute(doc, 'export_sheet_svg', { sheetId });
    expect(first.document).toBe(doc);
    expect(first.affected).toEqual([]);
    expect(execute(doc, 'export_sheet_svg', { sheetId }).data).toEqual(first.data);
    expect(JSON.stringify(doc.drawings)).not.toContain('<svg');
    expect(doc.featureHistory.map((s) => s.name)).toEqual(['add_box', 'create_sheet']);
  });

  it('auto-fits the largest standard scale and honours a fixed one', () => {
    const { doc, sheetId } = sheetWithViews();
    const auto = exportSheet(doc, sheetId);
    expect([0.1, 0.2, 0.5, 1, 2, 5]).toContain(auto.scale);
    expect(auto.views[0]?.scaleText).toBe(scaleText(auto.scale));
    const fixed = run(doc, 'update_sheet', { sheetId, scale: 1000 });
    expect(exportSheet(fixed, sheetId).scale).toBe(1000);
    const huge = exportSheet(run(doc, 'update_sheet', { sheetId, scale: 0.1 }), sheetId);
    expect(huge.fits).toBe(false);
    expect(execute(run(doc, 'update_sheet', { sheetId, scale: 0.1 }), 'export_sheet_svg', { sheetId }).summary).toContain('WARNING');
  });

  it('falls back to a larger niceStep scale for a huge model and shrinks tiny ones with enlargement', () => {
    const big = sheetWithViews(boxDoc([5e6, 5e6, 5e6]), ['front', 'top']);
    expect(exportSheet(big.doc, big.sheetId).scale).toBeGreaterThan(2000);
    const tiny = sheetWithViews(boxDoc([2, 1, 1]), ['front']);
    expect(exportSheet(tiny.doc, tiny.sheetId).scale).toBeLessThan(1);
    expect(exportSheet(tiny.doc, tiny.sheetId).views[0]?.scaleText).toMatch(/^\d+:1$/);
  });

  it('adds overall dimensions on projection views when asked', () => {
    const { doc, sheetId } = sheetWithViews(boxDoc(), ['front', 'iso']);
    const plain = exportSheet(doc, sheetId).svg;
    const dimensioned = exportSheet(doc, sheetId, true).svg;
    expect(plain).not.toContain('class="dim"');
    expect(dimensioned).toContain('class="dim"');
    expect(dimensioned).toContain('>100</text>');
    expect(dimensioned).toContain('>40</text>');
    expect((dimensioned.match(/>100<\/text>/g) ?? []).length).toBe(1);
  });

  it('rejects an unknown sheet and reports skipped views', () => {
    const doc = boxDoc();
    const result = execute(doc, 'export_sheet_svg', { sheetId: 'nope' });
    expectNoOp(result, doc, 'export_sheet_svg rejected');
    expect(result.data).toBeUndefined();
    const { doc: withSheet, sheetId } = sheetWithViews(doc, ['front']);
    const emptied = run(withSheet, 'delete_entities', { ids: withSheet.order });
    const data = exportSheet(emptied, sheetId);
    expect(data.views).toEqual([]);
    expect(data.skipped[0]?.reason).toContain('no 3D solids');
    expect(execute(emptied, 'export_sheet_svg', { sheetId }).summary).toContain('Skipped 1');
  });

  it('respects hidden layers and entity subsets', () => {
    const two = run(boxDoc(), 'add_cylinder', { radius: 10, height: 30, position: [200, 0, 0] });
    const [boxId, cylinderId] = two.order as [string, string];
    const created = execute(two, 'create_sheet', { views: ['top'], entityIds: [cylinderId] });
    const sheetId = created.affected[0] as string;
    const onlyCylinder = exportSheet(created.document, sheetId);
    const both = exportSheet(
      run(created.document, 'update_drawing_view', { sheetId, viewId: created.affected[1], entityIds: [boxId, cylinderId] }),
      sheetId,
    );
    expect(both.views[0]!.bounds[2]! - both.views[0]!.bounds[0]!).toBeGreaterThan(
      onlyCylinder.views[0]!.bounds[2]! - onlyCylinder.views[0]!.bounds[0]!,
    );
    expect(onlyCylinder.svg).toContain('class="center"');
    const hidden = run(two, 'update_layer', { id: 'layer-default', visible: false });
    const sheet = run(hidden, 'create_sheet', {});
    expect(sheet.drawings).toBeDefined();
  });
});

describe('create_drawing_view', () => {
  it('adds a view and rejects bad input', () => {
    const { doc, sheetId } = sheetWithViews(boxDoc(), ['front']);
    const added = execute(doc, 'create_drawing_view', { sheetId, direction: 'back', label: 'REAR', paperPosition: [100, 100], scale: 5 });
    const view = added.document.drawings?.sheets[sheetId]?.views.find((v) => v.id === added.affected[0]);
    expect(view).toMatchObject({ kind: 'projection', direction: 'back', label: 'REAR', position: [100, 100], scale: 5 });
    expectPure(doc, () => execute(doc, 'create_drawing_view', { sheetId, direction: 'left' }));
    expectNoOp(execute(doc, 'create_drawing_view', { sheetId: 'x', direction: 'left' }), doc, "no sheet 'x'");
    expectNoOp(execute(doc, 'create_drawing_view', { sheetId, direction: 'left', entityIds: ['zz'] }), doc, "no entity 'zz'");
    const empty = run(doc, 'delete_entities', { ids: doc.order });
    expectNoOp(execute(empty, 'create_drawing_view', { sheetId, direction: 'left' }), empty, 'no 3D solids');
    const exported = exportSheet(added.document, sheetId);
    expect(exported.views.find((v) => v.label.startsWith('REAR'))?.scaleText).toBe('1:5');
    expect(exported.views.find((v) => v.label.startsWith('REAR'))?.bounds[0]).toBeCloseTo(100 - 10, 0);
  });

  it('lays out first- and third-angle views differently and moves colliding views below', () => {
    const { doc, sheetId } = sheetWithViews(boxDoc(), ['front', 'top', 'right', 'left', 'back', 'bottom', 'front']);
    const first = exportSheet(doc, sheetId);
    const third = exportSheet(run(doc, 'update_sheet', { sheetId, projectionAngle: 'third' }), sheetId);
    const centreY = (data: Exported, index: number): number => (data.views[index]!.bounds[1]! + data.views[index]!.bounds[3]!) / 2;
    const centreX = (data: Exported, index: number): number => (data.views[index]!.bounds[0]! + data.views[index]!.bounds[2]!) / 2;
    expect(centreY(first, 1)).toBeGreaterThan(centreY(first, 0));
    expect(centreY(third, 1)).toBeLessThan(centreY(third, 0));
    expect(centreX(first, 2)).toBeLessThan(centreX(first, 0));
    expect(centreX(third, 2)).toBeGreaterThan(centreX(third, 0));
    expect(centreY(first, 6)).toBeGreaterThan(centreY(first, 1));
  });
});

describe('add_section_view', () => {
  it('creates a hatched section with a cutting line on the parent', () => {
    const { doc, sheetId, viewIds } = sheetWithViews();
    const added = execute(doc, 'add_section_view', { sheetId, direction: 'right', offset: 0, parentViewId: viewIds[0] });
    const sectionId = added.affected[0] as string;
    expect(added.document.drawings?.sheets[sheetId]?.views.find((v) => v.id === sectionId)).toMatchObject({
      kind: 'section',
      label: 'SECTION A-A',
      mark: 'A',
      section: { offset: 0, parentViewId: viewIds[0] },
    });
    const data = exportSheet(added.document, sheetId);
    const group = data.svg.split(`<g id="view-${sectionId}"`)[1]?.split('</g>')[0] ?? '';
    expect(group).toContain('class="cut-hatch"');
    expect(group).not.toContain('class="hidden"');
    expect(data.svg).toContain('class="plane"');
    expect(data.svg).toContain('>A</text>');
    expect(data.views.find((v) => v.id === sectionId)?.label).toBe('SECTION A-A');
    const second = execute(added.document, 'add_section_view', { sheetId, direction: 'top', offset: 10 });
    expect(second.document.drawings?.sheets[sheetId]?.views.at(-1)?.label).toBe('SECTION B-B');
  });

  it('draws no cutting line on a parallel or iso parent and rejects bad parents', () => {
    const { doc, sheetId, viewIds } = sheetWithViews(boxDoc(), ['right', 'iso']);
    for (const parent of viewIds) {
      const added = execute(doc, 'add_section_view', { sheetId, direction: 'right', offset: 0, parentViewId: parent });
      expect(exportSheet(added.document, sheetId).svg).not.toContain('class="plane"');
    }
    expectPure(doc, () => execute(doc, 'add_section_view', { sheetId, direction: 'top', offset: 0 }));
    expectNoOp(
      execute(doc, 'add_section_view', { sheetId, direction: 'top', offset: 0, parentViewId: 'zz' }),
      doc,
      'is not a projection or section view',
    );
    expectNoOp(execute(doc, 'add_section_view', { sheetId: 'zz', direction: 'top', offset: 0 }), doc, "no sheet 'zz'");
    expectNoOp(execute(doc, 'add_section_view', { sheetId, direction: 'top', offset: 0, entityIds: ['q'] }), doc, "no entity 'q'");
    const empty = run(doc, 'delete_entities', { ids: doc.order });
    expectNoOp(execute(empty, 'add_section_view', { sheetId, direction: 'top', offset: 0 }), empty, 'no 3D solids');
    expect(execute(doc, 'add_section_view', { sheetId, direction: 'iso', offset: 0 }).summary).toContain('invalid params');
    const detail = run(doc, 'add_detail_view', { sheetId, parentViewId: viewIds[0], center: [0, 0], radius: 5 });
    const detailId = detail.drawings?.sheets[sheetId]?.views.at(-1)?.id as string;
    expectNoOp(
      execute(detail, 'add_section_view', { sheetId, direction: 'top', offset: 0, parentViewId: detailId }),
      detail,
      'is not a projection',
    );
  });

  it('section planes cut on the correct side for back/left/bottom directions', () => {
    const { doc, sheetId } = sheetWithViews(boxDoc(), ['front']);
    for (const direction of ['back', 'left', 'bottom'] as const) {
      const added = run(doc, 'add_section_view', { sheetId, direction, offset: 0 });
      const view = added.drawings?.sheets[sheetId]?.views.at(-1) as DrawingView;
      expect(exportSheet(added, sheetId).svg).toContain(`<g id="view-${view.id}"`);
      expect(exportSheet(added, sheetId).svg.split(`<g id="view-${view.id}"`)[1]).toContain('cut-hatch');
    }
  });
});

describe('add_detail_view', () => {
  it('magnifies a circle of the parent and clips to it', () => {
    const { doc, sheetId, viewIds } = sheetWithViews();
    const added = execute(doc, 'add_detail_view', { sheetId, parentViewId: viewIds[0], center: [50, 20], radius: 10, scale: 0.5 });
    const detailId = added.affected[0] as string;
    const data = exportSheet(added.document, sheetId);
    const info = data.views.find((v) => v.id === detailId);
    expect(info?.label).toBe('DETAIL A (2:1)');
    const diameter = (info?.bounds[2] ?? 0) - (info?.bounds[0] ?? 0);
    expect(diameter).toBeCloseTo(40, 1);
    expect(data.svg).toContain(`<clipPath id="clip-${detailId}">`);
    expect(data.svg).toContain(`clip-path="url(#clip-${detailId})"`);
    expect(visibleLines(data.svg, detailId)).toBeGreaterThan(0);
    expect(data.svg).toContain('>A</text>');
  });

  it('defaults to 2x the sheet scale, follows the parent and rejects bad parents', () => {
    const { doc, sheetId, viewIds } = sheetWithViews();
    expectPure(doc, () => execute(doc, 'add_detail_view', { sheetId, parentViewId: viewIds[0], center: [0, 0], radius: 5 }));
    const added = execute(doc, 'add_detail_view', { sheetId, parentViewId: viewIds[0], center: [0, 0], radius: 5 });
    const data = exportSheet(added.document, sheetId);
    expect(data.views.at(-1)?.scale).toBe(data.scale / 2);
    expect(data.skipped).toEqual([]);
    expect(visibleLines(data.svg, added.affected[0] as string)).toBe(0);
    expectNoOp(
      execute(doc, 'add_detail_view', { sheetId, parentViewId: 'zz', center: [0, 0], radius: 5 }),
      doc,
      'is not a projection or section view',
    );
    expectNoOp(
      execute(doc, 'add_detail_view', { sheetId: 'zz', parentViewId: viewIds[0], center: [0, 0], radius: 5 }),
      doc,
      "no sheet 'zz'",
    );
    const nested = added.document.drawings?.sheets[sheetId]?.views.at(-1)?.id as string;
    expectNoOp(
      execute(added.document, 'add_detail_view', { sheetId, parentViewId: nested, center: [0, 0], radius: 5 }),
      added.document,
      'is not a projection',
    );
  });

  it('skips a detail whose parent no longer exists (hand-edited sheet)', () => {
    const { doc, sheetId, viewIds } = sheetWithViews();
    const withDetail = run(doc, 'add_detail_view', { sheetId, parentViewId: viewIds[0], center: [0, 0], radius: 5 });
    const sheet = withDetail.drawings!.sheets[sheetId]!;
    const orphan: CadDocument = {
      ...withDetail,
      drawings: { ...withDetail.drawings!, sheets: { [sheetId]: { ...sheet, views: sheet.views.filter((v) => v.id !== viewIds[0]) } } },
    };
    expect(exportSheet(orphan, sheetId).skipped[0]?.reason).toContain('parent');
  });
});

describe('editing views and sheets', () => {
  it('update_drawing_view patches fields by kind and rejects invalid ones', () => {
    const { doc, sheetId, viewIds } = sheetWithViews();
    const viewId = viewIds[0] as string;
    const patched = execute(doc, 'update_drawing_view', {
      sheetId,
      viewId,
      label: 'MAIN',
      direction: 'back',
      paperPosition: [90, 90],
      scale: 2,
    });
    expect(patched.affected).toEqual([viewId]);
    const view = (d: CadDocument, id: string): DrawingView => d.drawings!.sheets[sheetId]!.views.find((v) => v.id === id)!;
    expect(view(patched.document, viewId)).toMatchObject({
      label: 'MAIN',
      direction: 'back',
      position: [90, 90],
      scale: 2,
      id: viewId,
      kind: 'projection',
    });
    const reset = run(patched.document, 'update_drawing_view', { sheetId, viewId, autoPosition: true, autoScale: true });
    expect(view(reset, viewId).position).toBeUndefined();
    expect(view(reset, viewId).scale).toBeUndefined();
    expectPure(doc, () => execute(doc, 'update_drawing_view', { sheetId, viewId, label: 'X' }));
    expectNoOp(execute(doc, 'update_drawing_view', { sheetId, viewId, label: 'FRONT' }), doc, 'already has');
    expectNoOp(execute(doc, 'update_drawing_view', { sheetId, viewId }), doc, 'already has');
    expectNoOp(execute(doc, 'update_drawing_view', { sheetId, viewId: 'zz', label: 'A' }), doc, "no view 'zz'");
    expectNoOp(execute(doc, 'update_drawing_view', { sheetId: 'zz', viewId, label: 'A' }), doc, "no sheet 'zz'");
    expectNoOp(execute(doc, 'update_drawing_view', { sheetId, viewId, offset: 1 }), doc, 'only applies to section');
    expectNoOp(execute(doc, 'update_drawing_view', { sheetId, viewId, radius: 1 }), doc, 'only apply to detail');
    expectNoOp(execute(doc, 'update_drawing_view', { sheetId, viewId, entityIds: ['zz'] }), doc, "no entity 'zz'");

    const section = run(doc, 'add_section_view', { sheetId, direction: 'right', offset: 0, parentViewId: viewId });
    const sectionId = section.drawings!.sheets[sheetId]!.views.at(-1)!.id;
    expect(view(run(section, 'update_drawing_view', { sheetId, viewId: sectionId, offset: 12 }), sectionId).section?.offset).toBe(12);
    expectNoOp(execute(section, 'update_drawing_view', { sheetId, viewId: sectionId, direction: 'iso' }), section, 'cannot be iso');
    const detail = run(doc, 'add_detail_view', { sheetId, parentViewId: viewId, center: [0, 0], radius: 5 });
    const detailId = detail.drawings!.sheets[sheetId]!.views.at(-1)!.id;
    expect(view(run(detail, 'update_drawing_view', { sheetId, viewId: detailId, radius: 8 }), detailId).detail).toMatchObject({
      radius: 8,
      center: [0, 0],
    });
    expect(view(run(detail, 'update_drawing_view', { sheetId, viewId: detailId, center: [3, 4] }), detailId).detail).toMatchObject({
      radius: 5,
      center: [3, 4],
    });
    expectNoOp(execute(detail, 'update_drawing_view', { sheetId, viewId: detailId, direction: 'top' }), detail, 'no direction');
  });

  it('delete_drawing_view cascades to details and detaches section parents', () => {
    const { doc, sheetId, viewIds } = sheetWithViews();
    let next = run(doc, 'add_detail_view', { sheetId, parentViewId: viewIds[0], center: [0, 0], radius: 5 });
    next = run(next, 'add_section_view', { sheetId, direction: 'right', offset: 0, parentViewId: viewIds[0] });
    const views = next.drawings!.sheets[sheetId]!.views;
    const [detailId, sectionId] = [views[3]!.id, views[4]!.id];
    const result = execute(next, 'delete_drawing_view', { sheetId, viewId: viewIds[0] as string });
    expect(result.affected).toEqual([viewIds[0], detailId]);
    const left = result.document.drawings!.sheets[sheetId]!.views;
    expect(left.map((v) => v.id)).toEqual([viewIds[1], viewIds[2], sectionId]);
    expect(left[2]!.section).toEqual({ offset: 0 });
    const keepParent = run(next, 'delete_drawing_view', { sheetId, viewId: viewIds[1] as string });
    expect(keepParent.drawings!.sheets[sheetId]!.views.at(-1)!.section!.parentViewId).toBe(viewIds[0]);
    expectPure(next, () => execute(next, 'delete_drawing_view', { sheetId, viewId: viewIds[0] as string }));
    expectNoOp(execute(next, 'delete_drawing_view', { sheetId, viewId: 'zz' }), next, "no view 'zz'");
    expectNoOp(execute(next, 'delete_drawing_view', { sheetId: 'zz', viewId: 'a' }), next, "no sheet 'zz'");
  });

  it('update_sheet patches fields and delete_sheet removes the sheet', () => {
    const { doc, sheetId } = sheetWithViews();
    const updated = execute(doc, 'update_sheet', {
      sheetId,
      name: 'Renamed',
      paper: 'A2',
      scale: 5,
      projectionAngle: 'third',
      title: 'T',
      drawnBy: 'me',
      partNumber: 'P1',
      revision: 'B',
      date: 'd',
    });
    const sheet = updated.document.drawings!.sheets[sheetId]!;
    expect(sheet).toMatchObject({
      name: 'Renamed',
      paper: 'A2',
      scale: 5,
      projectionAngle: 'third',
      titleBlock: { title: 'T', drawnBy: 'me', partNumber: 'P1', revision: 'B', date: 'd' },
    });
    expect(sheet.views).toHaveLength(3);
    expect(run(updated.document, 'update_sheet', { sheetId, autoScale: true }).drawings!.sheets[sheetId]!.scale).toBeUndefined();
    expect(run(updated.document, 'update_sheet', { sheetId, title: 'only' }).drawings!.sheets[sheetId]!.scale).toBe(5);
    const svg = exportSheet(updated.document, sheetId).svg;
    expect(svg).toContain('THIRD ANGLE');
    expect(svg).toContain('width="594mm"');
    expectPure(doc, () => execute(doc, 'update_sheet', { sheetId, name: 'x' }));
    expectNoOp(execute(doc, 'update_sheet', { sheetId }), doc, 'give at least one field');
    expectNoOp(execute(doc, 'update_sheet', { sheetId: 'zz', name: 'a' }), doc, "no sheet 'zz'");

    const deleted = execute(doc, 'delete_sheet', { sheetId });
    expect(deleted.affected).toEqual([sheetId]);
    expect(deleted.document.drawings).toEqual({ sheets: {}, order: [] });
    expect(deleted.document.order).toEqual(doc.order);
    expectPure(doc, () => execute(doc, 'delete_sheet', { sheetId }));
    expectNoOp(execute(doc, 'delete_sheet', { sheetId: 'zz' }), doc, "no sheet 'zz'");
    const empty = createEmptyDocument();
    expectNoOp(execute(empty, 'delete_sheet', { sheetId: 'a' }), empty, 'none — call create_sheet');
  });

  it('clear_document drops the sheets', () => {
    const { doc } = sheetWithViews();
    expect(run(doc, 'clear_document', {}).drawings).toBeUndefined();
  });
});

describe('persistence, replay and validation', () => {
  const full = (): { doc: CadDocument; sheetId: string } => {
    const { doc, sheetId, viewIds } = sheetWithViews();
    let next = run(doc, 'add_section_view', { sheetId, direction: 'right', offset: 0, parentViewId: viewIds[0] });
    next = run(next, 'add_detail_view', {
      sheetId,
      parentViewId: viewIds[0],
      center: [0, 0],
      radius: 5,
      paperPosition: [300, 200],
      scale: 1,
    });
    return { doc: next, sheetId };
  };

  it('round-trips sheets through save and load, byte-equal export', () => {
    const { doc, sheetId } = full();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.drawings).toEqual(doc.drawings);
    expect(serializeDocument(loaded)).toBe(serializeDocument(doc));
    expect(exportSheet(loaded, sheetId).svg).toBe(exportSheet(doc, sheetId).svg);
    expect(deserializeDocument(serializeDocument(boxDoc())).drawings).toBeUndefined();
  });

  it('replay_history reproduces the same sheet ids and recipe', () => {
    const { doc } = full();
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(replayed.drawings).toEqual(doc.drawings);
  });

  const withDrawings = (doc: CadDocument, mutate: (drawings: Record<string, unknown>) => void): string => {
    const raw = JSON.parse(serializeDocument(doc)) as { document: { drawings: Record<string, unknown> } };
    mutate(raw.document.drawings);
    return JSON.stringify(raw);
  };
  const sheetOf = (drawings: Record<string, unknown>, id: string): Record<string, unknown> =>
    (drawings['sheets'] as Record<string, Record<string, unknown>>)[id] as Record<string, unknown>;

  it('rejects malformed drawings in an untrusted document', () => {
    const { doc, sheetId } = full();
    const viewsOf = (drawings: Record<string, unknown>): Array<Record<string, unknown>> =>
      sheetOf(drawings, sheetId)['views'] as Array<Record<string, unknown>>;
    const cases: Array<[string, (d: Record<string, unknown>) => void]> = [
      [
        'drawings must be',
        (d) => {
          d['sheets'] = 5;
        },
      ],
      [
        'does not match sheet.id',
        (d) => {
          sheetOf(d, sheetId)['id'] = 'other';
        },
      ],
      [
        'name must be a string',
        (d) => {
          sheetOf(d, sheetId)['name'] = 4;
        },
      ],
      [
        'paper must be',
        (d) => {
          sheetOf(d, sheetId)['paper'] = 'A9';
        },
      ],
      [
        'projectionAngle',
        (d) => {
          sheetOf(d, sheetId)['projectionAngle'] = 'second';
        },
      ],
      [
        'scale must be a positive',
        (d) => {
          sheetOf(d, sheetId)['scale'] = -1;
        },
      ],
      [
        'titleBlock needs',
        (d) => {
          sheetOf(d, sheetId)['titleBlock'] = { title: 1 };
        },
      ],
      [
        'views must be an array',
        (d) => {
          sheetOf(d, sheetId)['views'] = {};
        },
      ],
      [
        'duplicate view ids',
        (d) => {
          viewsOf(d)[1]!['id'] = viewsOf(d)[0]!['id'];
        },
      ],
      [
        'is not an object',
        (d) => {
          viewsOf(d)[0] = 5 as unknown as Record<string, unknown>;
        },
      ],
      [
        'id and label',
        (d) => {
          viewsOf(d)[0]!['label'] = 1;
        },
      ],
      [
        'kind must be',
        (d) => {
          viewsOf(d)[0]!['kind'] = 'x';
        },
      ],
      [
        'direction must be',
        (d) => {
          viewsOf(d)[0]!['direction'] = 'up';
        },
      ],
      [
        'entityIds must be',
        (d) => {
          viewsOf(d)[0]!['entityIds'] = [1];
        },
      ],
      [
        'position must be',
        (d) => {
          viewsOf(d)[0]!['position'] = [1];
        },
      ],
      [
        'scale must be a positive',
        (d) => {
          viewsOf(d)[0]!['scale'] = 0;
        },
      ],
      [
        'mark must be',
        (d) => {
          viewsOf(d)[0]!['mark'] = 1;
        },
      ],
      [
        'needs section.offset',
        (d) => {
          viewsOf(d)[3]!['section'] = {};
        },
      ],
      [
        'section.parentViewId',
        (d) => {
          viewsOf(d)[3]!['section'] = { offset: 0, parentViewId: 'nope' };
        },
      ],
      [
        'needs detail.center',
        (d) => {
          viewsOf(d)[4]!['detail'] = { parentViewId: 'x' };
        },
      ],
      [
        'detail.parentViewId',
        (d) => {
          viewsOf(d)[4]!['detail'] = { parentViewId: 'nope', center: [0, 0], radius: 1 };
        },
      ],
      [
        'does not reference a known sheet',
        (d) => {
          (d['order'] as string[]).push('ghost');
        },
      ],
      [
        'missing sheet',
        (d) => {
          d['order'] = [];
        },
      ],
      [
        'duplicate sheet ids',
        (d) => {
          (d['order'] as string[]).push(sheetId);
        },
      ],
      [
        'reserved',
        (d) => {
          (d['sheets'] as Record<string, unknown>)['__proto__'] = {};
          Object.defineProperty(d['sheets'], 'constructor', { value: {}, enumerable: true });
        },
      ],
    ];
    for (const [expected, mutate] of cases) {
      const json = withDrawings(doc, mutate);
      expect(() => deserializeDocument(json), expected).toThrow(expected);
    }
    expect(
      execute(createEmptyDocument(), 'load_document', {
        json: withDrawings(doc, (d) => {
          d['sheets'] = 1;
        }),
      }).affected,
    ).toEqual([]);
  });
});

describe('helpers', () => {
  it('formats scales and picks unused marks (skipping I, O, Q)', () => {
    expect([scaleText(50), scaleText(1), scaleText(0.5), scaleText(2.5), scaleText(0.2)]).toEqual(['1:50', '1:1', '2:1', '1:2.5', '5:1']);
    const views = Array.from({ length: 30 }, (_, i): DrawingView => ({ id: `v${i}`, label: 'x', kind: 'detail', mark: nextMarkAt(i) }));
    const marks = new Set(views.map((v) => v.mark));
    expect(marks.size).toBe(30);
    expect(nextMark({ id: 's', name: 's', paper: 'A4', titleBlock: { title: '' }, projectionAngle: 'first', views })).toBe('H1');
    expect(n(-0.0001)).toBe('0');
    expect(n(1.2345)).toBe('1.23');
  });

  it('paints every primitive kind', () => {
    const painter = new SheetPainter((p) => [p[0] * 2, -p[1] * 2], 2);
    const base = { layer: 'L' } as const;
    painter.paint({
      ...base,
      type: 'polygon',
      style: 'cut',
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      fill: 'hatch',
      holes: [
        [
          [0.2, 0.1],
          [0.5, 0.1],
          [0.5, 0.4],
        ],
      ],
    });
    painter.paint({
      ...base,
      type: 'polygon',
      style: 'cut',
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      fill: 'solid',
    });
    painter.paint({
      ...base,
      type: 'polygon',
      style: 'visible',
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    });
    painter.paint({
      ...base,
      type: 'polyline',
      style: 'thin',
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    painter.paint({ ...base, type: 'line', style: 'hidden', a: [0, 0], b: [1, 1] });
    painter.paint({ ...base, type: 'line', style: 'center', a: [0, 0], b: [1, 1] });
    painter.paint({ ...base, type: 'line', style: 'annotation', a: [0, 0], b: [1, 1] });
    painter.paint({ ...base, type: 'circle', style: 'visible', center: [0, 0], radius: 1 });
    painter.paint({ ...base, type: 'circle', style: 'cut', center: [0, 0], radius: 1, fill: 'solid' });
    painter.paint({ ...base, type: 'arc', style: 'visible', center: [0, 0], radius: 1, startAngle: 0, endAngle: 1 });
    painter.paint({ ...base, type: 'arc', style: 'visible', center: [0, 0], radius: 1, startAngle: 0, endAngle: 5 });
    painter.paint({ ...base, type: 'text', style: 'annotation', at: [0, 0], height: 1, content: 'a<b' });
    painter.paint({ ...base, type: 'dimension', style: 'annotation', a: [0, 0], b: [10, 0], offset: 1, label: '10' });
    const out = painter.parts.join('');
    expect(out).toContain('class="cut-hatch"');
    expect(out).toContain('class="cut"');
    expect(out).toContain('a&lt;b');
    expect(out).toContain(' A 2 2 0 1 1 ');
    expect(out).toContain('class="dim"');
    expect(paperDimension([0, 0], [0, 0], 5, 'x')).toEqual([]);
    expect(paperDimension([0, 0], [0, 10], -5, 'v').join('')).toContain('rotate');
  });

  it('layouts keep fixed positions and place only extras when the grid is empty', () => {
    const view = (id: string, extra: Partial<DrawingView>): DrawingView => ({ id, label: id, kind: 'section', direction: 'top', ...extra });
    const options = { angle: 'first', area: { x: 0, y: 0, width: 400, height: 200 }, mmPerUnit: 1, scale: undefined, margin: 4 } as const;
    const layout = layoutViews(
      [
        { view: view('a', { position: [10, 20] }), size: [10, 10] },
        { view: view('b', {}), size: [20, 10] },
        { view: view('c', {}), size: [20, 10] },
      ],
      options,
    );
    expect(layout.placed[0]!.center).toEqual([10, 20]);
    expect(layout.placed[1]!.center[0]).toBeLessThan(layout.placed[2]!.center[0]);
    expect(layout.scale).toBe(0.2);
    expect(layoutViews([], options).placed).toEqual([]);
  });
});

const nextMarkAt = (index: number): string => {
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  return index < letters.length ? (letters[index] as string) : `${letters[index - letters.length]}1`;
};
