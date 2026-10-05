import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { buildPlanDrawing } from '@aec/planDrawing';
import type { PlanPrimitive } from '@aec/planModel';
import type { DxfExport } from '@aec/dxfExport';
import type { PlanSheet } from '@aec/sheet';
import { step, twoLevels } from './steelFixtures';

/** DN100 pipe along X at y = 2000 with one support of every type (all unattached: no steel). */
function plantWithSupports(): CadDocument {
  let doc = step(twoLevels(), 'add_pipe_run', {
    levelId: 'level-1',
    dn: 100,
    line: 'L-1',
    points: [
      [0, 2000, 3000],
      [6000, 2000, 3000],
    ],
  });
  const types = ['shoe', 'hanger', 'guide', 'anchor'] as const;
  types.forEach((type, index) => {
    doc = step(doc, 'add_pipe_support', {
      pipeId: 'pipe-1',
      type,
      at: [[1000 + index * 1500, 2000, 3000]],
    });
  });
  return doc;
}

const supportPrimitives = (doc: CadDocument, levelId = 'level-1'): PlanPrimitive[] =>
  (buildPlanDrawing(doc, levelId)?.primitives ?? []).filter((p) => p.layer === 'P-SUPP');

/** Primitives of one symbol: those whose points lie within 600 mm of the support x. */
const near = (primitives: PlanPrimitive[], x: number): PlanPrimitive[] =>
  primitives.filter((primitive) => {
    const xs =
      primitive.type === 'polygon'
        ? primitive.points.map((p) => p[0])
        : primitive.type === 'line'
          ? [primitive.a[0], primitive.b[0]]
          : primitive.type === 'circle'
            ? [primitive.center[0]]
            : primitive.type === 'text'
              ? [primitive.at[0] - 240]
              : [];
    return xs.every((value) => Math.abs(value - x) < 600);
  });

describe('pipe support plan symbols', () => {
  const primitives = supportPrimitives(plantWithSupports());

  it('draws a filled square for a shoe, with its mark beside it', () => {
    const shoe = near(primitives, 1000);
    const polygon = shoe.find((p) => p.type === 'polygon');
    expect(polygon).toMatchObject({ style: 'cut', fill: 'solid' });
    const xs = polygon?.type === 'polygon' ? polygon.points.map((p) => p[0]) : [];
    const ys = polygon?.type === 'polygon' ? polygon.points.map((p) => p[1]) : [];
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([850, 1150]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([1850, 2150]);
    expect(shoe.find((p) => p.type === 'text')).toMatchObject({
      content: 'PS1',
      style: 'annotation',
      at: [1240, 2240],
    });
  });

  it('draws a circle with a cross for a hanger', () => {
    const hanger = near(primitives, 2500);
    expect(hanger.find((p) => p.type === 'circle')).toMatchObject({
      center: [2500, 2000],
      radius: 150,
    });
    const lines = hanger.filter((p) => p.type === 'line');
    expect(lines).toHaveLength(2);
    expect(lines).toContainEqual(expect.objectContaining({ a: [2350, 2000], b: [2650, 2000] }));
    expect(lines).toContainEqual(expect.objectContaining({ a: [2500, 1850], b: [2500, 2150] }));
  });

  it('draws a square with a tick along each side of the pipe for a guide', () => {
    const guide = near(primitives, 4000);
    expect(guide.find((p) => p.type === 'polygon')).toMatchObject({ style: 'thin' });
    expect(guide.find((p) => p.type === 'polygon')).not.toHaveProperty('fill');
    const ticks = guide.filter((p) => p.type === 'line');
    expect(ticks).toHaveLength(2);
    expect(ticks).toContainEqual(expect.objectContaining({ a: [3850, 2200], b: [4150, 2200] }));
    expect(ticks).toContainEqual(expect.objectContaining({ a: [3850, 1800], b: [4150, 1800] }));
  });

  it('draws a hatched square with both diagonals for an anchor', () => {
    const anchor = near(primitives, 5500);
    expect(anchor.find((p) => p.type === 'polygon')).toMatchObject({ fill: 'hatch' });
    const diagonals = anchor.filter((p) => p.type === 'line');
    expect(diagonals).toContainEqual(expect.objectContaining({ a: [5350, 1850], b: [5650, 2150] }));
    expect(diagonals).toContainEqual(expect.objectContaining({ a: [5350, 2150], b: [5650, 1850] }));
    expect(anchor.find((p) => p.type === 'text')).toMatchObject({ content: 'PS4' });
  });

  it('turns the symbol with the pipe direction and draws risers at their plan point', () => {
    let doc = step(twoLevels(), 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 0, 1000],
        [0, 4000, 1000],
        [0, 4000, 4000],
      ],
    });
    doc = step(doc, 'add_pipe_support', { pipeId: 'pipe-1', type: 'guide', at: [[0, 1000, 1000]] });
    doc = step(doc, 'add_pipe_support', { pipeId: 'pipe-1', type: 'guide', at: [[0, 4000, 2500]] });
    const plan = supportPrimitives(doc);
    const ticks = plan.filter((p) => p.type === 'line');
    // pipe along +Y: the ticks run along Y, 200 mm either side of the axis
    expect(ticks).toContainEqual(expect.objectContaining({ a: [-200, 850], b: [-200, 1150] }));
    // the riser guide sits at the riser's plan point (0, 4000)
    expect(
      plan.filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.content : '')),
    ).toEqual(['PS1', 'PS2']);
    expect(
      plan.some((p) => p.type === 'polygon' && p.points.every((q) => Math.abs(q[1] - 4000) <= 150)),
    ).toBe(true);
  });

  it('draws supports on the plan of their own level only, like their pipe', () => {
    const doc = plantWithSupports();
    expect(supportPrimitives(doc, 'level-2')).toEqual([]);
    expect(supportPrimitives(doc, 'level-1').length).toBeGreaterThan(8);
  });
});

describe('pipe support symbols in the exports', () => {
  it('writes them to the DXF on P-SUPP (fills on P-SUPP-PATT) with the mark as text', () => {
    const result = execute(plantWithSupports(), 'export_dxf', { levelId: 'level-1' });
    const data = result.data as DxfExport;
    expect(data.layers).toEqual(expect.arrayContaining(['P-PIPE', 'P-SUPP', 'P-SUPP-PATT']));
    const lines = data.dxf.split('\n');
    const onLayer = (type: string): number =>
      lines.filter((line, index) => line === type && lines[index + 2] === 'P-SUPP').length;
    expect(onLayer('CIRCLE')).toBe(1);
    expect(onLayer('TEXT')).toBe(4);
    expect(onLayer('LINE')).toBe(2 + 2 + 2);
    expect(lines.filter((line, index) => line === 'PS3' && lines[index - 1] === '1')).toHaveLength(
      1,
    );
    expect(lines.filter((line) => line === 'SOLID').length).toBeGreaterThan(0);
  });

  it('draws them on the plan sheet', () => {
    const sheet = execute(plantWithSupports(), 'export_plan_sheet', { levelId: 'level-1' })
      .data as PlanSheet;
    expect(sheet.svg).toContain('>PS1</text>');
    expect(sheet.svg).toContain('>PS4</text>');
    expect(sheet.svg).toContain('class="cut-hatch"');
    expect(sheet.svg).toMatch(/<circle [^>]*class="thin"/);
  });

  it('does not draw them on a level without supports', () => {
    const data = execute(plantWithSupports(), 'export_dxf', { levelId: 'level-2' }).data as
      | DxfExport
      | undefined;
    expect(data?.layers ?? []).not.toContain('P-SUPP');
  });
});
