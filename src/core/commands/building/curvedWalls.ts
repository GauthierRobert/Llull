/**
 * Curved (arc) walls: centreline arc through start, a point on the arc and end.
 * @layer core/commands/building
 */

import type { CurvedWallElement } from '../../model/building';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { vec2 } from './params';
import {
  elementAffected,
  fromMm,
  getBuilding,
  isFiniteNumber,
  nextElementId,
  nextMark,
  noChange,
  resolveLevel,
  toMetres,
  toVec2,
  withElement,
} from './model';
import { regenerateBuilding } from './evaluate';
import { curvedWallArc, curvedWallBand, curvedWallLength } from './curvedWallGeometry';

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
    'windows (add_door / add_window with its id; offset = distance along the arc).',
  params: z.object({
    start: vec2('Arc start [x, y].'),
    through: vec2('Any point on the arc between start and end [x, y] (sets the curvature).'),
    end: vec2('Arc end [x, y].'),
    thickness: z.number().optional().describe('Wall thickness. Default 200 mm.'),
    height: z.number().optional().describe('Wall height. Default: the level height.'),
    baseOffset: z.number().optional().describe('Base above the level. Default 0.'),
    material: z.string().optional().describe('Default concrete.'),
    levelId: z.string().optional().describe('Level id. Default: the active level.'),
  }),
  run: (doc, params): CommandResult => {
    const resolution = resolveLevel(doc, getBuilding(doc), params.levelId);
    if (!resolution.ok) return noChange(doc, `add_curved_wall failed: ${resolution.reason}.`);
    const thickness = params.thickness ?? fromMm(doc, 200);
    const height = params.height ?? resolution.level.height;
    const baseOffset = params.baseOffset ?? 0;
    if (
      !(isFiniteNumber(thickness) && thickness > 0) ||
      !(isFiniteNumber(height) && height > 0) ||
      !isFiniteNumber(baseOffset)
    ) {
      return noChange(doc, 'add_curved_wall failed: thickness and height must be > 0.');
    }
    const wall: CurvedWallElement = {
      id: nextElementId(resolution.building, 'curvedWall'),
      category: 'curvedWall',
      mark: nextMark(resolution.building, 'curvedWall'),
      entityIds: [],
      levelId: resolution.level.id,
      start: toVec2(params.start),
      through: toVec2(params.through),
      end: toVec2(params.end),
      thickness,
      height,
      baseOffset,
      material: params.material?.trim() || 'concrete',
    };
    const arc = curvedWallArc(wall);
    if (!arc) {
      return noChange(doc, 'add_curved_wall failed: start, through and end must not be collinear.');
    }
    if (!curvedWallBand(wall)) {
      return noChange(doc, 'add_curved_wall failed: thickness must be smaller than the diameter.');
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
