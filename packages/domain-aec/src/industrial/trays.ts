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
import { duplicateSummary, findTwin, samePath } from '../duplicates';
import { regenerateBuilding } from '../evaluateElements';
import { MAX_ROUTE_POINTS, hasRepeatedPoint, parseRoute, routeLength } from './routeSupport';
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
      .describe('Tray centreline [[x, y, z], …], 2 to 1000 points.'),
    width: z.number().optional().describe('Tray width, in document units. Default 300 mm.'),
    height: z.number().optional().describe('Side height, in document units. Default 60 mm.'),
    system: z.string().optional().describe('Cable system. Default "power".'),
    levelId: levelIdParam,
  }),
  run: (doc, { points, width, height, system, levelId }): CommandResult => {
    const path = parseRoute(points);
    if (!path) return noop(doc, 'add_cable_tray failed: points must be ≥ 2 [x, y, z] points.');
    if (path.length > MAX_ROUTE_POINTS) {
      return noop(
        doc,
        `add_cable_tray failed: at most ${MAX_ROUTE_POINTS} points per run (got ${path.length}); split the run.`,
      );
    }
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
    const trayTwin = findTwin(
      resolution.building,
      'tray',
      resolution.level.id,
      (element) =>
        element.width === resolvedWidth &&
        element.height === resolvedHeight &&
        samePath(element.points, path),
    );
    if (trayTwin) {
      return noop(doc, duplicateSummary('add_cable_tray', trayTwin, 'a cable tray on this route'));
    }
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
