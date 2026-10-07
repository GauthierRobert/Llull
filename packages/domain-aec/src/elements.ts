/**
 * Rooms, and generic edits on any building element (delete, move, copy to levels).
 * @layer domain-aec
 */

import type { Vec2, Vec3 } from '@core/model/types';
import type { BuildingElement, BuildingModel, RoomElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import { isValidPolygon, polygonArea } from '@lib/polygon';
import {
  getBuilding,
  hostOf,
  nextElementId,
  nextMark,
  orderedElements,
  elementsOf,
  resolveLevel,
  toMetres,
  withElement,
  elementAffected,
  followLevelHeight,
  withDependents,
  withoutElements,
} from './model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from './evaluateElements';
import { resolveOutline } from './structure';
import { openingFitIssues } from './walls';
import { nextMemberMark } from './industrial/memberSupport';
import { copyPipeSupports } from './industrial/pipeSupportCopy';
import { reconcilePipeSupports, reconciliationNote } from './industrial/pipeSupportAttach';
import { levelIdParam } from './levelParams';

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
    levelId: levelIdParam,
  }),
  run: (doc, { name, number, boundary, wallIds, levelId }): CommandResult => {
    if (name.trim() === '') {
      return noop(doc, 'add_room failed: name is required.');
    }
    const building = getBuilding(doc);
    const { outline, wallLevelId, failure } = resolveOutline(
      building,
      { boundary, wallIds },
      (half) => -half,
    );
    if (failure) return noop(doc, `add_room failed: ${failure}.`);
    if (!outline || !isValidPolygon(outline)) {
      return noop(
        doc,
        'add_room failed: give a boundary of ≥ 3 non-collinear [x, y] points, or wallIds forming a closed loop.',
      );
    }
    const resolution = resolveLevel(doc, building, levelId ?? wallLevelId);
    if (!resolution.ok) return noop(doc, `add_room failed: ${resolution.reason}.`);
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

const ignoredNote = (ids: ReadonlyArray<string>): string =>
  ids.length > 0 ? ` Ignored unknown id(s): ${[...new Set(ids)].join(', ')}.` : '';

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
    'grid axes). Deleting a wall also deletes its doors and windows; joined walls are re-trimmed. Deleting a ' +
    'steel member re-attaches the pipe supports bearing on it to the nearest steel in reach, or leaves them ' +
    'unattached (the summary says which).',
  params: z.object({
    elementIds: z.array(z.string()).describe('Element ids, e.g. ["wall-2", "door-1"].'),
  }),
  run: (doc, { elementIds }): CommandResult => {
    const building = getBuilding(doc);
    const known = elementIds.filter((id) => building.elements[id] !== undefined);
    if (known.length === 0) {
      return noop(doc, 'delete_building_element: none of the given ids is a building element.');
    }
    const ignored = elementIds.filter((id) => building.elements[id] === undefined);
    const doomed = withDependents(building, known);
    const removedEntityIds = [...doomed].flatMap((id) => building.elements[id]?.entityIds ?? []);
    const supports = reconcilePipeSupports(doc, withoutElements(building, doomed));
    return {
      document: regenerateBuilding(doc, supports.building),
      summary: `Deleted ${doomed.size} building element(s): ${[...doomed].join(', ')}.${ignoredNote(ignored)}${reconciliationNote(supports)}`,
      affected: [
        ...doomed,
        ...removedEntityIds,
        ...[...supports.reattached, ...supports.detached].map((change) => change.id),
      ],
    };
  },
});

