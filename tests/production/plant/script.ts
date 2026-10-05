import { getCommand } from '@core/commands/registry';
import type { Vec2 } from '@core/model/types';
import type { ToolCall } from '../contract';
import { levelId, type IntentEquipment, type PlantIntent } from './intent';

/**
 * @layer tests/production/plant
 *
 * The tool calls a competent engineer makes to model a plant intent, on an empty document.
 * Ids it refers to (`level-n`, `slab-n`, `stair-n`) are the ones llull mints in creation order.
 */

/** Grating cut-out around equipment passing through a floor (toe-plate margin). */
export const OPENING_MARGIN = 300;

const rel = (intent: PlantIntent, level: number, z: number): number =>
  z - (intent.levels[level]?.elevation ?? 0);

export function openingAround(equipment: IntentEquipment, margin = OPENING_MARGIN): Vec2[] {
  const [cx, cy] = equipment.location;
  const hx = equipment.size[0] / 2 + margin;
  const hy = equipment.size[1] / 2 + margin;
  return [
    [cx - hx, cy - hy],
    [cx + hx, cy - hy],
    [cx + hx, cy + hy],
    [cx - hx, cy + hy],
  ];
}

/** Floors an equipment passes through: FFL strictly between its base and top. */
export function floorsCrossed(intent: PlantIntent, equipment: IntentEquipment): number[] {
  const base = intent.levels[equipment.level]?.elevation ?? 0;
  const top = base + equipment.size[2];
  return intent.floors
    .map((floor, index) => ({ index, elevation: intent.levels[floor.level]?.elevation ?? 0 }))
    .filter(({ elevation }) => elevation > base && elevation < top)
    .map(({ index }) => index);
}

export function plantScript(intent: PlantIntent): ToolCall[] {
  const calls: ToolCall[] = [{ tool: 'set_project_info', args: { ...intent.project } }];
  for (const level of intent.levels) {
    calls.push({ tool: 'add_level', args: { ...level, makeActive: false } });
  }
  calls.push({ tool: 'add_grid_system', args: { ...intent.grid } });
  for (const member of intent.members) {
    const z = (point: readonly number[]): number[] => [
      point[0] ?? 0,
      point[1] ?? 0,
      rel(intent, member.level, point[2] ?? 0),
    ];
    calls.push({
      tool: 'add_steel_member',
      args: {
        role: member.role,
        profile: member.profile,
        start: z(member.start),
        end: z(member.end),
        levelId: levelId(member.level),
        ...(member.roll !== undefined ? { roll: member.roll } : {}),
        ...(member.startJoint !== undefined ? { startJoint: member.startJoint } : {}),
        ...(member.endJoint !== undefined ? { endJoint: member.endJoint } : {}),
        ...(member.baseFixity !== undefined ? { baseFixity: member.baseFixity } : {}),
      },
    });
  }
  for (const floor of intent.floors) {
    calls.push({
      tool: 'add_slab',
      args: {
        levelId: levelId(floor.level),
        boundary: floor.boundary,
        thickness: floor.thickness,
        material: floor.material,
      },
    });
  }
  for (const equipment of intent.equipment) {
    calls.push({
      tool: 'add_equipment',
      args: {
        mark: equipment.tag,
        name: equipment.name,
        levelId: levelId(equipment.level),
        location: equipment.location,
        size: equipment.size,
        weight: equipment.weight,
        clearance: equipment.clearance,
      },
    });
    for (const floorIndex of floorsCrossed(intent, equipment)) {
      calls.push({
        tool: 'add_slab_opening',
        args: { slabId: `slab-${floorIndex + 1}`, boundary: openingAround(equipment) },
      });
    }
  }
  intent.stairs.forEach((stair, index) => {
    calls.push({
      tool: 'add_stair',
      args: {
        levelId: levelId(stair.level),
        start: stair.start,
        angle: stair.angle,
        width: stair.width,
      },
    });
    calls.push({ tool: 'add_slab_opening', args: { stairId: `stair-${index + 1}` } });
  });
  for (const pipe of intent.pipes) {
    calls.push({
      tool: 'add_pipe_run',
      args: {
        levelId: levelId(0),
        points: pipe.route.map((point) => [point[0], point[1], rel(intent, 0, point[2])]),
        line: pipe.line,
        dn: pipe.dn,
        from: pipe.from,
        to: pipe.to,
        service: pipe.service,
      },
    });
  }
  for (const tray of intent.trays ?? []) {
    calls.push({
      tool: 'add_cable_tray',
      args: {
        levelId: levelId(0),
        points: tray.route.map((point) => [point[0], point[1], rel(intent, 0, point[2])]),
        width: tray.width,
        height: tray.height,
        system: tray.system,
      },
    });
  }
  for (const support of intent.supports ?? []) {
    calls.push({
      tool: 'add_pipe_support',
      args: { line: support.line, type: support.type, at: support.at },
    });
  }
  calls.push({ tool: 'check_clashes', args: {} });
  return calls;
}

/**
 * Feature-history step id of `calls[index]`, assuming every earlier mutating call changed the
 * document (true for a script that runs clean): queries and history meta-commands record no step.
 */
export function stepIdOf(calls: ToolCall[], index: number): string {
  let steps = 0;
  for (let i = 0; i <= index; i++) {
    const annotations = getCommand(calls[i]?.tool ?? '')?.annotations;
    if (annotations?.readOnly !== true && annotations?.metaHistory !== true) steps++;
  }
  return `step-${steps}`;
}
