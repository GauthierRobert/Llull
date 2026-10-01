/**
 * Starter building templates composed from the building commands (one undo step).
 * @layer core/commands/building
 */

import type { CadDocument, Vec2 } from '../../model/types';
import type { CommandDefinition, CommandResult } from '../types';
import { elementAffected, fromMm, getBuilding, isVec2, noChange } from './model';
import { addLevel, setProjectInfo } from './levels';
import { addGridSystem } from './grid';
import { addWall, drawWalls } from './walls';
import { addDoor, addWindow } from './openings';
import { addBeam, addColumn, addSlab, addStair } from './structure';
import { addRoom, copyLevelElements, deleteBuildingElement } from './elements';
import { addSlabOpening } from './slabOpenings';
import { fitView } from '../camera';

type Step = (doc: CadDocument) => CommandResult;

export type BuildingTemplate = 'house' | 'office';

/**
 * Template steps. Ids are looked up in `created` (filled by the run loop with the element / level ids
 * each step actually created, per kind, in order) — never predicted.
 */
function steps(
  doc: CadDocument,
  template: BuildingTemplate,
  origin: Vec2,
  created: Record<string, string[]>,
): Step[] {
  const mm = (value: number): number => fromMm(doc, value);
  const at = (x: number, y: number): Vec2 => [origin[0] + mm(x), origin[1] + mm(y)];
  const rectangle = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
    at(x0, y0),
    at(x1, y0),
    at(x1, y1),
    at(x0, y1),
  ];
  const building = getBuilding(doc);
  const nth = (kind: string, n: number): string => created[kind]?.[n - 1] ?? `missing-${kind}-${n}`;
  const level = (n: number): string => nth('level', n);
  const wall = (n: number): string => nth('wall', n);
  const door = (n: number): string => nth('door', n);
  const stair = (n: number): string => nth('stair', n);
  const perimeter = (): string[] => [wall(1), wall(2), wall(3), wall(4)];
  const naming: Step[] =
    building.project.name === 'Untitled project'
      ? [
          (d) =>
            setProjectInfo.run(d, {
              name: template === 'house' ? 'Two-storey house' : 'Office building',
            }),
        ]
      : [];
  if (template === 'house') {
    return [
      ...naming,
      (d) => addLevel.run(d, { name: 'Ground floor', elevation: 0, height: mm(2900) }),
      (d) =>
        addLevel.run(d, {
          name: 'First floor',
          elevation: mm(2900),
          height: mm(2900),
          makeActive: false,
        }),
      (d) =>
        addLevel.run(d, { name: 'Roof', elevation: mm(5800), height: mm(1000), makeActive: false }),
      (d) =>
        addGridSystem.run(d, {
          xSpacings: [mm(5000), mm(5000)],
          ySpacings: [mm(8000)],
          origin: at(0, 0),
        }),
      (d) =>
        drawWalls.run(d, {
          points: rectangle(0, 0, 10000, 8000),
          closed: true,
          thickness: mm(300),
          material: 'masonry',
        }),
      (d) =>
        addWall.run(d, {
          start: at(5000, 0),
          end: at(5000, 8000),
          thickness: mm(100),
          material: 'gypsum',
        }),
      (d) => addDoor.run(d, { wallId: wall(1), offset: mm(2500) }),
      (d) => addDoor.run(d, { wallId: wall(5), offset: mm(4000), swing: 'right', width: mm(800) }),
      (d) => addWindow.run(d, { wallId: wall(1), offset: mm(7500), width: mm(1800) }),
      (d) => addWindow.run(d, { wallId: wall(2), offset: mm(4000), width: mm(1400) }),
      (d) => addWindow.run(d, { wallId: wall(3), offset: mm(2500), width: mm(1800) }),
      (d) => addWindow.run(d, { wallId: wall(3), offset: mm(7500), width: mm(1800) }),
      (d) => addWindow.run(d, { wallId: wall(4), offset: mm(4000), width: mm(1400) }),
      (d) => addSlab.run(d, { wallIds: perimeter(), thickness: mm(200) }),
      (d) =>
        addStair.run(d, { start: at(5400, 6900), angle: 0, width: mm(900), treadDepth: mm(250) }),
      (d) => addRoom.run(d, { name: 'Living room', boundary: rectangle(150, 150, 4950, 7850) }),
      (d) => addRoom.run(d, { name: 'Kitchen', boundary: rectangle(5050, 150, 9850, 7850) }),
      (d) =>
        copyLevelElements.run(d, {
          sourceLevelId: level(1),
          targetLevelIds: [level(2)],
          categories: ['wall', 'slab'],
        }),
      (d) => deleteBuildingElement.run(d, { elementIds: [door(3)] }),
      (d) => addSlabOpening.run(d, { stairId: stair(1) }),
      (d) => addWindow.run(d, { wallId: wall(6), offset: mm(2500), width: mm(1400) }),
      (d) =>
        addRoom.run(d, {
          name: 'Bedroom',
          boundary: rectangle(150, 150, 4950, 7850),
          levelId: level(2),
        }),
      (d) =>
        addRoom.run(d, {
          name: 'Bedroom',
          boundary: rectangle(5050, 150, 9850, 7850),
          levelId: level(2),
        }),
      (d) =>
        addSlab.run(d, {
          boundary: rectangle(-300, -300, 10300, 8300),
          thickness: mm(250),
          offset: mm(250),
          role: 'roof',
          levelId: level(3),
        }),
    ];
  }
  return [
    ...naming,
    (d) => addLevel.run(d, { name: 'Level 0', elevation: 0, height: mm(3600) }),
    (d) =>
      addLevel.run(d, {
        name: 'Level 1',
        elevation: mm(3600),
        height: mm(3600),
        makeActive: false,
      }),
    (d) =>
      addLevel.run(d, {
        name: 'Level 2',
        elevation: mm(7200),
        height: mm(3600),
        makeActive: false,
      }),
    (d) =>
      addLevel.run(d, { name: 'Roof', elevation: mm(10800), height: mm(1000), makeActive: false }),
    (d) =>
      addGridSystem.run(d, {
        xSpacings: [mm(7500), mm(7500), mm(7500)],
        ySpacings: [mm(7500), mm(5000)],
        origin: at(0, 0),
      }),
    (d) =>
      drawWalls.run(d, {
        points: rectangle(0, 0, 22500, 12500),
        closed: true,
        thickness: mm(250),
        material: 'concrete',
      }),
    (d) => addColumn.run(d, { atGridIntersections: true, width: mm(400) }),
    (d) =>
      addBeam.run(d, { start: at(0, 7500), end: at(22500, 7500), width: mm(300), depth: mm(600) }),
    (d) =>
      addDoor.run(d, { wallId: wall(1), offset: mm(11250), width: mm(1800), height: mm(2400) }),
    ...[3750, 7500 + 3750, 15000 + 3750].map(
      (offset): Step =>
        (d) =>
          addWindow.run(d, {
            wallId: wall(3),
            offset: mm(offset),
            width: mm(3000),
            height: mm(1800),
          }),
    ),
    (d) =>
      addWindow.run(d, { wallId: wall(1), offset: mm(3750), width: mm(3000), height: mm(1800) }),
    (d) =>
      addWindow.run(d, { wallId: wall(1), offset: mm(18750), width: mm(3000), height: mm(1800) }),
    (d) => addSlab.run(d, { wallIds: perimeter(), thickness: mm(250) }),
    (d) =>
      addStair.run(d, { start: at(16000, 9000), angle: 0, width: mm(1200), treadDepth: mm(280) }),
    (d) => addRoom.run(d, { name: 'Open office', boundary: rectangle(125, 125, 22375, 7300) }),
    (d) => addRoom.run(d, { name: 'Meeting', boundary: rectangle(125, 7700, 15000, 12375) }),
    (d) =>
      copyLevelElements.run(d, {
        sourceLevelId: level(1),
        targetLevelIds: [level(2), level(3)],
        categories: ['wall', 'column', 'beam', 'slab', 'room'],
      }),
    (d) => deleteBuildingElement.run(d, { elementIds: [door(2), door(3)] }),
    (d) => addSlabOpening.run(d, { stairId: stair(1) }),
    ...[2, 3].map(
      (floor): Step =>
        (d) =>
          addWindow.run(d, {
            wallId: wall(1 + floor * 4 - 4),
            offset: mm(11250),
            width: mm(3000),
            height: mm(1800),
          }),
    ),
    (d) =>
      addSlab.run(d, {
        boundary: rectangle(-125, -125, 22625, 12625),
        thickness: mm(300),
        offset: mm(300),
        role: 'roof',
        levelId: level(4),
      }),
  ];
}

