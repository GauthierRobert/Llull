import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { exportAnchorPlan as anchorPlan } from '@aec/industrial/anchorPlan';

interface AnchorData {
  svg: string;
  filename: string;
  boltCount: number;
  plates: number;
  scale: number;
  levelId: string;
}

function hall(units?: 'm'): CadDocument {
  const base = createEmptyDocument();
  const doc = units ? { ...base, units } : base;
  const params = units ? { span: 24, length: 30 } : { span: 24000, length: 30000 };
  const result = execute(doc, 'add_portal_frame_building', params);
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return result.document;
}

const texts = (svg: string): string[] =>
  [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((match) => match[1] as string);

describe('export_anchor_plan', () => {
  it('draws every bolt and lists every plate in the schedule', () => {
    const doc = hall();
    const before = JSON.stringify(doc);
    const result = anchorPlan.run(doc, {});
    const data = result.data as AnchorData;
    const building = doc.building;
    const plates = Object.values(building?.elements ?? {}).filter((e) => e.category === 'plate');
    const bolts = plates.reduce(
      (sum, plate) => sum + (plate.category === 'plate' ? plate.boltCount : 0),
      0,
    );
    expect(plates.length).toBeGreaterThan(0);
    expect(data.plates).toBe(plates.length);
    expect(data.boltCount).toBe(bolts);
    expect(data.svg.match(/<circle /g)?.length).toBe(bolts);
    expect(data.svg).toContain('Anchor bolt setting-out plan');
    expect(data.filename).toMatch(/anchor-plan_A3_1-\d+\.svg$/);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.summary).toContain(`${bolts} anchor bolt(s)`);
    expect(result.summary).toContain(`${plates.length} base plate(s)`);
  });

  it('gives schedule rows grid refs and dimensions the grid spacing', () => {
    const data = anchorPlan.run(hall(), {}).data as AnchorData;
    const all = texts(data.svg);
    expect(all.some((text) => /^[A-Z]\/\d+$/.test(text))).toBe(true);
    expect(all).toContain('A/1');
    expect(all).toContain('4xM24');
    expect(all).toContain('300');
    expect(all).toContain('Anchor bolt schedule (mm)');
    expect(all.some((text) => /^\+?-?\d\.\d{3}$|TOC [+-]\d/.test(text))).toBe(true);
    const grids = Object.values(hall().building?.elements ?? {}).filter(
      (e) => e.category === 'grid',
    );
    expect(grids.length).toBeGreaterThan(2);
    // Typical frame bay (e.g. 6000) appears as a running dimension.
    expect(all.filter((text) => /^\d{4,5}$/.test(text)).length).toBeGreaterThan(2);
  });

  it('honours embedment, scale, paper and level params', () => {
    const doc = hall();
    const levelId = doc.building?.levelOrder[0] ?? '';
    const data = anchorPlan.run(doc, { levelId, scale: 200, paper: 'A2', embedment: 450 })
      .data as AnchorData;
    expect(data.scale).toBe(200);
    expect(data.levelId).toBe(levelId);
    expect(data.filename).toContain('A2_1-200');
    expect(texts(data.svg)).toContain('450');
  });

  it('gives the same bolts and dimensions in metre documents', () => {
    const mm = anchorPlan.run(hall(), { scale: 100, paper: 'A1' }).data as AnchorData;
    const metre = anchorPlan.run(hall('m'), { scale: 100, paper: 'A1' }).data as AnchorData;
    expect(metre.boltCount).toBe(mm.boltCount);
    expect(metre.plates).toBe(mm.plates);
    const numeric = (svg: string): string[] => texts(svg).filter((t) => /^\d+$/.test(t));
    expect(numeric(metre.svg)).toEqual(numeric(mm.svg));
  });

  it('truncates the schedule when plates exceed the sheet and handles plates without footings', () => {
    const doc = hall();
    const building = doc.building;
    if (!building) throw new Error('no building');
    const elements = { ...building.elements };
    const order = building.elementOrder.filter((id) => elements[id]?.category !== 'footing');
    for (const id of Object.keys(elements)) {
      if (elements[id]?.category === 'footing' || elements[id]?.category === 'grid')
        delete elements[id];
    }
    const bare = { ...doc, building: { ...building, elements, elementOrder: order } };
    const result = anchorPlan.run(bare, { paper: 'A4' });
    const data = result.data as AnchorData;
    expect(data.boltCount).toBeGreaterThan(0);
    expect(texts(data.svg).some((text) => text.startsWith('A/') || text.startsWith('-/'))).toBe(
      true,
    );
    const many = { ...bare, building: { ...bare.building, elements: { ...elements } } };
    const plateIds = order.filter((id) => elements[id]?.category === 'plate');
    const first = elements[plateIds[0] as string];
    if (first?.category !== 'plate') throw new Error('no plate');
    for (let index = 0; index < 60; index++) {
      const id = `plate-extra-${index}`;
      many.building.elements[id] = { ...first, id, mark: `BPX${index}` };
      many.building.elementOrder = [...many.building.elementOrder, id];
    }
    const big = anchorPlan.run(many as CadDocument, { paper: 'A4' });
    expect(texts((big.data as AnchorData).svg).some((text) => text.includes('not shown'))).toBe(
      true,
    );
  });

  it('signs the grid offset of off-grid plates in the schedule and labels', () => {
    const data = anchorPlan.run(hall(), {}).data as AnchorData;
    const all = texts(data.svg);
    const offGrid = all.filter((text) => /^[A-Z]+[+-]\d+\/\d+$/.test(text));
    expect(offGrid.length).toBeGreaterThan(0);
    expect(offGrid.some((text) => /^[A-Z][+-]6000\//.test(text))).toBe(true);
    expect(all.some((text) => /^BP\d+ [A-Z]+[+-]\d+\/\d+$/.test(text))).toBe(true);
    expect(all).toContain('A/1');
  });

  it('places grid dimensions outside the plate labels', () => {
    const data = anchorPlan.run(hall(), {}).data as AnchorData;
    const group = (id: string): string =>
      new RegExp(`<g id="${id}">([\\s\\S]*?)</g>`).exec(data.svg)?.[1] ?? '';
    const labelYs = [...group('plate-labels').matchAll(/<text [^>]*y="([\d.-]+)"/g)].map((m) =>
      Number(m[1]),
    );
    const dimYs = [
      ...group('grid-dimensions').matchAll(
        /<line [^>]*y1="([\d.-]+)"[^>]*y2="([\d.-]+)" class="dim"/g,
      ),
    ].flatMap((m) => [Number(m[1]), Number(m[2])]);
    expect(labelYs.length).toBeGreaterThan(0);
    expect(dimYs.length).toBeGreaterThan(0);
    const horizontalRuns = [
      ...group('grid-dimensions').matchAll(
        /<line [^>]*y1="([\d.-]+)"[^>]*y2="([\d.-]+)" class="dim"/g,
      ),
    ].filter((m) => m[1] === m[2]);
    expect(horizontalRuns.length).toBeGreaterThan(0);
    const top = Math.min(...labelYs) - 2;
    expect(Math.min(...horizontalRuns.map((run) => Number(run[1])))).toBeLessThanOrEqual(top - 8);
  });

  it('still dimensions the bolt spacing for an odd bolt count', () => {
    const doc = hall();
    const building = doc.building;
    if (!building) throw new Error('no building');
    const elements = { ...building.elements };
    for (const [id, element] of Object.entries(elements)) {
      if (element.category === 'plate') elements[id] = { ...element, boltCount: 5 };
    }
    const odd = { ...doc, building: { ...building, elements } };
    const withOdd = anchorPlan.run(odd, {}).data as AnchorData;
    const dims = (svg: string): number => svg.match(/class="dim"/g)?.length ?? 0;
    const baseline = anchorPlan.run(hall(), {}).data as AnchorData;
    expect(dims(withOdd.svg)).toBe(dims(baseline.svg));
    expect(withOdd.boltCount).toBe(withOdd.svg.match(/<circle /g)?.length);
  });

  it('is a graceful no-op without plates', () => {
    const doc = createEmptyDocument();
    const result = anchorPlan.run(doc, {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.data).toBeUndefined();
    expect(result.summary).toContain('failed');
  });

  it('rejects bad params', () => {
    const doc = hall();
    for (const params of [
      { paper: 'B5' as never },
      { scale: 0 },
      { scale: Number.NaN },
      { embedment: -1 },
      { levelId: 'level-99' },
    ]) {
      const result = execute(doc, 'export_anchor_plan', params);
      expect(result.document, JSON.stringify(params)).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.summary).toMatch(/failed|rejected/);
    }
  });

  it('is registered as a read-only tool', () => {
    expect(anchorPlan.name).toBe('export_anchor_plan');
    expect(anchorPlan.annotations?.readOnly).toBe(true);
  });
});