function translated(element: BuildingElement, dx: number, dy: number): BuildingElement {
  const shift = (point: Vec2): Vec2 => [point[0] + dx, point[1] + dy];
  const shift3 = ([x, y, z]: Vec3): Vec3 => [x + dx, y + dy, z];
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
      return { ...element, start: shift3(element.start), end: shift3(element.end) };
    case 'footing':
    case 'equipment':
      return { ...element, location: shift(element.location) };
    case 'panel':
      return { ...element, corners: element.corners.map(shift3) };
    case 'pipe':
    case 'tray':
      return { ...element, points: element.points.map(shift3) };
    case 'pipeSupport':
      return { ...element, position: shift3(element.position) };
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
    'an opening along its wall use update_opening). Corner joins are recomputed. A moved pipe takes its pipe ' +
    'supports along and a moved steel member makes its supports re-check their reach: they re-attach to the ' +
    'steel at the new position or become unattached (the summary says which).',
  params: z.object({
    elementIds: z.array(z.string()).describe('Element ids to move.'),
    delta: vec2('Plan translation [dx, dy].'),
  }),
  run: (doc, { elementIds, delta }): CommandResult => {
    const building = getBuilding(doc);
    const known = [...new Set(elementIds)].filter((id) => building.elements[id] !== undefined);
    if (known.length === 0) {
      return noop(doc, 'move_building_element: none of the given ids is a building element.');
    }
    if (delta[0] === 0 && delta[1] === 0) {
      return noop(doc, 'move_building_element: delta is [0, 0]; nothing to move.');
    }
    const ignored = elementIds.filter((id) => building.elements[id] === undefined);
    const strayOpenings = known.filter((id) => {
      const element = building.elements[id];
      const host = element ? hostOf(element) : null;
      return host !== null && !known.includes(host);
    });
    if (strayOpenings.length > 0) {
      return noop(
        doc,
        `move_building_element refused: ${strayOpenings.join(', ')} follow their host (a wall, a steel column or a rafter) — slide openings with update_opening (offset) or move the host.`,
      );
    }
    // Moving only one side of a moment connection would leave it floating.
    const detached = Object.values(building.elements).filter(
      (element) =>
        element.category === 'connection' &&
        known.includes(element.otherId) !== known.includes(element.rafterId),
    );
    if (detached.length > 0) {
      return noop(
        doc,
        `move_building_element refused: moment connection(s) ${detached.map((element) => element.id).join(', ')} join a moved member to a member that is not moved — move both members, or delete the connections first.`,
      );
    }
    let next = building;
    // Pipe supports carry their own position: they travel with their moved pipe.
    const travelling = [
      ...known,
      ...Object.values(building.elements).flatMap((element) =>
        element.category === 'pipeSupport' &&
        known.includes(element.pipeId) &&
        !known.includes(element.id)
          ? [element.id]
          : [],
      ),
    ];
    for (const id of travelling) {
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
    if (issues.length > 0) return noop(doc, `move_building_element refused: ${issues[0]}.`);
    const supports = reconcilePipeSupports(doc, next);
    const document = regenerateBuilding(doc, supports.building);
    const moved = withDependents(building, known);
    return {
      document,
      summary: `Moved ${known.length} element(s) by [${delta[0]}, ${delta[1]}]: ${known.join(', ')}.${ignoredNote(ignored)}${reconciliationNote(supports)}`,
      affected: elementAffected(document, [
        ...moved,
        ...[...supports.reattached, ...supports.detached].map((change) => change.id),
      ]),
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

export const COPYABLE = [
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
    'to some categories. Copied pipes bring their pipe supports, re-attached to the steel found at their new ' +
    'position (unattached when none is in reach).',
  params: z.object({
    sourceLevelId: z.string().describe('Level to copy from.'),
    targetLevelIds: z.array(z.string()).describe('Levels to copy to.'),
    categories: z
      .array(z.enum(COPYABLE))
      .optional()
      .describe(`Subset of categories to copy (${COPYABLE.join(', ')}). Default all.`),
  }),
  run: (doc, { sourceLevelId, targetLevelIds: requestedTargetIds, categories }): CommandResult => {
    const building = getBuilding(doc);
    const missing = [sourceLevelId, ...requestedTargetIds].filter((id) => !building.levels[id]);
    if (missing.length > 0 || requestedTargetIds.length === 0) {
      return noop(
        doc,
        `copy_level_elements failed: unknown or missing level(s) ${missing.join(', ') || '(no targets)'}.`,
      );
    }
    const targetLevelIds = [...new Set(requestedTargetIds)].filter((id) => id !== sourceLevelId);
    if (targetLevelIds.length === 0) {
      return noop(
        doc,
        `copy_level_elements: every target level is the source level ${sourceLevelId}; nothing to copy.`,
      );
    }
    // Hosted elements (doors, windows, base plates) are copied with their host only.
    const allowed = new Set<string>(
      categories !== undefined && categories.length > 0 ? categories : COPYABLE,
    );
    const allElements = orderedElements(building);
    const sourceElements = allElements.filter(
      (element): element is Exclude<BuildingElement, { category: 'grid' | 'door' | 'window' }> =>
        'levelId' in element && element.levelId === sourceLevelId && allowed.has(element.category),
    );
    if (sourceElements.length === 0) {
      return noop(doc, `copy_level_elements: level ${sourceLevelId} has nothing to copy.`);
    }
    const sourceHeight = building.levels[sourceLevelId]?.height ?? 0;
    let next = building;
    const created: string[] = [];
    for (const targetLevelId of targetLevelIds) {
      const levelIndex = next.levelOrder.indexOf(targetLevelId);
      const targetHeight = next.levels[targetLevelId]?.height ?? sourceHeight;
      const copiedIds = new Map<string, string>();
      for (const element of sourceElements) {
        const id = nextElementId(next, element.category);
        const mark =
          element.category === 'room'
            ? copiedRoomNumber(next, element.mark, levelIndex)
            : element.category === 'member'
              ? nextMemberMark(next, element.role)
              : nextMark(next, element.category);
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
        for (const hosted of allElements) {
          if (
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
      for (const connection of elementsOf(building, 'connection')) {
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
      const copiedSupports = copyPipeSupports(building, next, copiedIds, targetLevelId);
      next = copiedSupports.building;
      created.push(...copiedSupports.ids);
    }
    const issues = openingFitIssues(next, new Set(targetLevelIds));
    if (issues.length > 0) return noop(doc, `copy_level_elements refused: ${issues[0]}.`);
    const supports = reconcilePipeSupports(
      doc,
      next,
      created.filter((id) => next.elements[id]?.category === 'pipeSupport'),
    );
    const document = regenerateBuilding(doc, supports.building);
    return {
      document,
      summary: `Copied ${sourceElements.length} element(s) from ${sourceLevelId} to ${targetLevelIds.join(', ')}: ${created.length} new element(s).${reconciliationNote(supports)}`,
      affected: elementAffected(document, created),
      data: { elementIds: created },
    };
  },
});
