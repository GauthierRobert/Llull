/**
 * Rooms, and generic edits on any building element (delete, move, copy to levels).
 * @layer domain-aec
 */

import type { Vec2, Vec3 } from '@core/model/types';
import type {
  BuildingElement,
  BuildingModel,
  RoomElement,
  WallElement,
} from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import { isValidPolygon, offsetPolygon, polygonArea } from '@lib/polygon';
import {
  getBuilding,
  hostOf,
  dependenciesOf,
  isVec2,
  isVec2List,
  nextElementId,
  nextMark,
  noChange,
  resolveLevel,
  toMetres,
  toVec2,
  withElement,
  elementAffected,
  followLevelHeight,
  withoutElements,
} from './model';
import { regenerateBuilding } from './evaluate';
import { wallLoop } from './structure';
import { openingFitIssues } from './walls';
import { nextMemberMark } from './industrial/members';

/**
 * @command add_room
 * @pure
 * @affects creates the room outline + name/area tags on layer A-AREA
 * @failure missing name / invalid boundary / walls not a closed loop -> no-op
 */
export const addRoom = defineCommand({
  name: 'add_room',
  description:
    'Define a room (space) with a name and number from a plan boundary polygon, or from wallIds forming ' +
    'a closed loop (the room then follows the inner wall faces). Draws the outline and an area tag; ' +
    'rooms feed the room schedule and IFC spaces.',
  params: z.object({
    name: z.string().describe('Room name, e.g. "Kitchen".'),
    number: z
      .string()
      .optional()
      .describe('Room number. Default: level index × 100 + n (e.g. "101").'),
    boundary: z.array(z.array(z.number())).optional().describe('Closed plan polygon [[x, y], …].'),
    wallIds: z
      .array(z.string())
      .optional()
      .describe('Alternative to boundary: ids of walls enclosing the room (closed loop).'),
    levelId: z.string().optional().describe('Level id. Default: the active level.'),
  }),
  run: (doc, { name, number, boundary, wallIds, levelId }): CommandResult => {
    if (name.trim() === '') {
      return noChange(doc, 'add_room failed: name is required.');
    }
    const building = getBuilding(doc);
    let outline: Vec2[] | null = null;
    let wallLevelId: string | undefined;
    if (boundary !== undefined) {
      outline = isVec2List(boundary, 3) ? boundary.map(toVec2) : null;
    } else if (wallIds !== undefined) {
      const walls = wallIds.map((id) => building.elements[id]);
      if (walls.every((wall): wall is WallElement => wall?.category === 'wall')) {
        if (new Set(walls.map((wall) => wall.levelId)).size > 1) {
          return noChange(doc, 'add_room failed: wallIds belong to different levels.');
        }
        wallLevelId = walls[0]?.levelId;
        const loop = wallLoop(walls);
        const halfThickness = Math.max(...walls.map((wall) => wall.thickness)) / 2;
        outline = loop ? offsetPolygon(loop, -halfThickness).map(toVec2) : null;
      }
    }
    if (!outline || !isValidPolygon(outline)) {
      return noChange(
        doc,
        'add_room failed: give a boundary of ≥ 3 non-collinear [x, y] points, or wallIds forming a closed loop.',
      );
    }
    const resolution = resolveLevel(doc, building, levelId ?? wallLevelId);
    if (!resolution.ok) return noChange(doc, `add_room failed: ${resolution.reason}.`);
    const levelIndex = resolution.building.levelOrder.indexOf(resolution.level.id);
    const roomsOnLevel = Object.values(resolution.building.elements).filter(
      (element) => element.category === 'room' && element.levelId === resolution.level.id,
    ).length;
    const room: RoomElement = {
      id: nextElementId(resolution.building, 'room'),
      category: 'room',
      mark: number?.trim() || String(levelIndex * 100 + roomsOnLevel + 1).padStart(3, '0'),
      entityIds: [],
      levelId: resolution.level.id,
      name: name.trim(),
      boundary: outline,
    };
    const document = regenerateBuilding(doc, withElement(resolution.building, room));
    const squareMetres = polygonArea(outline) * toMetres(doc, 1) ** 2;
    return {
      document,
      summary: `Added room ${room.mark} "${room.name}" (${room.id}) on ${resolution.level.name}: ${squareMetres.toFixed(2)} m².`,
      affected: elementAffected(document, [room.id]),
      data: { elementId: room.id, areaSquareMetres: squareMetres },
    };
  },
});

