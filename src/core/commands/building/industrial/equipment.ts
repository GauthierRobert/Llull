/**
 * Process equipment (machines with maintenance clearances) and pipe runs.
 * @layer core/commands/building/industrial
 */

import type { Vec2, Vec3 } from '../../../model/types';
import type { EquipmentElement, PipeElement } from '../../../model/building';
import type { CommandDefinition, CommandResult } from '../../types';
import {
  elementAffected,
  fromMm,
  getBuilding,
  isFiniteNumber,
  isVec2,
  nextElementId,
  nextMark,
  noChange,
  resolveLevel,
  toMetres,
  toVec2,
  withElement,
} from '../model';
import { regenerateBuilding } from '../evaluate';
import { toVec3 } from './members';

interface AddEquipmentParams {
  name: string;
  location: Vec2;
  size: Vec3;
  angle?: number;
  clearance?: number;
  weight?: number;
  levelId?: string;
  mark?: string;
}

/**
 * @command add_equipment
 * @pure
 * @affects creates 1 equipment footprint (box on layer Q-EQPM; clearance drawn in plan)
 * @failure missing name / bad location / size <= 0 / clearance < 0 -> no-op
 */
export const addEquipment: CommandDefinition<AddEquipmentParams> = {
  name: 'add_equipment',
  description:
    'Place a machine / process equipment on a level: name, plan centre, size [length, width, height], ' +
    'plan rotation (radians), maintenance clearance around the footprint (checked by check_clashes) and ' +
    'operating weight in kg (for floor loads). Shown as a block in 3D and with its clearance zone in plan.',
  paramsSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Equipment name, e.g. "CNC lathe", "Compressor".' },
      location: {
        type: 'array',
        items: { type: 'number' },
        description: 'Footprint centre [x, y].',
      },
      size: {
        type: 'array',
        items: { type: 'number' },
        description: '[length (local x), width (local y), height], all > 0.',
      },
      angle: { type: 'number', description: 'Plan rotation in radians. Default 0.' },
      clearance: {
        type: 'number',
        description: 'Maintenance / operating clearance around it. Default 800 mm.',
      },
      weight: { type: 'number', description: 'Operating weight in kg. Default 0 (unknown).' },
      levelId: { type: 'string', description: 'Level id. Default: the active level.' },
      mark: { type: 'string', description: 'Equipment tag. Default EQn.' },
    },
    required: ['name', 'location', 'size'],
  },
  run: (
    doc,
    { name, location, size, angle = 0, clearance, weight = 0, levelId, mark },
  ): CommandResult => {
    const dimensions = toVec3(size);
    if (typeof name !== 'string' || name.trim() === '' || !isVec2(location)) {
      return noChange(doc, 'add_equipment failed: name and location [x, y] are required.');
    }
    if (
      !dimensions ||
      dimensions.some((value) => !(value > 0)) ||
      Array.isArray(size) === false ||
      size.length !== 3
    ) {
      return noChange(doc, 'add_equipment failed: size must be [length, width, height], all > 0.');
    }
    const resolvedClearance = clearance ?? fromMm(doc, 800);
    if (
      !isFiniteNumber(angle) ||
      !isFiniteNumber(resolvedClearance) ||
      resolvedClearance < 0 ||
      !isFiniteNumber(weight) ||
      weight < 0
    ) {
      return noChange(doc, 'add_equipment failed: angle finite, clearance >= 0 and weight >= 0.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noChange(doc, `add_equipment failed: ${resolution.reason}.`);
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
};

interface AddPipeRunParams {
  points: Vec3[];
  diameter?: number;
  service?: string;
  material?: string;
  levelId?: string;
}

/**
 * @command add_pipe_run
 * @pure
 * @affects creates 1 pipe run (segments + bends on layer P-PIPE)
 * @failure < 2 points / repeated point / diameter <= 0 -> no-op
 */
export const addPipeRun: CommandDefinition<AddPipeRunParams> = {
  name: 'add_pipe_run',
  description:
    'Route a pipe through 3D points [[x, y, z], …] (z above the level) with an outside diameter and a ' +
    'service / fluid name (compressed air, cooling water, steam, gas…). Bends are placed at every interior ' +
    'point. Pipe lengths feed the takeoff; clashes are reported by check_clashes.',
  paramsSchema: {
    type: 'object',
    properties: {
      points: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
        description: 'Pipe centreline [[x, y, z], …], at least 2 points.',
      },
      diameter: { type: 'number', description: 'Outside diameter. Default 114.3 mm (DN100).' },
      service: { type: 'string', description: 'Fluid / service. Default "process".' },
      material: { type: 'string', description: 'Default steel.' },
      levelId: { type: 'string', description: 'Level id. Default: the active level.' },
    },
    required: ['points'],
  },
  run: (doc, { points, diameter, service, material, levelId }): CommandResult => {
    const route = Array.isArray(points) ? points.map(toVec3) : [];
    if (route.length < 2 || route.some((point) => point === null)) {
      return noChange(doc, 'add_pipe_run failed: points must be ≥ 2 [x, y, z] points.');
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
      return noChange(
        doc,
        'add_pipe_run failed: consecutive points must differ and diameter be > 0.',
      );
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noChange(doc, `add_pipe_run failed: ${resolution.reason}.`);
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
};
