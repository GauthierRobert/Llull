/**
 * Building regeneration: evaluates every element into entities and replaces the stale ones.
 * @layer domain-aec
 */

import type { CadDocument, Entity } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import type {
  BuildingElement,
  BuildingModel,
  GridElement,
  OpeningElement,
  SteelMemberElement,
} from '@core/model/building';
import { curvedWallExtent, tangentWall } from './curvedWallGeometry';
import {
  evaluateEquipment,
  evaluateFooting,
  evaluateMember,
  evaluatePanel,
  evaluatePipe,
  evaluateTray,
} from './industrial/evaluate';
import { evaluatePlate, evaluateConnection } from './industrial/evaluateConnections';
import { evaluatePipeSupport } from './industrial/evaluateSupports';
import { reconcilePipeSupports } from './industrial/pipeSupportAttach';
import { BUILDING_LAYER_COLOR } from './entities';
import { regenerateOwned } from './derived';
import { elementAffected } from './model';
import { openingsOf } from './wallGeometry';
import {
  type EvaluationContext,
  evaluateBeam,
  evaluateColumn,
  evaluateCurvedWall,
  evaluateGrid,
  evaluateOpening,
  evaluateRoom,
  evaluateSlab,
  evaluateStair,
  evaluateWall,
} from './evaluateArchitectural';

function evaluateElement(context: EvaluationContext, element: BuildingElement): Entity[] {
  const { building } = context;
  if (element.category === 'grid') return evaluateGrid(context, element);
  if (element.category === 'door' || element.category === 'window') {
    const host = building.elements[element.hostId];
    if (!host || (host.category !== 'wall' && host.category !== 'curvedWall')) return [];
    const level = building.levels[host.levelId];
    const wall = host.category === 'wall' ? host : tangentWall(host, element.offset);
    return level ? evaluateOpening(context, element, wall, level) : [];
  }
  const leveled = element as Exclude<BuildingElement, GridElement | OpeningElement>;
  const level = building.levels[leveled.levelId];
  if (!level) return [];
  switch (leveled.category) {
    case 'wall':
      return evaluateWall(context, leveled, level);
    case 'slab':
      return evaluateSlab(leveled, level);
    case 'column':
      return evaluateColumn(leveled, level);
    case 'beam':
      return evaluateBeam(leveled, level);
    case 'stair':
      return evaluateStair(leveled, level);
    case 'room':
      return evaluateRoom(context, leveled, level);
    case 'member':
      return evaluateMember(context.doc, leveled, level);
    case 'footing':
      return evaluateFooting(leveled, level);
    case 'panel':
      return evaluatePanel(leveled, level);
    case 'equipment':
      return evaluateEquipment(leveled, level);
    case 'pipe':
      return evaluatePipe(leveled, level);
    case 'tray':
      return evaluateTray(context.doc, leveled, level);
    case 'pipeSupport': {
      const pipe = building.elements[leveled.pipeId];
      return evaluatePipeSupport(
        context.doc,
        leveled,
        pipe?.category === 'pipe' ? pipe : undefined,
        level,
      );
    }
    case 'connection': {
      const members: Record<string, SteelMemberElement | undefined> = {};
      for (const id of [leveled.rafterId, leveled.otherId]) {
        const member = building.elements[id];
        if (member?.category === 'member') members[id] = member;
      }
      return evaluateConnection(context.doc, leveled, members, level);
    }
    case 'curvedWall':
      return evaluateCurvedWall(
        leveled,
        level,
        openingsOf(building, leveled.id),
        curvedWallExtent(building, leveled),
      );
    case 'plate': {
      const member = building.elements[leveled.memberId];
      return member?.category === 'member'
        ? evaluatePlate(context.doc, leveled, member, level)
        : [];
    }
  }
}

/**
 * Replaces all previously evaluated building entities with a fresh evaluation of `edited` (after
 * re-attaching the pipe supports whose pipe or steel it changed).
 * @pure
 * @returns the new document; each element's `entityIds` lists the entities generated for it
 */
export function regenerateBuilding(doc: CadDocument, edited: BuildingModel): CadDocument {
  // Pipe supports follow edits of their pipe and steel (re-attached, or unattached when no steel is left).
  const building = reconcilePipeSupports(doc, edited).building;
  const context: EvaluationContext = { doc, building };
  const { parts, owners } = regenerateOwned(
    doc,
    Object.values(doc.building?.elements ?? {}),
    building.elementOrder.flatMap((id) => building.elements[id] ?? []),
    (element) => evaluateElement(context, element),
    BUILDING_LAYER_COLOR,
  );
  return { ...doc, ...parts, building: { ...building, elements: owners } };
}

/** Regenerates `doc` from the edited model; `affected` = `elementIds` then the entities generated. */
export function commitBuilding(
  doc: CadDocument,
  model: BuildingModel,
  elementIds: ReadonlyArray<string>,
  summary: string,
  data?: Record<string, unknown>,
): CommandResult {
  const document = regenerateBuilding(doc, model);
  const affected = elementAffected(document, elementIds);
  return data === undefined
    ? { document, summary, affected }
    : { document, summary, affected, data };
}
