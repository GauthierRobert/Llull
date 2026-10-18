import { describe, expect, it } from 'vitest';
import { layoutViews, type LayoutItem, type PlacedView } from '@core/commands/drawings/layout';
import type { DrawingView } from '@core/model/sheet';
import { fitPaperOrientation } from '@aec/shared/sheetFrame';
import type { PlanSheet } from '@aec/building/drawings/sheet';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { run } from '../helpers/runFixtures';
import { xy } from '../helpers/xy';

const projection = (direction: 'front' | 'top' | 'right' | 'iso'): DrawingView => ({
  id: direction,
  label: direction,
  kind: 'projection',
  direction,
});
const section: DrawingView = { id: 'sec', label: 'SECTION A-A', kind: 'section', direction: 'right' };

/** A3 drawing area (382 x 227 mm), no dimensions: the 200 mm housing repro. */
const options = { angle: 'first', area: { x: 24, y: 14, width: 382, height: 227 }, mmPerUnit: 1, scale: undefined, margin: 4 } as const;

describe('drawing sheet auto-scale', () => {
  const items: LayoutItem[] = [
    { view: projection('front'), size: [200, 91] },
    { view: projection('top'), size: [200, 170] },
    { view: projection('right'), size: [170, 91] },
    { view: projection('iso'), size: [255, 202] },
    { view: section, size: [170, 91] },
  ];

  it('puts an extra view into a free grid cell instead of a row below, so the scale stays large', () => {
    const layout = layoutViews(items, options);
    expect(layout.scale).toBe(2);
    const front = layout.placed.find((placed) => placed.view.id === 'front')!;
    const extra = layout.placed.find((placed) => placed.view.id === 'sec')!;
    expect(extra.center[1]).toBeCloseTo(front.center[1], 5);
    expect(extra.center[0]).toBeGreaterThan(front.center[0]);
  });

  it('never overlaps boxes and stays inside the area', () => {
    const { placed } = layoutViews(items, options);
    for (const a of placed) {
      expect(a.center[0] - a.width / 2).toBeGreaterThanOrEqual(options.area.x);
      expect(a.center[0] + a.width / 2).toBeLessThanOrEqual(options.area.x + options.area.width);
      expect(a.center[1] - a.height / 2).toBeGreaterThanOrEqual(options.area.y);
      expect(a.center[1] + a.height / 2).toBeLessThanOrEqual(options.area.y + options.area.height);
      for (const b of placed.filter((other) => other !== a)) {
        const apart =
          Math.abs(a.center[0] - b.center[0]) >= (a.width + b.width) / 2 ||
          Math.abs(a.center[1] - b.center[1]) >= (a.height + b.height) / 2;
        expect(apart, `${a.view.id} vs ${b.view.id}`).toBe(true);
      }
    }
  });

  it('includes 1:2.5 between 1:2 and 1:5', () => {
    const one = (size: number): number => layoutViews([{ view: projection('front'), size: [size, 50] }], options).scale;
    expect(one(700)).toBe(2);
    expect(one(800)).toBe(2.5);
    expect(one(930)).toBe(2.5);
    expect(one(1000)).toBe(5);
  });
});

describe('plan sheet paper orientation', () => {
  it('turns the paper portrait when a tall plan then reaches a larger scale (hall 34.7 x 64.8 m on A3: 1:250 not 1:500)', () => {
    expect(fitPaperOrientation('A3', 34_700, 64_800)).toEqual({ orientation: 'portrait', width: 297, height: 420, scale: 250 });
  });
  it('keeps landscape for wide plans and on a tie', () => {
    expect(fitPaperOrientation('A3', 64_800, 34_700)).toMatchObject({ orientation: 'landscape', width: 420, height: 297, scale: 200 });
    expect(fitPaperOrientation('A3', 10_000, 10_000)).toMatchObject({ orientation: 'landscape' });
  });
});

