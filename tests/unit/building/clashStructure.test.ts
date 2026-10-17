import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { isClashData } from '@ui/resultData';

const clashes = (doc: CadDocument): Array<{ a: string; b: string; kind: string; depth: number }> => {
  const result = execute(doc, 'check_clashes', { tolerance: 0 });
  return isClashData(result.data) ? result.data.clashes : [];
};

function stairDoc(): { doc: CadDocument; stairMark: string } {
  let doc = createEmptyDocument();
  doc = execute(doc, 'set_units', { units: 'mm' }).document;
  doc = execute(doc, 'add_level', { name: 'Ground', elevation: 0, height: 3500 }).document;
  doc = execute(doc, 'add_level', { name: 'Level 1', elevation: 3500, height: 3500, makeActive: false }).document;
  doc = execute(doc, 'add_stair', { start: [500, 1000], angle: 0, width: 1000, levelId: 'level-1' }).document;
  return { doc, stairMark: 'stair' };
}

describe('check_clashes: structure against stairs and walls', () => {
  it('reports a concrete beam passing through a stair flight', () => {
    const { doc } = stairDoc();
    expect(clashes(doc)).toEqual([]);
    const withBeam = execute(doc, 'add_beam', {
      start: [5650, 600],
      end: [5650, 1400],
      levelId: 'level-1',
      width: 300,
      depth: 500,
    }).document;
    const found = clashes(withBeam);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'hard' });
    expect(found[0]?.depth).toBeGreaterThan(100);
  });

  it('does not report a beam that frames into a wall', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_level', { name: 'Ground', height: 3000 }).document;
    doc = execute(doc, 'draw_walls', {
      points: [
        [0, 0],
        [0, 4000],
      ],
      levelId: 'level-1',
      thickness: 200,
    }).document;
    doc = execute(doc, 'add_beam', {
      start: [0, 2000],
      end: [3000, 2000],
      levelId: 'level-1',
      width: 200,
      depth: 300,
      topOffset: -100,
    }).document;
    expect(clashes(doc)).toEqual([]);
  });

  it('reports a beam crossing a wall it does not frame into', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_level', { name: 'Ground', height: 3000 }).document;
    doc = execute(doc, 'draw_walls', {
      points: [
        [2000, 0],
        [2000, 4000],
      ],
      levelId: 'level-1',
      thickness: 200,
    }).document;
    doc = execute(doc, 'add_beam', {
      start: [0, 2000],
      end: [4000, 2000],
      levelId: 'level-1',
      width: 200,
      depth: 300,
      topOffset: -100,
    }).document;
    expect(clashes(doc)).toHaveLength(1);
  });
});
