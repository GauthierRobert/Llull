/**
 * Process equipment (machines with maintenance clearances) and pipe runs.
 * @layer domain-aec
 */

import type { EquipmentElement, PipeElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, looseVec2, vec3, z } from '@core/commands/schema';
import {
  elementAffected,
  fromMm,
  getBuilding,
  isVec2,
  nextElementId,
  nextMark,
  resolveLevel,
  toMetres,
  toVec2,
  withElement,
} from '../model';
import { noop } from '@core/commands/noop';
import { duplicateSummary, findTwin, samePath } from '../duplicates';
import { regenerateBuilding } from '../evaluateElements';
import {
  SHAPE_PARAM_TEXT,
  describeEquipmentShape,
  equipmentShapeSchema,
  normaliseEquipmentSize,
} from './equipmentShape';
import { PIPE_OUTSIDE_DIAMETER_MM, outsideDiameterMm } from './pipeSizes';
import { hasRepeatedPoint, routeLength, routeOrFailure } from './routeSupport';
import { levelIdParam } from '../levelParams';

/**
 * @command add_equipment
 * @pure
 * @affects creates 1 equipment (box or cylindrical vessel on layer Q-EQPM; clearance drawn in plan)
 * @invariant vessel `size` is normalised to its bounding box; shape absent = box
 * @failure missing name / bad location / size <= 0 / clearance < 0 -> no-op
 */
