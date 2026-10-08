/**
 * Curved (arc) walls: centreline arc through start, a point on the arc and end.
 * @layer domain-aec
 */

import type { CurvedWallElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import {
  elementAffected,
  fromMm,
  getBuilding,
  nextElementId,
  nextMark,
  resolveLevel,
  toMetres,
  withElement,
} from './model';
import { noop } from '@core/commands/noop';
import { duplicateSummary, findTwin, samePoint, sameSegment } from './duplicates';
import { regenerateBuilding } from './evaluateElements';
import { curvedWallArc, curvedWallBand, curvedWallLength } from './curvedWallGeometry';
import { levelIdParam } from './levelParams';

/**
 * @command add_curved_wall
 * @pure
 * @affects creates 1 curved wall (mesh on layer A-WALL)
 * @failure collinear points / thickness >= diameter / sizes <= 0 -> no-op
 */
export const addCurvedWall = defineCommand({
  name: 'add_curved_wall',
  description:
    'Add a curved (arc) wall on a level: its centreline is the circular arc from start through a point ' +
    'on the arc to end (all [x, y]). Thickness, height (default: level height), base offset and ' +
    'material as for add_wall. Counted with the walls in quantities and schedules. Hosts doors and ' +
    'windows (add_door / add_window with its id; offset = distance along the arc). Refused if the same ' +
    'arc (either direction) and base offset already exists on the level.',
  params: z.object({
    start: vec2('Arc start [x, y].'),
    through: vec2('Any point on the arc between start and end [x, y] (sets the curvature).'),
    end: vec2('Arc end [x, y].'),
    thickness: z.number().optional().describe('Wall thickness, in document units. Default 200 mm.'),
    height: z.number().optional().describe('Wall height. Default: the level height.'),
    baseOffset: z.number().optional().describe('Base above the level. Default 0.'),
    material: z.string().optional().describe('Default concrete.'),
    levelId: levelIdParam,
  }),
  run: (doc, params): CommandResult => {
    const resolution = resolveLevel(doc, getBuilding(doc), params.levelId);
    if (!resolution.ok) return noop(doc, `add_curved_wall failed: ${resolution.reason}.`);
    const thickness = params.thickness ?? fromMm(doc, 200);
    const height = params.height ?? resolution.level.height;
    if (thickness <= 0 || height <= 0) {
      return noop(doc, 'add_curved_wall failed: thickness and height must be > 0.');
    }
    const wall: CurvedWallElement = {
      id: nextElementId(resolution.building, 'curvedWall'),
      category: 'curvedWall',
      mark: nextMark(resolution.building, 'curvedWall'),
      entityIds: [],
      levelId: resolution.level.id,
      start: params.start,
      through: params.through,
      end: params.end,
      thickness,
      height,
      baseOffset: params.baseOffset ?? 0,
      material: params.material?.trim() || 'concrete',
    };
    const arc = curvedWallArc(wall);
    if (!arc) {
      return noop(doc, 'add_curved_wall failed: start, through and end must not be collinear.');
    }
    if (!curvedWallBand(wall)) {
      return noop(doc, 'add_curved_wall failed: thickness must be smaller than the diameter.');
    }
    const twin = findTwin(
      resolution.building,
      'curvedWall',
      resolution.level.id,
      (element) =>
        element.baseOffset === wall.baseOffset &&
        samePoint(element.through, wall.through) &&
        sameSegment(element.start, element.end, wall.start, wall.end),
    );
    if (twin) {
      return noop(doc, duplicateSummary('add_curved_wall', twin, 'a curved wall on this arc'));
    }
    const document = regenerateBuilding(doc, withElement(resolution.building, wall));
    return {
      document,
      summary: `Added curved wall ${wall.mark} (${wall.id}): radius ${arc.radius.toFixed(1)}, ${((Math.abs(arc.sweep) * 180) / Math.PI).toFixed(1)}°, length ${toMetres(doc, curvedWallLength(wall)).toFixed(2)} m, ${thickness} thick, ${height} high.`,
      affected: elementAffected(document, [wall.id]),
      data: { elementId: wall.id, radius: arc.radius },
    };
  },
});