/** Element ids plus the elements hosted by any of them (wall openings, column base plates). */
function withHostedOpenings(building: BuildingModel, ids: ReadonlyArray<string>): Set<string> {
  const result = new Set(ids);
  for (const element of Object.values(building.elements)) {
    if (dependenciesOf(element).some((id) => result.has(id))) result.add(element.id);
  }
  return result;
}

/**
 * @command delete_building_element
 * @pure
 * @affects removes the elements' evaluated entities (walls take their doors/windows along)
 * @failure no known ids -> no-op
 */
export const deleteBuildingElement = defineCommand({
  name: 'delete_building_element',
  annotations: { destructive: true },
  description:
    'Delete building elements by element id (walls, doors, windows, slabs, columns, beams, stairs, rooms, ' +
    'grid axes). Deleting a wall also deletes its doors and windows; joined walls are re-trimmed.',
  params: z.object({
    elementIds: z.array(z.string()).describe('Element ids, e.g. ["wall-2", "door-1"].'),
  }),
  run: (doc, { elementIds }): CommandResult => {
    const building = getBuilding(doc);
    const known = elementIds.filter((id) => building.elements[id] !== undefined);
    if (known.length === 0) {
      return noChange(doc, 'delete_building_element: none of the given ids is a building element.');
    }
    const doomed = withHostedOpenings(building, known);
    const removedEntityIds = [...doomed].flatMap((id) => building.elements[id]?.entityIds ?? []);
    return {
      document: regenerateBuilding(doc, withoutElements(building, doomed)),
      summary: `Deleted ${doomed.size} building element(s): ${[...doomed].join(', ')}.`,
      affected: [...doomed, ...removedEntityIds],
    };
  },
});

function translated(element: BuildingElement, dx: number, dy: number): BuildingElement {
  const shift = (point: Vec2): Vec2 => [point[0] + dx, point[1] + dy];
  switch (element.category) {
    case 'grid':
    case 'wall':
    case 'beam':
      return { ...element, start: shift(element.start), end: shift(element.end) };
    case 'curvedWall':
      return {
        ...element,
        start: shift(element.start),
        through: shift(element.through),
        end: shift(element.end),
      };
    case 'slab':
      return {
        ...element,
        boundary: element.boundary.map(shift),
        ...(element.openings
          ? { openings: element.openings.map((opening) => opening.map(shift)) }
          : {}),
      };
    case 'room':
      return { ...element, boundary: element.boundary.map(shift) };
    case 'column':
      return { ...element, location: shift(element.location) };
    case 'stair':
      return { ...element, start: shift(element.start) };
    case 'member':
      return {
        ...element,
        start: [element.start[0] + dx, element.start[1] + dy, element.start[2]],
        end: [element.end[0] + dx, element.end[1] + dy, element.end[2]],
      };
    case 'footing':
    case 'equipment':
      return { ...element, location: shift(element.location) };
    case 'panel':
      return { ...element, corners: element.corners.map(([x, y, z]): Vec3 => [x + dx, y + dy, z]) };
    case 'pipe':
    case 'tray':
      return { ...element, points: element.points.map(([x, y, z]): Vec3 => [x + dx, y + dy, z]) };
    case 'door':
    case 'window':
    case 'plate':
    case 'connection':
      return element;
  }
}

/**
 * @command move_building_element
 * @pure
 * @affects regenerates the moved elements (hosted openings move with their wall)
 * @failure no known ids / invalid delta -> no-op
 */
