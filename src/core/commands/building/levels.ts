/**
 * Building levels (storeys), project info and building inspection.
 * @layer core/commands/building
 */

import type { CommandDefinition, CommandResult } from '../types';
import type { BuildingLevel, BuildingModel, ProjectInfo } from '../../model/building';
import {
  followLevelHeight,
  fromMm,
  getBuilding,
  isFiniteNumber,
  nextLevelId,
  noChange,
  sortLevelOrder,
  withLevel,
} from './model';
import { regenerateBuilding } from './evaluate';
import { openingFitIssues } from './walls';

interface AddLevelParams {
  name?: string;
  elevation?: number;
  height?: number;
  makeActive?: boolean;
}

/**
 * @command add_level
 * @pure
 * @affects none (levels are not entities); summary + data carry the new level id
 * @failure non-finite elevation or height <= 0 -> no-op
 */
export const addLevel: CommandDefinition<AddLevelParams> = {
  name: 'add_level',
  description:
    'Add a building level (storey). Elevation is the finished-floor height; height is floor-to-floor. ' +
    'Defaults: elevation = top of the highest existing level (or 0), height = 3000 mm. ' +
    'Building elements (walls, slabs, columns…) are placed relative to their level.',
  paramsSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Level name, e.g. "Ground floor", "Level 1".' },
      elevation: {
        type: 'number',
        description:
          'Finished-floor elevation in document units. Default: stacks on the top level.',
      },
      height: {
        type: 'number',
        description: 'Floor-to-floor height in document units (> 0). Default 3000 mm.',
      },
      makeActive: {
        type: 'boolean',
        description: 'Make it the active level for new elements. Default true.',
      },
    },
    required: [],
  },
  run: (doc, { name, elevation, height, makeActive = true }): CommandResult => {
    const building = getBuilding(doc);
    const top = building.levelOrder
      .map((id) => building.levels[id])
      .reduce<
        number | null
      >((highest, level) => (level && (highest === null || level.elevation + level.height > highest) ? level.elevation + level.height : highest), null);
    const resolvedElevation = elevation ?? top ?? 0;
    const resolvedHeight = height ?? fromMm(doc, 3000);
    if (
      !isFiniteNumber(resolvedElevation) ||
      !isFiniteNumber(resolvedHeight) ||
      resolvedHeight <= 0
    ) {
      return noChange(
        doc,
        `add_level failed: elevation must be finite and height > 0 (got elevation=${String(elevation)}, height=${String(height)}).`,
      );
    }
    const id = nextLevelId(building);
    const level: BuildingLevel = {
      id,
      name: name?.trim() || `Level ${building.levelOrder.length}`,
      elevation: resolvedElevation,
      height: resolvedHeight,
    };
    const next: BuildingModel = {
      ...withLevel(building, level),
      activeLevelId: makeActive || building.activeLevelId === null ? id : building.activeLevelId,
    };
    return {
      document: regenerateBuilding(doc, next),
      summary: `Added level ${id} "${level.name}" at elevation ${level.elevation} ${doc.units}, height ${level.height} ${doc.units}.`,
      affected: [id],
      data: { levelId: id },
    };
  },
};

interface UpdateLevelParams {
  levelId: string;
  name?: string;
  elevation?: number;
  height?: number;
}

/**
 * @command update_level
 * @pure
 * @affects regenerates every element on the level (they move with it)
 * @failure unknown level / invalid numbers -> no-op
 */
