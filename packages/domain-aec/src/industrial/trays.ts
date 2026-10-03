/**
 * Cable trays (electrical / data cable carriers): open U sections routed through 3D points.
 * @layer domain-aec
 */

import type { CableTrayElement } from '@core/model/building';
import type { Vec3 } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
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
  withElement,
} from '../model';
import { regenerateBuilding } from '../evaluateElements';
import { toVec3 } from './memberSupport';

export function trayLength(tray: CableTrayElement): number {
  return tray.points.reduce((sum, point, index) => {
    const previous = tray.points[index - 1];
    return previous
      ? sum + Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2])
      : sum;
  }, 0);
}

/**
 * @command add_cable_tray
 * @pure
 * @affects creates 1 cable tray run (U-section segments on layer E-TRAY)
 * @failure < 2 points / repeated point / width or height <= 0 -> no-op
 */
export const addCableTray = defineCommand({
  name: 'add_cable_tray',
  description:
    'Route a cable tray (open U section) through 3D points [[x, y, z], …] (z = tray centre above the ' +
    'level) with a width, side height and cable system (power, data, instrumentation…). Lengths feed ' +
    'the takeoff; clashes with steel, pipes and equipment are reported by check_clashes.',
  params: z.object({
    points: z
      .array(z.array(z.number()))
      .describe('Tray centreline [[x, y, z], …], at least 2 points.'),
    width: z.number().optional().describe('Tray width. Default 300 mm.'),
    height: z.number().optional().describe('Side height. Default 60 mm.'),
    system: z.string().optional().describe('Cable system. Default "power".'),
    levelId: z.string().optional().describe('Level id. Default: the active level.'),
  }),
  run: (doc, { points, width, height, system, levelId }): CommandResult => {
    const route = Array.isArray(points) ? points.map(toVec3) : [];
    if (route.length < 2 || route.some((point) => point === null)) {
      return noChange(doc, 'add_cable_tray failed: points must be ≥ 2 [x, y, z] points.');
    }
    const path = route as Vec3[];
    const repeated = path.some((point, index) => {
      const previous = path[index - 1];
      return (
        previous !== undefined &&
        point[0] === previous[0] &&
        point[1] === previous[1] &&
        point[2] === previous[2]
      );
    });
    const resolvedWidth = width ?? fromMm(doc, 300);
    const resolvedHeight = height ?? fromMm(doc, 60);
    if (
      repeated ||
      !(isFiniteNumber(resolvedWidth) && resolvedWidth > 0) ||
      !(isFiniteNumber(resolvedHeight) && resolvedHeight > 0)
    ) {
      return noChange(
        doc,
        'add_cable_tray failed: consecutive points must differ, width and height be > 0.',
      );
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noChange(doc, `add_cable_tray failed: ${resolution.reason}.`);
    const tray: CableTrayElement = {
      id: nextElementId(resolution.building, 'tray'),
      category: 'tray',
      mark: nextMark(resolution.building, 'tray'),
      entityIds: [],
      levelId: resolution.level.id,
      points: path,
      width: resolvedWidth,
      height: resolvedHeight,
      system: typeof system === 'string' && system.trim() !== '' ? system.trim() : 'power',
    };
    const document = regenerateBuilding(doc, withElement(resolution.building, tray));
    return {
      document,
      summary: `Added ${tray.system} cable tray ${tray.mark} (${tray.id}) ${resolvedWidth}×${resolvedHeight}, ${toMetres(doc, trayLength(tray)).toFixed(2)} m.`,
      affected: elementAffected(document, [tray.id]),
      data: { elementId: tray.id },
    };
  },
});