export const moveBuildingElement = defineCommand({
  name: 'move_building_element',
  description:
    'Move building elements in plan by delta [dx, dy]. Doors/windows travel with their wall (to slide ' +
    'an opening along its wall use update_opening). Corner joins are recomputed.',
  params: z.object({
    elementIds: z.array(z.string()).describe('Element ids to move.'),
    delta: vec2('Plan translation [dx, dy].'),
  }),
  run: (doc, { elementIds, delta }): CommandResult => {
    if (!isVec2(delta))
      return noChange(doc, 'move_building_element failed: delta must be [dx, dy].');
    const building = getBuilding(doc);
    const known = elementIds.filter((id) => building.elements[id] !== undefined);
    if (known.length === 0) {
      return noChange(doc, 'move_building_element: none of the given ids is a building element.');
    }
    const strayOpenings = known.filter((id) => {
      const element = building.elements[id];
      const host = element ? hostOf(element) : null;
      return host !== null && !known.includes(host);
    });
    if (strayOpenings.length > 0) {
      return noChange(
        doc,
        `move_building_element refused: ${strayOpenings.join(', ')} follow their host (a wall, a steel column or a rafter) — slide openings with update_opening (offset) or move the host.`,
      );
    }
    // A column moved without its rafter would leave the eaves connection detached.
    const detached = Object.values(building.elements).filter(
      (element) =>
        element.category === 'connection' &&
        known.includes(element.otherId) &&
        !known.includes(element.rafterId),
    );
    if (detached.length > 0) {
      return noChange(
        doc,
        `move_building_element refused: moment connection(s) ${detached.map((element) => element.id).join(', ')} tie the moved member(s) to rafters that are not moved — move the rafters too, or delete the connections first.`,
      );
    }
    let next = building;
    for (const id of known) {
      const element = building.elements[id] as BuildingElement;
      next = withElement(next, translated(element, delta[0], delta[1]));
    }
    const movedLevels = new Set(
      known.flatMap((id) => {
        const element = building.elements[id];
        return element && 'levelId' in element ? [element.levelId] : [];
      }),
    );
    const issues = openingFitIssues(next, movedLevels);
    if (issues.length > 0) return noChange(doc, `move_building_element refused: ${issues[0]}.`);
    const document = regenerateBuilding(doc, next);
    const moved = withHostedOpenings(building, known);
    return {
      document,
      summary: `Moved ${known.length} element(s) by [${delta[0]}, ${delta[1]}]: ${known.join(', ')}.`,
      affected: elementAffected(document, [...moved]),
    };
  },
});

/**
 * Room number for a copy on the level at `levelIndex`: numeric numbers keep their last two digits
 * under the level's hundred ("003" → "103"); other marks get a level suffix ("Lobby" → "Lobby-L1").
 * A numeric suffix is appended until the number is unused.
 */
export function copiedRoomNumber(
  building: BuildingModel,
  mark: string,
  levelIndex: number,
): string {
  const used = new Set(
    Object.values(building.elements)
      .filter((element) => element.category === 'room')
      .map((element) => element.mark),
  );
  const base = /^\d+$/.test(mark)
    ? String(levelIndex * 100 + (Number(mark) % 100)).padStart(3, '0')
    : `${mark}-L${levelIndex}`;
  let candidate = base;
  for (let suffix = 2; used.has(candidate); suffix++) candidate = `${base}-${suffix}`;
  return candidate;
}

const COPYABLE = [
  'wall',
  'curvedWall',
  'slab',
  'column',
  'beam',
  'stair',
  'room',
  'member',
  'footing',
  'panel',
  'equipment',
  'pipe',
  'tray',
] as const;

/**
 * @command copy_level_elements
 * @pure
 * @affects duplicates the source level's elements (and hosted openings) onto each target level
 * @failure unknown levels / nothing to copy -> no-op
 */
