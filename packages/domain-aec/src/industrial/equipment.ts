/**
 * Process equipment (machines with maintenance clearances) and pipe runs.
 * @layer domain-aec
 */

import type { Vec3 } from '@core/model/types';
import type { EquipmentElement, PipeElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
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
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { regenerateBuilding } from '../evaluateElements';
import { toVec3 } from './memberSupport';

/**
 * @command add_equipment
 * @pure
 * @affects creates 1 equipment footprint (box on layer Q-EQPM; clearance drawn in plan)
 * @failure missing name / bad location / size <= 0 / clearance < 0 -> no-op
 */
export const addEquipment = defineCommand({
  name: 'add_equipment',
  description:
    'Place a machine / process equipment on a level: name, plan centre, size [length, width, height], ' +
    'plan rotation (radians), maintenance clearance around the footprint (checked by check_clashes) and ' +
    'operating weight in kg (for floor loads). Shown as a block in 3D and with its clearance zone in plan.',
  params: z.object({
    name: z.string().describe('Equipment name, e.g. "CNC lathe", "Compressor".'),
    location: z.array(z.number()).describe('Footprint centre [x, y].'),
    size: z.array(z.number()).describe('[length (local x), width (local y), height], all > 0.'),
    angle: z.number().optional().describe('Plan rotation in radians. Default 0.'),
    clearance: z
      .number()
      .optional()
      .describe('Maintenance / operating clearance around it. Default 800 mm.'),
    weight: z.number().optional().describe('Operating weight in kg. Default 0 (unknown).'),
    levelId: z.string().optional().describe('Level id. Default: the active level.'),
    mark: z.string().optional().describe('Equipment tag. Default EQn.'),
  }),
  run: (
    doc,
    { name, location, size, angle = 0, clearance, weight = 0, levelId, mark },
  ): CommandResult => {
    const dimensions = toVec3(size);
    if (name.trim() === '' || !isVec2(location)) {
      return noop(doc, 'add_equipment failed: name and location [x, y] are required.');
    }
    if (
      !dimensions ||
      dimensions.some((value) => !(value > 0)) ||
      Array.isArray(size) === false ||
      size.length !== 3
    ) {
      return noop(doc, 'add_equipment failed: size must be [length, width, height], all > 0.');
    }
    const resolvedClearance = clearance ?? fromMm(doc, 800);
    if (
      !isFiniteNumber(angle) ||
      !isFiniteNumber(resolvedClearance) ||
      resolvedClearance < 0 ||
      !isFiniteNumber(weight) ||
      weight < 0
    ) {
      return noop(doc, 'add_equipment failed: angle finite, clearance >= 0 and weight >= 0.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noop(doc, `add_equipment failed: ${resolution.reason}.`);
    const equipment: EquipmentElement = {
      id: nextElementId(resolution.building, 'equipment'),
      category: 'equipment',
      mark: mark?.trim() || nextMark(resolution.building, 'equipment'),
      entityIds: [],
      levelId: resolution.level.id,
      name: name.trim(),
      location: toVec2(location),
      angle,
      size: dimensions,
      clearance: resolvedClearance,
      weight,
    };
    const document = regenerateBuilding(doc, withElement(resolution.building, equipment));
    return {
      document,
      summary:
        `Added equipment ${equipment.mark} "${equipment.name}" (${equipment.id}) ${dimensions.join(' × ')} ${doc.units}, ` +
        `clearance ${resolvedClearance}${weight > 0 ? `, ${weight} kg` : ''}.`,
      affected: elementAffected(document, [equipment.id]),
      data: { elementId: equipment.id },
    };
  },
});

/**
 * @command add_pipe_run
 * @pure
 * @affects creates 1 pipe run (segments + bends on layer P-PIPE)
 * @failure < 2 points / repeated point / diameter <= 0 -> no-op
 */
export const addPipeRun = defineCommand({
  name: 'add_pipe_run',
  description:
    'Route a pipe through 3D points [[x, y, z], …] (z above the level) with an outside diameter and a ' +
    'service / fluid name (compressed air, cooling water, steam, gas…). Bends are placed at every interior ' +
    'point. Pipe lengths feed the takeoff; clashes are reported by check_clashes.',
  params: z.object({
    points: z
      .array(z.array(z.number()))
      .describe('Pipe centreline [[x, y, z], …], at least 2 points.'),
    diameter: z.number().optional().describe('Outside diameter. Default 114.3 mm (DN100).'),
    service: z.string().optional().describe('Fluid / service. Default "process".'),
    material: z.string().optional().describe('Default steel.'),
    levelId: z.string().optional().describe('Level id. Default: the active level.'),
  }),
  run: (doc, { points, diameter, service, material, levelId }): CommandResult => {
    const route = Array.isArray(points) ? points.map(toVec3) : [];
    if (route.length < 2 || route.some((point) => point === null)) {
      return noop(doc, 'add_pipe_run failed: points must be ≥ 2 [x, y, z] points.');
    }
    const path = route as Vec3[];
    const repeated = path.some(
      (point, index) =>
        index > 0 &&
        Math.hypot(
          ...([0, 1, 2] as const).map((axis) => point[axis] - (path[index - 1] as Vec3)[axis]),
        ) === 0,
    );
    const resolvedDiameter = diameter ?? fromMm(doc, 114.3);
    if (repeated || !isFiniteNumber(resolvedDiameter) || resolvedDiameter <= 0) {
      return noop(doc, 'add_pipe_run failed: consecutive points must differ and diameter be > 0.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noop(doc, `add_pipe_run failed: ${resolution.reason}.`);
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
    };
    const document = regenerateBuilding(doc, withElement(resolution.building, pipe));
    const length = path.reduce(
      (sum, point, index) =>
        index === 0
          ? 0
          : sum +
            Math.hypot(
              ...([0, 1, 2] as const).map((axis) => point[axis] - (path[index - 1] as Vec3)[axis]),
            ),
      0,
    );
    return {
      document,
      summary: `Added ${pipe.service} pipe ${pipe.mark} (${pipe.id}) Ø${resolvedDiameter}, ${toMetres(doc, length).toFixed(2)} m, ${path.length - 2} bend(s).`,
      affected: elementAffected(document, [pipe.id]),
      data: { elementId: pipe.id },
    };
  },
});