export const addEquipment = defineCommand({
  name: 'add_equipment',
  description:
    'Place a machine / process equipment on a level: name, plan centre, size [length, width, height], ' +
    'plan rotation (radians), maintenance clearance around the footprint (checked by check_clashes) and ' +
    'operating weight in kg (for floor loads). Optional `shape` makes it a cylindrical vessel (vertical or ' +
    'horizontal). Shown as a block / cylinder in 3D and with its clearance zone in plan. An explicit `mark` ' +
    'must be unique among equipment.',
  params: z.object({
    name: z.string().describe('Equipment name, e.g. "CNC lathe", "Compressor".'),
    location: looseVec2('Footprint centre [x, y] (a trailing z is ignored).'),
    size: vec3(
      'Three numbers. box: [length (local x), width (local y), height], all > 0. vertical_vessel: ' +
        '[diameter, ignored, height]. horizontal_vessel: [length along local x, diameter, ignored].',
    ),
    shape: equipmentShapeSchema.optional().describe(SHAPE_PARAM_TEXT),
    angle: z.number().optional().describe('Plan rotation in radians. Default 0.'),
    clearance: z
      .number()
      .optional()
      .describe('Maintenance / operating clearance around it, in document units. Default 800 mm.'),
    weight: z.number().optional().describe('Operating weight in kg. Default 0 (unknown).'),
    levelId: levelIdParam,
    mark: z
      .string()
      .optional()
      .describe('Equipment tag, unique among equipment (duplicates are refused). Default EQn.'),
  }),
  run: (
    doc,
    { name, location, size, shape = 'box', angle = 0, clearance, weight = 0, levelId, mark },
  ): CommandResult => {
    if (name.trim() === '') return noop(doc, 'add_equipment failed: name is required.');
    if (!isVec2(location)) {
      return noop(doc, 'add_equipment failed: location must be [x, y] with finite numbers.');
    }
    const dimensions = normaliseEquipmentSize(shape, size);
    if (!dimensions) {
      return noop(
        doc,
        `add_equipment failed: size must be 3 numbers valid for shape ${shape} (box: all > 0; vertical_vessel: diameter and height > 0; horizontal_vessel: length and diameter > 0).`,
      );
    }
    const resolvedClearance = clearance ?? fromMm(doc, 800);
    if (resolvedClearance < 0 || weight < 0) {
      return noop(doc, 'add_equipment failed: clearance >= 0 and weight >= 0.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noop(doc, `add_equipment failed: ${resolution.reason}.`);
    const requestedMark = mark?.trim();
    const taken = Object.values(resolution.building.elements).find(
      (element) => element.category === 'equipment' && element.mark === requestedMark,
    );
    if (requestedMark && taken) {
      return noop(
        doc,
        `add_equipment failed: tag '${requestedMark}' is already used by ${taken.id}; line-list from/to references need unique tags.`,
      );
    }
    const equipment: EquipmentElement = {
      id: nextElementId(resolution.building, 'equipment'),
      category: 'equipment',
      mark: requestedMark || nextMark(resolution.building, 'equipment'),
      entityIds: [],
      levelId: resolution.level.id,
      name: name.trim(),
      location: toVec2(location),
      angle,
      size: dimensions,
      ...(shape !== 'box' ? { shape } : {}),
      clearance: resolvedClearance,
      weight,
    };
    const document = regenerateBuilding(doc, withElement(resolution.building, equipment));
    return {
      document,
      summary:
        `Added equipment ${equipment.mark} "${equipment.name}" (${equipment.id}) ${describeEquipmentShape(shape, dimensions, doc.units)}, ` +
        `clearance ${resolvedClearance}${weight > 0 ? `, ${weight} kg` : ''}.`,
      affected: elementAffected(document, [equipment.id]),
      data: { elementId: equipment.id },
    };
  },
});

/**
 * @command add_pipe_run
 * @pure
 * @affects creates 1 pipe run (segments + bends on layer P-PIPE) carrying its line-list data
 * @invariant diameter from `diameter`, else the DN outside-diameter table, else 114.3 mm (DN100)
 * @failure < 2 points / repeated point / diameter <= 0 / invalid or unknown DN without diameter -> no-op
 */
export const addPipeRun = defineCommand({
  name: 'add_pipe_run',
  description:
    'Route a pipe through 3D points [[x, y, z], …] (z above the level) with a service / fluid name ' +
    '(compressed air, cooling water, steam, gas…) and line-list data: line number, nominal size DN and ' +
    'from / to ends. Give `dn` (e.g. 100) and the outside diameter is taken from the EN 10220 / ASME ' +
    'B36.10 table (15…400); `diameter` overrides it. Bends are placed at every interior point. ' +
    'Pipe lengths feed the takeoff; the pipe schedule (building_schedule kind "pipe") is the line list; ' +
    'clashes are reported by check_clashes. Support it with add_pipe_support and verify the spacing with check_pipe_supports. ' +
    'Refused if a pipe of the same diameter already follows the same route (either direction) on the level.',
  params: z.object({
    points: z
      .array(z.array(z.number()))
      .describe('Pipe centreline [[x, y, z], …], 2 to 1000 points.'),
    diameter: z
      .number()
      .optional()
      .describe(
        'Outside diameter in document units. Default: from `dn` when given, else 114.3 mm (DN100).',
      ),
    dn: z
      .number()
      .optional()
      .describe(
        'Nominal size DN as an integer, e.g. 100. Tabulated: 15, 20, 25, 32, 40, 50, 65, 80, 100, 125, ' +
          '150, 200, 250, 300, 350, 400. Sets the outside diameter when `diameter` is omitted (an ' +
          'untabulated DN then needs an explicit `diameter`). Printed "DN100" in the line list.',
      ),
    line: z.string().optional().describe('Line number for the line list, e.g. "L-101".'),
    from: z
      .string()
      .optional()
      .describe(
        'Line origin: equipment tag (e.g. "EQ1") or battery-limit / tie-in id (e.g. "BL-1").',
      ),
    to: z
      .string()
      .optional()
      .describe('Line destination: equipment tag or battery-limit / tie-in id.'),
    service: z.string().optional().describe('Fluid / service. Default "process".'),
    material: z.string().optional().describe('Pipe material. Default "steel".'),
    levelId: levelIdParam,
  }),
  run: (
    doc,
    { points, diameter, dn, line, from, to, service, material, levelId },
  ): CommandResult => {
    const path = routeOrFailure('add_pipe_run', points, 'line');
    if (typeof path === 'string') return noop(doc, path);
    if (dn !== undefined && !(Number.isInteger(dn) && dn > 0)) {
      return noop(doc, `add_pipe_run failed: dn must be a positive integer (got ${dn}).`);
    }
    const tabulated = dn !== undefined ? outsideDiameterMm(dn) : null;
    if (diameter === undefined && dn !== undefined && tabulated === null) {
      const known = Object.keys(PIPE_OUTSIDE_DIAMETER_MM).join(', ');
      return noop(
        doc,
        `add_pipe_run failed: DN${dn} is not in the pipe size table (${known}); give an explicit diameter.`,
      );
    }
    const resolvedDiameter = diameter ?? fromMm(doc, tabulated ?? 114.3);
    if (hasRepeatedPoint(path) || resolvedDiameter <= 0) {
      return noop(doc, 'add_pipe_run failed: consecutive points must differ and diameter be > 0.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noop(doc, `add_pipe_run failed: ${resolution.reason}.`);
    const pipeTwin = findTwin(
      resolution.building,
      'pipe',
      resolution.level.id,
      (element) => element.diameter === resolvedDiameter && samePath(element.points, path),
    );
    if (pipeTwin)
      return noop(doc, duplicateSummary('add_pipe_run', pipeTwin, 'a pipe on this route'));
    const text = (value: string | undefined): string | undefined => value?.trim() || undefined;
    const [lineNumber, origin, destination] = [text(line), text(from), text(to)];
    const pipe: PipeElement = {
      id: nextElementId(resolution.building, 'pipe'),
      category: 'pipe',
      mark: nextMark(resolution.building, 'pipe'),
      entityIds: [],
      levelId: resolution.level.id,
      points: path,
      diameter: resolvedDiameter,
      service: service?.trim() || 'process',
      material: material?.trim() || 'steel',
      ...(lineNumber !== undefined ? { line: lineNumber } : {}),
      ...(dn !== undefined ? { dn } : {}),
      ...(origin !== undefined ? { from: origin } : {}),
      ...(destination !== undefined ? { to: destination } : {}),
    };
    const document = regenerateBuilding(doc, withElement(resolution.building, pipe));
    const length = routeLength(path);
    const label = `${lineNumber !== undefined ? ` line ${lineNumber}` : ''}${dn !== undefined ? ` DN${dn}` : ''}`;
    const ends = origin !== undefined || destination !== undefined;
    return {
      document,
      summary:
        `Added ${pipe.service} pipe ${pipe.mark} (${pipe.id})${label} Ø${resolvedDiameter}, ` +
        `${toMetres(doc, length).toFixed(2)} m, ${path.length - 2} bend(s)` +
        `${ends ? `, ${origin ?? '?'} → ${destination ?? '?'}` : ''}.`,
      affected: elementAffected(document, [pipe.id]),
      data: { elementId: pipe.id },
    };
  },
});
