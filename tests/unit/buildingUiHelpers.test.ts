import { describe, expect, it } from 'vitest';
import { ELEMENT_TOOLS, defaultValues, type ElementTool } from '@ui/panels/building/elementTools';
import { wallChainParams } from '@ui/viewport/2d/useDrawTool';
import { execute, getCommand } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

describe('building element tools', () => {
  const context = { levelId: 'level-1', wallIds: ['wall-1', 'wall-2'] };

  it.each(ELEMENT_TOOLS.map((tool) => [tool.id, tool] as const))(
    '%s defaults build a call to a registered command',
    (_id, tool) => {
      const values = { ...defaultValues(tool), wallId: 'wall-1', stairId: 'stair-1', name: 'Room' };
      const outcome = tool.build(values, context);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(getCommand(outcome.command)).toBeDefined();
    },
  );

  it('the default perimeter then slab-from-walls tools produce a valid model', () => {
    const tool = (id: string): ElementTool =>
      ELEMENT_TOOLS.find((candidate) => candidate.id === id)!;
    const perimeter = tool('perimeter').build(defaultValues(tool('perimeter')), {
      levelId: null,
      wallIds: [],
    });
    if (!perimeter.ok) throw new Error(perimeter.reason);
    const walled = execute(createEmptyDocument(), perimeter.command, perimeter.params).document;
    const slab = tool('slab').build(defaultValues(tool('slab')), {
      levelId: walled.building!.activeLevelId,
      wallIds: walled.building!.elementOrder,
    });
    if (!slab.ok) throw new Error(slab.reason);
    const result = execute(walled, slab.command, slab.params);
    expect(result.summary).toMatch(/floor slab SL1.*area 80000000\.000/);
  });

  it('slab and room outlines switch between walls and rectangle', () => {
    const slab = ELEMENT_TOOLS.find((tool) => tool.id === 'slab')!;
    const fromWalls = slab.build(defaultValues(slab), context);
    expect(fromWalls.ok && fromWalls.params['wallIds']).toEqual(['wall-1', 'wall-2']);
    const fromRectangle = slab.build({ ...defaultValues(slab), source: 'rectangle' }, context);
    expect(fromRectangle.ok && fromRectangle.params['boundary']).toEqual([
      [0, 0],
      [5000, 0],
      [5000, 4000],
      [0, 4000],
    ]);
    const room = ELEMENT_TOOLS.find((tool) => tool.id === 'room')!;
    expect(room.build({ ...defaultValues(room), name: '' }, context)).toEqual({
      ok: false,
      reason: 'A room needs a name.',
    });
    const grid = ELEMENT_TOOLS.find((tool) => tool.id === 'grid')!;
    expect(grid.build({ xSpacings: '', ySpacings: '5' }, context)).toEqual({
      ok: false,
      reason: 'Check: xSpacings',
    });
    const stair = ELEMENT_TOOLS.find((tool) => tool.id === 'stair')!;
    const stairCall = stair.build({ ...defaultValues(stair), direction: '90' }, context);
    expect(stairCall.ok && stairCall.params['angle']).toBeCloseTo(Math.PI / 2);
    const wall = ELEMENT_TOOLS.find((tool) => tool.id === 'wall')!;
    expect(wall.build({ ...defaultValues(wall), height: 'x' }, context).ok).toBe(false);
  });
});

describe('wallChainParams', () => {
  it('closes the chain when the last click returns to the first point', () => {
    expect(
      wallChainParams(
        [
          [0, 0],
          [4, 0],
          [4, 3],
          [0, 0],
        ],
        false,
      ),
    ).toEqual({
      points: [
        [0, 0],
        [4, 0],
        [4, 3],
      ],
      closed: true,
    });
    expect(
      wallChainParams(
        [
          [0, 0],
          [4, 0],
        ],
        false,
      ),
    ).toEqual({
      points: [
        [0, 0],
        [4, 0],
      ],
      closed: false,
    });
  });
});

describe('slab opening tool', () => {
  const tool = ELEMENT_TOOLS.find((candidate) => candidate.id === 'slabOpening')!;
  const context = { levelId: 'level-1', wallIds: [] };

  it('cuts a stair well or a rectangle and asks for the missing pick', () => {
    expect(tool.build(defaultValues(tool), context)).toEqual({
      ok: false,
      reason: 'Pick a stair first.',
    });
    expect(tool.build({ ...defaultValues(tool), stairId: 'stair-1' }, context)).toEqual({
      ok: true,
      command: 'add_slab_opening',
      params: { stairId: 'stair-1', margin: 100 },
    });
    const rectangle = { ...defaultValues(tool), source: 'rectangle' };
    expect(tool.build(rectangle, context)).toEqual({ ok: false, reason: 'Pick a slab first.' });
    const cut = tool.build({ ...rectangle, slabId: 'slab-1' }, context);
    expect(cut.ok && cut.params['boundary']).toEqual([
      [1000, 1000],
      [3000, 1000],
      [3000, 2000],
      [1000, 2000],
    ]);
  });
});