interface AddBuildingTemplateParams {
  template: BuildingTemplate;
  origin?: Vec2;
}

/**
 * @command add_building_template
 * @pure
 * @affects creates a complete multi-level building (all-or-nothing)
 * @failure unknown template / any step fails -> no-op with the failing step's summary
 */
export const addBuildingTemplate: CommandDefinition<AddBuildingTemplateParams> = {
  name: 'add_building_template',
  description:
    'Create a complete starter building to edit or learn from: "house" (two-storey 10 × 8 m house: grid, ' +
    'masonry walls, partition, doors, windows, slabs, stair, rooms, roof) or "office" (three-storey ' +
    '22.5 × 12.5 m concrete frame: grid, columns at intersections, beams, façade openings, slabs, stair, ' +
    'rooms, roof). The camera is framed on the result. All-or-nothing: the document is unchanged if any step fails.',
  paramsSchema: {
    type: 'object',
    properties: {
      template: {
        type: 'string',
        enum: ['house', 'office'],
        description: 'Which starter building.',
      },
      origin: {
        type: 'array',
        items: { type: 'number' },
        description: 'Plan origin [x, y]. Default [0, 0].',
      },
    },
    required: ['template'],
  },
  run: (doc, { template, origin = [0, 0] }): CommandResult => {
    if (template !== 'house' && template !== 'office') {
      return noChange(doc, 'add_building_template failed: template must be "house" or "office".');
    }
    if (!isVec2(origin))
      return noChange(doc, 'add_building_template failed: origin must be [x, y].');
    let current = doc;
    const created: Record<string, string[]> = {};
    for (const [index, step] of steps(doc, template, origin, created).entries()) {
      const before = getBuilding(current);
      const result = step(current);
      if (result.document === current) {
        return noChange(
          doc,
          `add_building_template failed at step ${index + 1}: ${result.summary}`,
        );
      }
      current = result.document;
      const after = getBuilding(current);
      const fresh = [
        ...after.levelOrder.filter((id) => before.levels[id] === undefined),
        ...after.elementOrder.filter((id) => before.elements[id] === undefined),
      ];
      for (const id of fresh) {
        const kind = id.replace(/-\d+$/, '');
        created[kind] = [...(created[kind] ?? []), id];
      }
    }
    current = fitView.run(current, { direction: 'iso' }).document;
    const building = getBuilding(current);
    const before = new Set(Object.keys(getBuilding(doc).elements));
    const newElements = building.elementOrder.filter((id) => !before.has(id));
    return {
      document: current,
      summary: `Added ${template} template: ${building.levelOrder.length} level(s), ${newElements.length} building element(s).`,
      affected: elementAffected(current, newElements),
      data: { elementIds: newElements },
    };
  },
};
