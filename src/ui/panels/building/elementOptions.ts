import type { BuildingModel } from '@aec/building/types';
import type { ElementListKind } from './elementToolForm';

interface ElementOption {
  readonly id: string;
  readonly label: string;
}

export type ElementOptions = Readonly<Record<ElementListKind, ReadonlyArray<ElementOption>>>;

const emptyOptions = (): Record<ElementListKind, ElementOption[]> => ({
  walls: [],
  hosts: [],
  stairs: [],
  slabs: [],
  levels: [],
  pipes: [],
});

const NO_OPTIONS: ElementOptions = emptyOptions();

/** Active level's walls, every stair / slab (stair wells cut the slab above) and every level. */
export function elementOptions(building: BuildingModel | undefined): ElementOptions {
  if (!building) return NO_OPTIONS;
  const options = emptyOptions();
  for (const levelId of building.levelOrder) {
    const level = building.levels[levelId];
    if (level) options.levels.push({ id: levelId, label: `${level.name} · +${level.elevation}` });
  }
  const lineNumbers = new Set<string>();
  for (const id of building.elementOrder) {
    const element = building.elements[id];
    if (!element) continue;
    const onActiveLevel = 'levelId' in element && element.levelId === building.activeLevelId;
    if (element.category === 'wall' && onActiveLevel) {
      const length = Math.hypot(element.end[0] - element.start[0], element.end[1] - element.start[1]);
      options.walls.push({ id, label: `${element.mark} · ${Math.round(length)} long` });
      options.hosts.push({ id, label: `${element.mark} · ${Math.round(length)} long` });
    } else if (element.category === 'curvedWall' && onActiveLevel) {
      options.hosts.push({ id, label: `${element.mark} · curved` });
    } else if (element.category === 'pipe') {
      const line = element.line ?? '';
      if (line === '') {
        options.pipes.push({ id: `pipe:${id}`, label: `${element.mark} · DN${element.dn ?? '?'}` });
      } else if (!lineNumbers.has(line)) {
        lineNumbers.add(line);
        options.pipes.push({ id: `line:${line}`, label: `${line} · ${element.mark} · DN${element.dn ?? '?'}` });
      }
    } else if (element.category === 'stair') {
      const level = building.levels[element.levelId]?.name ?? element.levelId;
      options.stairs.push({ id, label: `${element.mark} · ${element.riserCount} risers · ${level}` });
    } else if (element.category === 'slab') {
      const level = building.levels[element.levelId]?.name ?? element.levelId;
      options.slabs.push({ id, label: `${element.mark} · ${element.role} · ${level}` });
    }
  }
  return options;
}
