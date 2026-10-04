/**
 * Building regeneration: evaluates every element into entities and replaces the stale ones.
 * @layer domain-aec
 */

import type { CadDocument, Entity } from '@core/model/types';
import type {
  BuildingElement,
  BuildingModel,
  GridElement,
  OpeningElement,
  SteelMemberElement,
} from '@core/model/building';
import { curvedWallExtent, evaluateCurvedWall, tangentWall } from './curvedWallGeometry';
import {
  evaluateEquipment,
  evaluateFooting,
  evaluateMember,
  evaluatePanel,
  evaluatePipe,
  evaluateTray,
  evaluatePlate,
  evaluateConnection,
} from './industrial/evaluate';
import { ensureLayers } from './entities';
import { openingsOf } from './wallGeometry';
import {
  type EvaluationContext,
  evaluateBeam,
  evaluateColumn,
  evaluateGrid,
  evaluateOpening,
  evaluateRoom,
  evaluateSlab,
  evaluateStair,
  evaluateWall,
} from './evaluateArchitectural';

// ---------------------------------------------------------------------------
// Whole-building regeneration
// ---------------------------------------------------------------------------

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
 * Replaces all previously evaluated building entities with a fresh evaluation of `building`.
 * @pure
 * @returns the new document and, per element id, the generated entity ids
 */
export function regenerateBuilding(doc: CadDocument, building: BuildingModel): CadDocument {
  const previous = doc.building;
  const staleIds = new Set<string>();
  if (previous) {
    for (const element of Object.values(previous.elements)) {
      for (const id of element.entityIds) staleIds.add(id);
    }
  }
  const entities: Record<string, Entity> = {};
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (!staleIds.has(id)) entities[id] = entity;
  }
  const order = doc.order.filter((id) => !staleIds.has(id));
  const context: EvaluationContext = { doc, building };
  const elements: BuildingModel['elements'] = {};
  const usedLayers = new Set<string>();
  for (const elementId of building.elementOrder) {
    const element = building.elements[elementId];
    if (!element) continue;
    const generated = evaluateElement(context, element);
    for (const entity of generated) {
      entities[entity.id] = entity;
      order.push(entity.id);
    }
    for (const entity of generated) usedLayers.add(entity.layerId);
    elements[elementId] = { ...element, entityIds: generated.map((entity) => entity.id) };
  }
  const { layers, layerOrder } = ensureLayers(doc.layers, doc.layerOrder, usedLayers);
  return {
    ...doc,
    entities,
    order,
    layers,
    layerOrder,
    selection: doc.selection.filter((id) => entities[id] !== undefined),
    building: { ...building, elements },
  };
}
