import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { isClashData } from '@ui/resultData';

const FLOOR: number[][] = [
  [0, 0],
  [12000, 0],
  [12000, 8000],
  [0, 8000],
];

/** Ground (h 6000) + floor +6.00 with a grating, a 10 m vertical vessel standing on the ground. */
function vesselThroughFloor(): CadDocument {
  let doc = createEmptyDocument();
  for (const name of ['Ground', '+6.00']) {
    doc = execute(doc, 'add_level', { name, height: 6000, makeActive: false }).document;
  }
  doc = execute(doc, 'add_slab', {
    levelId: 'level-2',
    boundary: FLOOR,
    thickness: 30,
    material: 'grating',
  }).document;
  return execute(doc, 'add_equipment', {
    mark: 'D-401',
    name: 'DT',
    levelId: 'level-1',
    location: [6000, 4000],
    size: [3000, 3000, 10000],
    shape: 'vertical_vessel',
  }).document;
}

const clashesOf = (doc: CadDocument, params: Record<string, unknown> = {}): unknown[] => {
  const result = execute(doc, 'check_clashes', params);
  return isClashData(result.data) ? result.data.clashes : [];
};

describe('check_clashes: equipment through a floor', () => {
  it('reports a vessel crossing a grating that has no opening', () => {
    const doc = vesselThroughFloor();
    const result = execute(doc, 'check_clashes', {});
    expect(clashesOf(doc)).toEqual([{ a: 'equipment-1', b: 'slab-1', kind: 'hard', depth: 30 }]);
    expect(result.summary).toMatch(/1 hard clash\(es\).*D-401 × SL1|SL1 × D-401/);
    expect(clashesOf(doc, { levelId: 'level-2' })).toHaveLength(1);
  });

  it('is clear once the floor is cut around the vessel', () => {
    const doc = execute(vesselThroughFloor(), 'add_slab_opening', {
      slabId: 'slab-1',
      boundary: [
        [4200, 2200],
        [7800, 2200],
        [7800, 5800],
        [4200, 5800],
      ],
    }).document;
    expect(clashesOf(doc)).toEqual([]);
  });

  it('ignores the floor the equipment stands on and floors above its top', () => {
    let doc = vesselThroughFloor();
    doc = execute(doc, 'update_equipment', {
      elementId: 'equipment-1',
      levelId: 'level-2',
      size: [3000, 3000, 5000],
    }).document;
    expect(clashesOf(doc)).toEqual([]);
    const short = execute(vesselThroughFloor(), 'update_equipment', {
      elementId: 'equipment-1',
      size: [3000, 3000, 5990],
    }).document;
    expect(clashesOf(short)).toEqual([]);
  });

  it('ignores equipment outside the floor outline', () => {
    const doc = execute(vesselThroughFloor(), 'update_equipment', {
      elementId: 'equipment-1',
      location: [20000, 4000],
    }).document;
    expect(clashesOf(doc)).toEqual([]);
  });
});

describe('check_clashes: modelled walls', () => {
  const wallDoc = (): CadDocument => {
    const doc = execute(createEmptyDocument(), 'add_wall', {
      start: [0, 0],
      end: [4000, 0],
      thickness: 200,
    }).document;
    return execute(doc, 'add_equipment', {
      mark: 'P-1',
      name: 'Pump',
      location: [2000, 0],
      size: [1000, 1000, 1000],
    }).document;
  };

  it('reports equipment standing inside a wall and clears once it moves away', () => {
    const doc = wallDoc();
    const clashes = clashesOf(doc) as { a: string; b: string; kind: string }[];
    expect(clashes).toHaveLength(1);
    expect([clashes[0]?.a, clashes[0]?.b].sort()).toEqual(['equipment-1', 'wall-1']);
    expect(clashes[0]?.kind).toBe('hard');
    const moved = execute(doc, 'update_equipment', {
      elementId: 'equipment-1',
      location: [2000, 3000],
    }).document;
    expect(clashesOf(moved)).toEqual([]);
  });
});

describe('add_equipment_openings', () => {
  it('cuts the floor around a vessel and clears the clash', () => {
    const doc = vesselThroughFloor();
    const result = execute(doc, 'add_equipment_openings', { equipmentId: 'equipment-1' });
    expect(result.summary).toMatch(/Cut 12\.96 m² opening\(s\) around D-401 in SL1 \(slab-1\)\./);
    expect(result.data).toEqual({ slabIds: ['slab-1'] });
    expect(result.affected.length).toBeGreaterThan(0);
    const slab = result.document.building?.elements['slab-1'];
    expect(slab?.category === 'slab' && slab.openings).toEqual([
      [
        [4200, 2200],
        [7800, 2200],
        [7800, 5800],
        [4200, 5800],
      ],
    ]);
    expect(clashesOf(result.document)).toEqual([]);
    expect(doc.building?.elements['slab-1']).not.toHaveProperty('openings');
  });

  it('is a no-op with nothing to cut, an unknown id or a bad margin', () => {
    const doc = vesselThroughFloor();
    const cut = execute(doc, 'add_equipment_openings', { equipmentId: 'equipment-1' }).document;
    const again = execute(cut, 'add_equipment_openings', { equipmentId: 'equipment-1' });
    expect(again.document).toBe(cut);
    expect(again.summary).toMatch(/crosses no floor/);
    const unknown = execute(doc, 'add_equipment_openings', { equipmentId: 'slab-1' });
    expect(unknown.summary).toMatch(/no equipment 'slab-1'/);
    const negative = execute(doc, 'add_equipment_openings', {
      equipmentId: 'equipment-1',
      margin: -1,
    });
    expect(negative.summary).toMatch(/margin must be >= 0/);
    expect(negative.affected).toEqual([]);
  });

  it('refuses an opening that would not fit inside the slab', () => {
    const doc = execute(vesselThroughFloor(), 'update_equipment', {
      elementId: 'equipment-1',
      location: [1000, 4000],
    }).document;
    const result = execute(doc, 'add_equipment_openings', { equipmentId: 'equipment-1' });
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/refused: SL1: the opening is not strictly inside slab SL1/);
  });
});
