/** Building regeneration: evaluates every element into entities and replaces the stale ones. */

import type { CadDocument, Entity } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import type { BuildingElement, BuildingModel, GridElement, OpeningElement, SteelMemberElement } from '@aec/building/types';
import { curvedWallExtent, tangentWall } from '../geometry/curvedWallGeometry';
import { evaluateEquipment, evaluateFooting, evaluateMember, evaluatePanel, evaluatePipe, evaluateTray } from '../../industrial/evaluate';
import { evaluatePlate, evaluateConnection } from '../../industrial/connections/evaluateConnections';
import { evaluateGrating } from '../../plant/structures/evaluate/evaluateGrating';
import { evaluateLadder } from '../../plant/structures/evaluate/evaluateLadder';
import { evaluateSteelStair } from '../../plant/structures/evaluate/evaluateSteelStair';
import { evaluateRadialStair } from '../../plant/structures/evaluate/evaluateRadialStair';
import { evaluateRailing } from '../../plant/structures/evaluate/evaluateRailing';
import { evaluatePipeSupport } from '../../industrial/piping/evaluateSupports';
import { carrierOfSupport } from '../../industrial/piping/pipeCarrier';
import { reconcilePipeSupports } from '../../industrial/piping/pipeSupportAttach';
import { BUILDING_LAYER_COLOR } from './entities';
import { regenerateOwned } from '../../shared/derived';
import { memoizedEvaluation } from '../../shared/evaluationMemo';
import { elementAffected, orderedElements } from '../model';
import { openingsOf } from '../geometry/wallGeometry';
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
    return level ? evaluateOpening(context, element, { wall, level }) : [];
  }
  const leveled = element as Exclude<BuildingElement, GridElement | OpeningElement>;
  const level = building.levels[leveled.levelId];
  if (!level) return [];
  switch (leveled.category) {
    case 'wall':
      return evaluateWall(context, { wall: leveled, level });
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
      return evaluatePipeSupport(context.doc, leveled, carrierOfSupport(context.doc, building, leveled), level);
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
      return evaluateCurvedWall(leveled, level, openingsOf(building, leveled.id), curvedWallExtent(building, leveled));
    case 'grating':
      return evaluateGrating(context.doc, leveled, level);
    case 'railing':
      return evaluateRailing(context.doc, leveled, level);
    case 'ladder':
      return evaluateLadder(context.doc, leveled, level);
    case 'steelStair':
      return evaluateSteelStair(context.doc, leveled, level);
    case 'radialStair':
      return evaluateRadialStair(context.doc, leveled, level);
    case 'assembly':
      return [];
    case 'plate': {
      const member = building.elements[leveled.memberId];
      return member?.category === 'member' ? evaluatePlate(context.doc, leveled, member, level) : [];
    }
  }
}

/**
 * Everything `evaluateElement` reads for `element` besides `doc.units` (the evaluation is a pure function of these), or null when the
 * element is not memoized: walls and curved walls read their openings and joined walls (`openingsOf`, `wallExtent`), an unplaced element
 * evaluates to nothing.
 * @invariant the owner's `entityIds` are ignored by the comparison; every other element it names is listed here
 */
function evaluationInputs(context: EvaluationContext, element: BuildingElement): readonly unknown[] | null {
  const { building } = context;
  switch (element.category) {
    case 'grid':
      return [element];
    case 'door':
    case 'window': {
      const host = building.elements[element.hostId];
      const level = host && (host.category === 'wall' || host.category === 'curvedWall') ? building.levels[host.levelId] : undefined;
      return level ? [element, host, level] : null;
    }
    case 'wall':
    case 'curvedWall':
    case 'assembly':
      return null;
    case 'connection': {
      const [rafter, other] = [building.elements[element.rafterId], building.elements[element.otherId]];
      return [
        element,
        rafter?.category === 'member' ? rafter : null,
        other?.category === 'member' ? other : null,
        building.levels[element.levelId],
      ];
    }
    case 'plate': {
      const member = building.elements[element.memberId];
      return [element, member?.category === 'member' ? member : null, building.levels[element.levelId]];
    }
    case 'pipeSupport':
      return [element, carrierOfSupport(context.doc, building, element) ?? null, building.levels[element.levelId]];
    default:
      return [element, building.levels[element.levelId]];
  }
}

/** `evaluateElement`, reusing the entities of the previous regeneration when the element and what it reads are unchanged. */
function evaluateMemoized(context: EvaluationContext, element: BuildingElement): Entity[] {
  const inputs = evaluationInputs(context, element);
  if (inputs === null || inputs.at(-1) === undefined) return evaluateElement(context, element);
  const previous = context.doc.building?.elements[element.id]?.entityIds;
  return memoizedEvaluation(context.doc, previous, inputs, () => evaluateElement(context, element));
}

/**
 * Replaces all previously evaluated building entities with a fresh evaluation of `edited` (after re-attaching the pipe supports whose pipe
 * or steel it changed).
 * @returns the new document; each element's `entityIds` lists the entities generated for it
 */
export function regenerateBuilding(doc: CadDocument, edited: BuildingModel): CadDocument {
  // Pipe supports follow edits of their pipe and steel (re-attached, or unattached when no steel is left).
  const building = reconcilePipeSupports(doc, edited).building;
  const context: EvaluationContext = { doc, building };
  const { parts, owners } = regenerateOwned(
    doc,
    Object.values(doc.building?.elements ?? {}),
    orderedElements(building),
    (element) => evaluateMemoized(context, element),
    BUILDING_LAYER_COLOR,
  );
  return { ...doc, ...parts, building: { ...building, elements: owners } };
}

/** Regenerates `doc` from the edited model; `affected` = `elementIds` then the entities generated. */
export function commitBuilding(
  doc: CadDocument,
  model: BuildingModel,
  elementIds: ReadonlyArray<string>,
  summary: string | ((document: CadDocument) => string),
  data?: Record<string, unknown>,
): CommandResult {
  const document = regenerateBuilding(doc, model);
  const text = typeof summary === 'function' ? summary(document) : summary;
  const affected = elementAffected(document, elementIds);
  return data === undefined ? { document, summary: text, affected } : { document, summary: text, affected, data };
}