export const updateLevel: CommandDefinition<UpdateLevelParams> = {
  name: 'update_level',
  description:
    'Rename a level or change its elevation / floor-to-floor height. All walls, slabs, columns, ' +
    'beams, stairs, doors, windows and rooms on the level move and regenerate accordingly; walls and ' +
    'columns at full storey height and stairs climbing the storey follow a new height.',
  paramsSchema: {
    type: 'object',
    properties: {
      levelId: { type: 'string', description: 'Level id, e.g. "level-2".' },
      name: { type: 'string', description: 'New name.' },
      elevation: { type: 'number', description: 'New finished-floor elevation (document units).' },
      height: { type: 'number', description: 'New floor-to-floor height (> 0, document units).' },
    },
    required: ['levelId'],
  },
  run: (doc, { levelId, name, elevation, height }): CommandResult => {
    const building = getBuilding(doc);
    const level = building.levels[levelId];
    if (!level) return noChange(doc, `update_level failed: no level '${levelId}'.`);
    if (elevation !== undefined && !isFiniteNumber(elevation)) {
      return noChange(doc, 'update_level failed: elevation must be finite.');
    }
    if (height !== undefined && (!isFiniteNumber(height) || height <= 0)) {
      return noChange(doc, 'update_level failed: height must be > 0.');
    }
    const updated: BuildingLevel = {
      ...level,
      name: name?.trim() || level.name,
      elevation: elevation ?? level.elevation,
      height: height ?? level.height,
    };
    const levels = { ...building.levels, [levelId]: updated };
    const elements = Object.fromEntries(
      Object.entries(building.elements).map(([id, element]) => [
        id,
        'levelId' in element && element.levelId === levelId
          ? followLevelHeight(element, level.height, updated.height)
          : element,
      ]),
    );
    const next: BuildingModel = {
      ...building,
      levels,
      levelOrder: sortLevelOrder(levels),
      elements,
    };
    const issues = openingFitIssues(next, new Set([levelId]));
    if (issues.length > 0) return noChange(doc, `update_level refused: ${issues[0]}.`);
    const document = regenerateBuilding(doc, next);
    return {
      document,
      summary: `Level ${levelId} "${updated.name}": elevation ${updated.elevation}, height ${updated.height} ${doc.units}.`,
      affected: [levelId, ...elementEntityIdsOnLevel(document.building, levelId)],
    };
  },
};

function elementEntityIdsOnLevel(building: BuildingModel | undefined, levelId: string): string[] {
  if (!building) return [];
  return Object.values(building.elements)
    .filter((element) => 'levelId' in element && element.levelId === levelId)
    .flatMap((element) => element.entityIds);
}

interface DeleteLevelParams {
  levelId: string;
  deleteElements?: boolean;
}

/**
 * @command delete_level
 * @pure
 * @failure level holds elements and deleteElements is not true -> no-op
 */
export const deleteLevel: CommandDefinition<DeleteLevelParams> = {
  name: 'delete_level',
  annotations: { destructive: true },
  description:
    'Delete a level. Refuses if elements are hosted on it unless deleteElements is true, in which ' +
    'case its walls (with their doors/windows), slabs, columns, beams, stairs and rooms are deleted too.',
  paramsSchema: {
    type: 'object',
    properties: {
      levelId: { type: 'string', description: 'Level id to delete.' },
      deleteElements: {
        type: 'boolean',
        description: 'Also delete every element on the level. Default false.',
      },
    },
    required: ['levelId'],
  },
  run: (doc, { levelId, deleteElements = false }): CommandResult => {
    const building = getBuilding(doc);
    if (!building.levels[levelId])
      return noChange(doc, `delete_level failed: no level '${levelId}'.`);
    const onLevel = new Set(
      Object.values(building.elements)
        .filter((element) => 'levelId' in element && element.levelId === levelId)
        .map((element) => element.id),
    );
    for (const element of Object.values(building.elements)) {
      if (
        (element.category === 'door' || element.category === 'window') &&
        onLevel.has(element.hostId)
      ) {
        onLevel.add(element.id);
      }
    }
    if (onLevel.size > 0 && !deleteElements) {
      return noChange(
        doc,
        `delete_level refused: level ${levelId} hosts ${onLevel.size} element(s). Pass deleteElements: true to delete them too.`,
      );
    }
    const levels = { ...building.levels };
    delete levels[levelId];
    const elements = { ...building.elements };
    const removedEntityIds: string[] = [];
    for (const id of onLevel) {
      removedEntityIds.push(...(elements[id]?.entityIds ?? []));
      delete elements[id];
    }
    const levelOrder = sortLevelOrder(levels);
    const next: BuildingModel = {
      ...building,
      levels,
      levelOrder,
      activeLevelId:
        building.activeLevelId === levelId ? (levelOrder[0] ?? null) : building.activeLevelId,
      elements,
      elementOrder: building.elementOrder.filter((id) => !onLevel.has(id)),
    };
    return {
      document: regenerateBuilding(doc, next),
      summary: `Deleted level ${levelId} and ${onLevel.size} element(s).`,
      affected: [levelId, ...onLevel, ...removedEntityIds],
    };
  },
};

interface SetActiveLevelParams {
  levelId: string;
}

