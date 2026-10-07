/**
 * Cable trays (electrical / data cable carriers): open U sections routed through 3D points.
 * @layer domain-aec
 */

import type { CableTrayElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import {
  elementAffected,
  fromMm,
  getBuilding,
  nextElementId,
  nextMark,
  resolveLevel,
  toMetres,
  withElement,
} from '../model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from '../evaluateElements';
import { hasRepeatedPoint, parseRoute, routeLength } from './routeSupport';
import { levelIdParam } from '../levelParams';

export const trayLength = (tray: CableTrayElement): number => routeLength(tray.points);

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
    levelId: levelIdParam,
  }),
  run: (doc, { points, width, height, system, levelId }): CommandResult => {
    const path = parseRoute(points);
    if (!path) return noop(doc, 'add_cable_tray failed: points must be ≥ 2 [x, y, z] points.');
    const resolvedWidth = width ?? fromMm(doc, 300);
    const resolvedHeight = height ?? fromMm(doc, 60);
    if (hasRepeatedPoint(path) || !(resolvedWidth > 0) || !(resolvedHeight > 0)) {
      return noop(
        doc,
        'add_cable_tray failed: consecutive points must differ, width and height be > 0.',
      );
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noop(doc, `add_cable_tray failed: ${resolution.reason}.`);
    const tray: CableTrayElement = {
      id: nextElementId(resolution.building, 'tray'),
      category: 'tray',
      mark: nextMark(resolution.building, 'tray'),
      entityIds: [],
      levelId: resolution.level.id,
      points: path,
      width: resolvedWidth,
      height: resolvedHeight,
      system: system?.trim() || 'power',
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