export const copyLevelElements = defineCommand({
  name: 'copy_level_elements',
  description:
    'Repeat a floor: copy every wall (with its doors/windows), slab, column, beam, stair and room of the ' +
    'source level onto each target level (typical floors of a multi-storey building). Optionally restrict ' +
    'to some categories.',
  params: z.object({
    sourceLevelId: z.string().describe('Level to copy from.'),
    targetLevelIds: z.array(z.string()).describe('Levels to copy to.'),
    categories: z
      .array(z.enum(COPYABLE))
      .optional()
      .describe(`Subset of categories to copy (${COPYABLE.join(', ')}). Default all.`),
  }),
  run: (doc, { sourceLevelId, targetLevelIds, categories }): CommandResult => {
    const building = getBuilding(doc);
    const targets = targetLevelIds;
    const missing = [sourceLevelId, ...targets].filter((id) => !building.levels[id]);
    if (missing.length > 0 || targets.length === 0) {
      return noChange(
        doc,
        `copy_level_elements failed: unknown or missing level(s) ${missing.join(', ') || '(no targets)'}.`,
      );
    }
    // Hosted elements (doors, windows, base plates) are copied with their host only.
    const allowed = new Set<string>(
      categories !== undefined && categories.length > 0 ? categories : COPYABLE,
    );
    const sourceElements = building.elementOrder
      .map((id) => building.elements[id])
      .filter(
        (element): element is Exclude<BuildingElement, { category: 'grid' | 'door' | 'window' }> =>
          element !== undefined &&
          'levelId' in element &&
          element.levelId === sourceLevelId &&
          allowed.has(element.category),
      );
    if (sourceElements.length === 0) {
      return noChange(doc, `copy_level_elements: level ${sourceLevelId} has nothing to copy.`);
    }
    let next = building;
    const created: string[] = [];
    for (const targetLevelId of targets) {
      if (targetLevelId === sourceLevelId) continue;
      const levelIndex = next.levelOrder.indexOf(targetLevelId);
      const copiedIds = new Map<string, string>();
      for (const element of sourceElements) {
        const id = nextElementId(next, element.category);
        const mark =
          element.category === 'room'
            ? copiedRoomNumber(next, element.mark, levelIndex)
            : element.category === 'member'
              ? nextMemberMark(next, element.role)
              : nextMark(next, element.category);
        const sourceHeight = building.levels[sourceLevelId]?.height ?? 0;
        const targetHeight = next.levels[targetLevelId]?.height ?? sourceHeight;
        next = withElement(
          next,
          followLevelHeight(
            { ...element, id, mark, levelId: targetLevelId, entityIds: [] },
            sourceHeight,
            targetHeight,
          ),
        );
        created.push(id);
        copiedIds.set(element.id, id);
        for (const hostedId of building.elementOrder) {
          const hosted = building.elements[hostedId];
          if (
            !hosted ||
            hostOf(hosted) !== element.id ||
            (hosted.category !== 'plate' &&
              hosted.category !== 'door' &&
              hosted.category !== 'window')
          )
            continue;
          const copyId = nextElementId(next, hosted.category);
          const mark = nextMark(next, hosted.category);
          next = withElement(
            next,
            hosted.category === 'plate'
              ? { ...hosted, id: copyId, mark, memberId: id, levelId: targetLevelId, entityIds: [] }
              : { ...hosted, id: copyId, mark, hostId: id, entityIds: [] },
          );
          created.push(copyId);
        }
      }
      // Moment connections follow when both connected members were copied.
      for (const connectionId of building.elementOrder) {
        const connection = building.elements[connectionId];
        if (connection?.category !== 'connection') continue;
        const [rafterId, otherId] = [
          copiedIds.get(connection.rafterId),
          copiedIds.get(connection.otherId),
        ];
        if (rafterId === undefined || otherId === undefined) continue;
        const copyId = nextElementId(next, 'connection');
        next = withElement(next, {
          ...connection,
          id: copyId,
          mark: nextMark(next, 'connection'),
          levelId: targetLevelId,
          rafterId,
          otherId,
          entityIds: [],
        });
        created.push(copyId);
      }
    }
    const issues = openingFitIssues(next, new Set(targets));
    if (issues.length > 0) return noChange(doc, `copy_level_elements refused: ${issues[0]}.`);
    const document = regenerateBuilding(doc, next);
    return {
      document,
      summary: `Copied ${sourceElements.length} element(s) from ${sourceLevelId} to ${targets.join(', ')}: ${created.length} new element(s).`,
      affected: elementAffected(document, created),
      data: { elementIds: created },
    };
  },
});
