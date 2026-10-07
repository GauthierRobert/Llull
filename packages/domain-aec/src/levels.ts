/**
 * Building levels (storeys), project info and building inspection.
 * @layer domain-aec
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import type { BuildingLevel, BuildingModel, ProjectInfo } from '@core/model/building';
import {
  elementsOnLevel,
  followLevelHeight,
  fromMm,
  getBuilding,
  nextLevelId,
  orderedElements,
  sortLevelOrder,
  withDependents,
  withLevel,
  withoutElements,
} from './model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from './evaluateElements';
import { openingFitIssues } from './walls';

/**
 * @command add_level
 * @pure
 * @affects none (levels are not entities); summary + data carry the new level id
 * @failure non-finite elevation or height <= 0 -> no-op
 */
export const addLevel = defineCommand({
  name: 'add_level',
  description:
    'Add a building level (storey). Elevation is the finished-floor height; height is floor-to-floor. ' +
    'Defaults: elevation = top of the highest existing level (or 0), height = 3000 mm. ' +
    'Building elements (walls, slabs, columns…) are placed relative to their level.',
  params: z.object({
    name: z.string().optional().describe('Level name, e.g. "Ground floor", "Level 1".'),
    elevation: z
      .number()
      .optional()
      .describe('Finished-floor elevation in document units. Default: stacks on the top level.'),
    height: z
      .number()
      .optional()
      .describe('Floor-to-floor height in document units (> 0). Default 3000 mm.'),
    makeActive: z
      .boolean()
      .optional()
      .describe('Make it the active level for new elements. Default true.'),
  }),
  run: (doc, { name, elevation, height, makeActive = true }): CommandResult => {
    const building = getBuilding(doc);
    const tops = Object.values(building.levels).map((level) => level.elevation + level.height);
    const resolvedElevation = elevation ?? (tops.length > 0 ? Math.max(...tops) : 0);
    const resolvedHeight = height ?? fromMm(doc, 3000);
    if (resolvedHeight <= 0) {
      return noop(doc, `add_level failed: height must be > 0 (got ${String(height)}).`);
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
});

/**
 * @command update_level
 * @pure
 * @affects regenerates every element on the level (they move with it)
 * @failure unknown level / invalid numbers -> no-op
 */
export const updateLevel = defineCommand({
  name: 'update_level',
  description:
    'Rename a level or change its elevation / floor-to-floor height. All walls, slabs, columns, ' +
    'beams, stairs, doors, windows and rooms on the level move and regenerate accordingly; walls and ' +
    'columns at full storey height and stairs climbing the storey follow a new height.',
  params: z.object({
    levelId: z.string().describe('Level id, e.g. "level-2".'),
    name: z.string().optional().describe('New level name; blank keeps the current name.'),
    elevation: z.number().optional().describe('New finished-floor elevation (document units).'),
    height: z.number().optional().describe('New floor-to-floor height (> 0, document units).'),
  }),
  run: (doc, { levelId, name, elevation, height }): CommandResult => {
    const building = getBuilding(doc);
    const level = building.levels[levelId];
    if (!level) return noop(doc, `update_level failed: no level '${levelId}'.`);
    if (height !== undefined && height <= 0) {
      return noop(doc, 'update_level failed: height must be > 0.');
    }
    const updated: BuildingLevel = {
      ...level,
      name: name?.trim() || level.name,
      elevation: elevation ?? level.elevation,
      height: height ?? level.height,
    };
    if (
      updated.name === level.name &&
      updated.elevation === level.elevation &&
      updated.height === level.height
    ) {
      return noop(doc, `update_level: level ${levelId} "${level.name}" already has these values.`);
    }
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
    if (issues.length > 0) return noop(doc, `update_level refused: ${issues[0]}.`);
    const document = regenerateBuilding(doc, next);
    return {
      document,
      summary: `Level ${levelId} "${updated.name}": elevation ${updated.elevation}, height ${updated.height} ${doc.units}.`,
      affected: [
        levelId,
        ...elementsOnLevel(getBuilding(document), levelId).flatMap((element) => element.entityIds),
      ],
    };
  },
});

/**
 * @command delete_level
 * @pure
 * @failure level holds elements and deleteElements is not true -> no-op
 */
export const deleteLevel = defineCommand({
  name: 'delete_level',
  annotations: { destructive: true },
  description:
    'Delete a level. Refuses if elements are hosted on it unless deleteElements is true, in which ' +
    'case its walls (with their doors/windows), slabs, columns, beams, stairs and rooms are deleted too.',
  params: z.object({
    levelId: z.string().describe('Level id to delete.'),
    deleteElements: z
      .boolean()
      .optional()
      .describe('Also delete every element on the level. Default false.'),
  }),
  run: (doc, { levelId, deleteElements = false }): CommandResult => {
    const building = getBuilding(doc);
    if (!building.levels[levelId]) return noop(doc, `delete_level failed: no level '${levelId}'.`);
    const onLevel = withDependents(
      building,
      elementsOnLevel(building, levelId).map((element) => element.id),
    );
    if (onLevel.size > 0 && !deleteElements) {
      return noop(
        doc,
        `delete_level refused: level ${levelId} hosts ${onLevel.size} element(s). Pass deleteElements: true to delete them too.`,
      );
    }
    const levels = { ...building.levels };
    delete levels[levelId];
    const removedEntityIds = [...onLevel].flatMap((id) => building.elements[id]?.entityIds ?? []);
    const levelOrder = sortLevelOrder(levels);
    const next: BuildingModel = {
      ...withoutElements(building, onLevel),
      levels,
      levelOrder,
      activeLevelId:
        building.activeLevelId === levelId ? (levelOrder[0] ?? null) : building.activeLevelId,
    };
    return {
      document: regenerateBuilding(doc, next),
      summary: `Deleted level ${levelId} and ${onLevel.size} element(s).`,
      affected: [levelId, ...onLevel, ...removedEntityIds],
    };
  },
});

/** @command set_active_level @pure @failure unknown level -> no-op */
export const setActiveLevel = defineCommand({
  name: 'set_active_level',
  annotations: { idempotent: true },
  description: 'Set the active level: new building elements go there when no levelId is given.',
  params: z.object({ levelId: z.string().describe('Level id, e.g. "level-1".') }),
  run: (doc, { levelId }): CommandResult => {
    const building = getBuilding(doc);
    const level = building.levels[levelId];
    if (!level) return noop(doc, `set_active_level failed: no level '${levelId}'.`);
    if (building.activeLevelId === levelId) {
      return noop(doc, `Level ${levelId} "${level.name}" is already active.`);
    }
    return {
      document: { ...doc, building: { ...building, activeLevelId: levelId } },
      summary: `Active level is now ${levelId} "${level.name}".`,
      affected: [],
    };
  },
});

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
export const setProjectInfo = defineCommand({
  name: 'set_project_info',
  annotations: { idempotent: true },
  description:
    'Set project metadata used by plan-sheet title blocks and IFC export: project name, client, ' +
    'site address, author, drawing number, revision, date. Omitted fields are kept.',
  params: z.object({
    name: z.string().optional().describe('Project name.'),
    client: z.string().optional().describe('Client / owner.'),
    address: z.string().optional().describe('Site address.'),
    author: z.string().optional().describe('Drawn by (company or person).'),
    drawingNumber: z.string().optional().describe('Drawing number, e.g. "A-101".'),
    revision: z.string().optional().describe('Revision, e.g. "B".'),
    date: z.string().optional().describe('Issue date, e.g. "2026-10-01".'),
  }),
  run: (doc, params): CommandResult => {
    const building = getBuilding(doc);
    const changes: Partial<ProjectInfo> = {};
    for (const field of PROJECT_FIELDS) {
      const value = params[field];
      if (typeof value === 'string') changes[field] = value;
    }
    const changed = Object.keys(changes);
    if (changed.length === 0) {
      return noop(
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
});

/**
 * @command describe_building
 * @pure read-only
 * @affects none; data = { project, levels[], elements[] }
 */
export const describeBuilding = defineCommand({
  name: 'describe_building',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only: list the building model — project info, levels (id, name, elevation, height, element ' +
    'counts) and every element (id, category, mark, level, key dimensions). Use it to find element ids ' +
    'before editing walls, openings, slabs, etc.',
  params: z.object({}),
  run: (doc): CommandResult => {
    const building = getBuilding(doc);
    const elements = orderedElements(building);
    const levels = building.levelOrder
      .flatMap((id) => building.levels[id] ?? [])
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
});