/** @command set_active_level @pure @failure unknown level -> no-op */
export const setActiveLevel: CommandDefinition<SetActiveLevelParams> = {
  name: 'set_active_level',
  annotations: { idempotent: true },
  description: 'Set the active level: new building elements go there when no levelId is given.',
  paramsSchema: {
    type: 'object',
    properties: { levelId: { type: 'string', description: 'Level id, e.g. "level-1".' } },
    required: ['levelId'],
  },
  run: (doc, { levelId }): CommandResult => {
    const building = getBuilding(doc);
    const level = building.levels[levelId];
    if (!level) return noChange(doc, `set_active_level failed: no level '${levelId}'.`);
    if (building.activeLevelId === levelId) {
      return noChange(doc, `Level ${levelId} "${level.name}" is already active.`);
    }
    return {
      document: { ...doc, building: { ...building, activeLevelId: levelId } },
      summary: `Active level is now ${levelId} "${level.name}".`,
      affected: [],
    };
  },
};

type SetProjectInfoParams = Partial<ProjectInfo>;

const PROJECT_FIELDS: ReadonlyArray<keyof ProjectInfo> = [
  'name',
  'client',
  'address',
  'author',
  'drawingNumber',
  'revision',
  'date',
];

/** @command set_project_info @pure @failure no field given -> no-op */
export const setProjectInfo: CommandDefinition<SetProjectInfoParams> = {
  name: 'set_project_info',
  annotations: { idempotent: true },
  description:
    'Set project metadata used by plan-sheet title blocks and IFC export: project name, client, ' +
    'site address, author, drawing number, revision, date. Omitted fields are kept.',
  paramsSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Project name.' },
      client: { type: 'string', description: 'Client / owner.' },
      address: { type: 'string', description: 'Site address.' },
      author: { type: 'string', description: 'Drawn by (company or person).' },
      drawingNumber: { type: 'string', description: 'Drawing number, e.g. "A-101".' },
      revision: { type: 'string', description: 'Revision, e.g. "B".' },
      date: { type: 'string', description: 'Issue date, e.g. "2026-10-01".' },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const building = getBuilding(doc);
    const changes: Partial<ProjectInfo> = {};
    for (const field of PROJECT_FIELDS) {
      const value = params[field];
      if (typeof value === 'string') changes[field] = value;
    }
    const changed = Object.keys(changes);
    if (changed.length === 0) {
      return noChange(
        doc,
        `set_project_info: no fields given (allowed: ${PROJECT_FIELDS.join(', ')}).`,
      );
    }
    return {
      document: { ...doc, building: { ...building, project: { ...building.project, ...changes } } },
      summary: `Project info updated: ${changed.map((field) => `${field}="${changes[field as keyof ProjectInfo] ?? ''}"`).join(', ')}.`,
      affected: [],
    };
  },
};

/**
 * @command describe_building
 * @pure read-only
 * @affects none; data = { project, levels[], elements[] }
 */
export const describeBuilding: CommandDefinition<Record<string, never>> = {
  name: 'describe_building',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only: list the building model — project info, levels (id, name, elevation, height, element ' +
    'counts) and every element (id, category, mark, level, key dimensions). Use it to find element ids ' +
    'before editing walls, openings, slabs, etc.',
  paramsSchema: { type: 'object', properties: {}, required: [] },
  run: (doc): CommandResult => {
    const building = getBuilding(doc);
    const elements = building.elementOrder
      .map((id) => building.elements[id])
      .filter((element) => element !== undefined);
    const levels = building.levelOrder
      .map((id) => building.levels[id])
      .filter((level): level is BuildingLevel => level !== undefined)
      .map((level) => ({
        ...level,
        active: level.id === building.activeLevelId,
        elementCount: elements.filter(
          (element) => 'levelId' in element && element.levelId === level.id,
        ).length,
      }));
    const counts = new Map<string, number>();
    for (const element of elements)
      counts.set(element.category, (counts.get(element.category) ?? 0) + 1);
    const countText =
      [...counts.entries()].map(([category, count]) => `${count} ${category}`).join(', ') ||
      'no elements';
    return {
      document: doc,
      summary: `Building "${building.project.name}": ${levels.length} level(s), ${countText}.`,
      affected: [],
      data: { project: building.project, units: doc.units, levels, elements },
    };
  },
};