describe('export_plan_sheet orientation', () => {
  const hall = (width: number, depth: number): CadDocument => {
    let doc = run(createEmptyDocument(), 'add_level', { name: 'Ground' });
    doc = run(doc, 'draw_walls', { points: xy(0, 0, width, 0, width, depth, 0, depth), closed: true });
    return doc;
  };
  it('auto-fits a tall plan on a portrait sheet at a larger scale and reports the orientation', () => {
    const result = execute(hall(30_000, 65_000), 'export_plan_sheet', {});
    const sheet = result.data as PlanSheet;
    expect(sheet).toMatchObject({ orientation: 'portrait', scale: 250 });
    expect(sheet.svg).toContain('width="297mm" height="420mm"');
    expect(sheet.fits).toBe(true);
    expect(result.summary).toContain('A3 portrait');
  });
  it('stays landscape for a wide plan or an explicit scale', () => {
    expect((execute(hall(65_000, 30_000), 'export_plan_sheet', {}).data as PlanSheet).orientation).toBe('landscape');
    const fixed = execute(hall(30_000, 65_000), 'export_plan_sheet', { scale: 500 }).data as PlanSheet;
    expect(fixed).toMatchObject({ orientation: 'landscape', scale: 500 });
    expect(fixed.svg).toContain('width="420mm" height="297mm"');
  });
});

describe('sheet layout: section beside its parent, floating isometric', () => {
  const sectionOf = (parentViewId: string): DrawingView => ({ ...section, section: { offset: 0, parentViewId } });

  it('puts a section to the right of its parent when there is no free grid slot', () => {
    const items: LayoutItem[] = [
      { view: projection('front'), size: [90, 100] },
      { view: sectionOf('front'), size: [90, 100] },
    ];
    const { placed } = layoutViews(items, options);
    const [front, extra] = [placed[0]!, placed[1]!];
    expect(extra.center[1]).toBeCloseTo(front.center[1], 5);
    expect(extra.center[0]).toBeGreaterThan(front.center[0] + front.width / 2);
  });

  it('keeps the section below when beside would overflow the paper', () => {
    const items: LayoutItem[] = [
      { view: projection('front'), size: [300, 100] },
      { view: sectionOf('front'), size: [300, 100] },
    ];
    const { placed } = layoutViews(items, { ...options, scale: 1 });
    expect(placed[1]!.center[1]).toBeGreaterThan(placed[0]!.center[1]);
    expect(placed[1]!.center[0]).toBeCloseTo(placed[0]!.center[0], 5);
  });

  const tall: LayoutItem[] = [
    { view: projection('front'), size: [90, 560] },
    { view: projection('top'), size: [99, 99] },
    { view: projection('iso'), size: [127, 495] },
    { view: sectionOf('front'), size: [90, 560] },
  ];

  it('auto-scale lets the isometric view float beside the front row: 555 mm part on A3 gets 1:5, not 1:10', () => {
    const layout = layoutViews(tall, options);
    expect(layout.scale).toBe(5);
    const [front, , iso, extra] = layout.placed as [PlacedView, PlacedView, PlacedView, PlacedView];
    expect(iso.center[1]).toBeCloseTo(front.center[1], 0);
    expect(extra.center[1]).toBeCloseTo(front.center[1], 5);
    for (const view of layout.placed) {
      expect(view.center[1] - view.height / 2).toBeGreaterThanOrEqual(options.area.y);
      expect(view.center[1] + view.height / 2).toBeLessThanOrEqual(options.area.y + options.area.height);
    }
    expect(layoutViews(tall, { ...options, scale: 2.5 }).scale).toBe(2.5);
  });

  it('a fixed scale that only fits with the floating isometric view uses it', () => {
    const { placed } = layoutViews(tall, { ...options, scale: 5 });
    for (const view of placed) expect(view.center[1] + view.height / 2).toBeLessThanOrEqual(options.area.y + options.area.height);
  });
});
