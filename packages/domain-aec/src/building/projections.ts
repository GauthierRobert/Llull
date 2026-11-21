/** Read-only views of the `building` slice for core (BCF): the IFC GlobalIds `export_ifc` writes for an entity, and the inverse. */

import type { DocumentProjections, IfcSchemaName } from '@core/plugins/plugin';
import type { CadDocument } from '@core/model/types';
import { buildingConnectionSolids, plateLayout } from '../industrial/connections/evaluateConnections';
import { panelFrame } from '../industrial/evaluate';
import { sweepFrame } from '../shared/mesh';
import { findProfile } from '../steel/profiles';
import { selectRuns } from '../plant/piping/graph';
import { getPiping } from '../plant/piping/model';
import { productRevolutions } from './exchange/ifcPipingExport';
import {
  connectionBoltsSeed,
  connectionPartSeed,
  distinctPoints,
  globalIdFor,
  pipeBendSeed,
  pipeSegmentSeed,
  plateBoltsSeed,
} from './exchange/ifcSeeds';
import type { BuildingModel } from './types';

/** Categories whose single IFC product is seeded by exactly the element id (`context.guid(element.id)`). */
const PRODUCT_SEEDED_BY_ID: ReadonlySet<string> = new Set([
  'wall',
  'door',
  'window',
  'slab',
  'column',
  'beam',
  'stair',
  'room',
  'equipment',
  'pipeSupport',
]);

type Element = BuildingModel['elements'][string];
type Elements = BuildingModel['elements'];

const SCHEMAS: readonly IfcSchemaName[] = ['IFC4', 'IFC4X3_ADD2'];

const ownerIndex = new WeakMap<Elements, ReadonlyMap<string, Element>>();

/** Entity id -> the element that lists it, memoised per elements record. */
function ownersOf(elements: Elements): ReadonlyMap<string, Element> {
  const known = ownerIndex.get(elements);
  if (known !== undefined) return known;
  const index = new Map<string, Element>();
  for (const element of Object.values(elements)) for (const entityId of element.entityIds) index.set(entityId, element);
  ownerIndex.set(elements, index);
  return index;
}

/**
 * Seeds of the products `export_ifc` writes for `element` (the same seed helpers the exporter calls). pipe: IFC4 one segment seeded by the id,
 * IFC4X3_ADD2 a segment per straight and a bend per interior vertex; connection: end plates / haunches per part plus one bolt group; plate: the plate
 * plus its anchor group.
 * @failure category the export does not write as a seeded product, or geometry that yields none -> []
 */
function seedsOf(doc: CadDocument, building: BuildingModel, element: Element, schema: IfcSchemaName): string[] {
  if (PRODUCT_SEEDED_BY_ID.has(element.category)) return [element.id];
  switch (element.category) {
    case 'pipe': {
      const points = distinctPoints(element.points);
      if (points.length < 2) return [];
      if (schema === 'IFC4') return [element.id];
      return points.flatMap((_, k) =>
        k === points.length - 1
          ? []
          : k === points.length - 2
            ? [pipeSegmentSeed(element.id, k)]
            : [pipeSegmentSeed(element.id, k), pipeBendSeed(element.id, k + 1)],
      );
    }
    case 'member':
      return findProfile(element.profile) !== undefined && sweepFrame(element.start, element.end, element.roll) ? [element.id] : [];
    case 'footing':
      return [element.id];
    case 'panel':
      return panelFrame(element.corners) ? [element.id] : [];
    case 'tray':
      return distinctPoints(element.points).length >= 2 ? [element.id] : [];
    case 'connection': {
      const solids = buildingConnectionSolids(doc, building, element) ?? [];
      const parts = solids.filter((solid) => !solid.part.startsWith('bolt')).map((solid) => connectionPartSeed(element.id, solid.part));
      return solids.some((solid) => solid.part.startsWith('bolt')) ? [...parts, connectionBoltsSeed(element.id)] : parts;
    }
    case 'plate': {
      const member = building.elements[element.memberId];
      const level = building.levels[element.levelId];
      if (member?.category !== 'member' || level === undefined || plateLayout(doc, element, member, level) === null) return [];
      return [element.id, plateBoltsSeed(element.id)];
    }
    default:
      return [];
  }
}

/** Routed pipe part entity id -> id of the part whose IFC product it belongs to (only parts `export_ifc` writes a product for). */
function routedPartIndex(doc: CadDocument): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  if (doc.units !== 'mm') return index;
  const piping = getPiping(doc);
  for (const { lineId, derivation } of selectRuns(doc).graphRuns) {
    const line = piping.lines[lineId];
    if (line === undefined) continue;
    for (const part of derivation.parts) {
      for (const entity of productRevolutions(part, line)) index.set(entity.id, part.id);
    }
  }
  return index;
}

interface GuidTables {
  readonly routed: ReadonlyMap<string, string>;
  readonly byEntity: Map<string, readonly string[]>;
  inverse: Map<string, string[]> | null;
}

const tables = new WeakMap<CadDocument, GuidTables>();

const tablesOf = (doc: CadDocument): GuidTables => {
  let known = tables.get(doc);
  if (known === undefined) {
    known = { routed: routedPartIndex(doc), byEntity: new Map(), inverse: null };
    tables.set(doc, known);
  }
  return known;
};

function guidsOf(doc: CadDocument, entityId: string, schema: IfcSchemaName): readonly string[] {
  const table = tablesOf(doc);
  const key = `${schema}|${entityId}`;
  const known = table.byEntity.get(key);
  if (known !== undefined) return known;
  const building = doc.building;
  const routedPart = table.routed.get(entityId);
  const owner = building === undefined ? undefined : ownersOf(building.elements).get(entityId);
  const seeds =
    routedPart !== undefined ? [routedPart] : building === undefined || owner === undefined ? [] : seedsOf(doc, building, owner, schema);
  const guids = seeds.map((seed) => globalIdFor(building?.uid, seed));
  table.byEntity.set(key, guids);
  return guids;
}

/**
 * GlobalIds `export_ifc` (schema `schema`) writes for `entityId`: the element's products, or the routed part's product.
 * @invariant the seeds and the salt come from `exchange/ifcSeeds.ts`, the module `export_ifc` itself calls; a scoped export (plant.scope) keeps the GlobalIds of what it writes
 */
const ifcGuidsOfEntity: NonNullable<DocumentProjections['ifcGuids']> = (doc, entityId, schema) => guidsOf(doc, entityId, schema);

/** Entities whose products carry `guid` in either schema's export (a foreign GlobalId -> []). */
const entitiesOfGuid: NonNullable<DocumentProjections['entitiesOfIfcGuid']> = (doc, guid) => {
  const table = tablesOf(doc);
  if (table.inverse === null) {
    const inverse = new Map<string, string[]>();
    const entityIds = new Set([
      ...table.routed.keys(),
      ...Object.values(doc.building?.elements ?? {}).flatMap((element) => element.entityIds),
    ]);
    for (const entityId of entityIds)
      for (const schema of SCHEMAS)
        for (const found of guidsOf(doc, entityId, schema)) {
          const list = inverse.get(found) ?? [];
          if (!list.includes(entityId)) list.push(entityId);
          inverse.set(found, list);
        }
    table.inverse = inverse;
  }
  return table.inverse.get(guid) ?? [];
};

export const buildingProjections: DocumentProjections = { ifcGuids: ifcGuidsOfEntity, entitiesOfIfcGuid: entitiesOfGuid };
