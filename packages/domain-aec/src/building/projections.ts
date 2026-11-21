/** Read-only views of the `building` slice for core (BCF): the IFC GlobalIds `export_ifc` writes for an entity, and the inverse. */

import type { DocumentProjections, IfcSchemaName } from '@core/plugins/plugin';
import type { CadDocument } from '@core/model/types';
import { selectRuns } from '../plant/piping/graph';
import { getPiping } from '../plant/piping/model';
import { seedsOf } from './elementSeeds';
import { productRevolutions } from './exchange/ifcPipingExport';
import { globalIdFor } from './exchange/ifcSeeds';
import type { BuildingModel } from './types';

type Element = BuildingModel['elements'][string];
type Elements = BuildingModel['elements'];

const SCHEMAS: readonly IfcSchemaName[] = ['IFC4', 'IFC4X3_ADD2'];

const ownerIndex = new WeakMap<Elements, ReadonlyMap<string, readonly Element[]>>();

/** Entity id -> every element that lists it (an assembly lists the entities of its parts), memoised per elements record. */
function ownersOf(elements: Elements): ReadonlyMap<string, readonly Element[]> {
  const known = ownerIndex.get(elements);
  if (known !== undefined) return known;
  const index = new Map<string, Element[]>();
  for (const element of Object.values(elements))
    for (const entityId of element.entityIds) index.set(entityId, [...(index.get(entityId) ?? []), element]);
  ownerIndex.set(elements, index);
  return index;
}

/** Routed pipe part entity id -> id of the part whose IFC product it belongs to (only parts `export_ifc` writes a product for; mm documents only). */
function routedPartIndex(doc: CadDocument): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  if (doc.units !== 'mm') return index;
  const piping = getPiping(doc);
  for (const { lineId, derivation } of selectRuns(doc).graphRuns) {
    const line = piping.lines[lineId];
    if (line === undefined) continue;
    for (const part of derivation.parts) for (const entity of productRevolutions(part, line)) index.set(entity.id, part.id);
  }
  return index;
}

interface GuidTables {
  readonly routed: ReadonlyMap<string, string>;
  /** `<schema>|<element id>` -> GlobalIds of the element's products. */
  readonly byElement: Map<string, readonly string[]>;
  inverse: Map<string, string[]> | null;
}

const tables = new WeakMap<CadDocument, GuidTables>();

const tablesOf = (doc: CadDocument): GuidTables => {
  let known = tables.get(doc);
  if (known === undefined) {
    known = { routed: routedPartIndex(doc), byElement: new Map(), inverse: null };
    tables.set(doc, known);
  }
  return known;
};

function elementGuids(doc: CadDocument, building: BuildingModel, element: Element, schema: IfcSchemaName): readonly string[] {
  const table = tablesOf(doc);
  const key = `${schema}|${element.id}`;
  const known = table.byElement.get(key);
  if (known !== undefined) return known;
  const guids = seedsOf(doc, building, element, schema).map((seed) => globalIdFor(building.uid, seed));
  table.byElement.set(key, guids);
  return guids;
}

function guidsOf(doc: CadDocument, entityId: string, schema: IfcSchemaName): readonly string[] {
  const building = doc.building;
  const routedPart = tablesOf(doc).routed.get(entityId);
  const owned =
    building === undefined
      ? []
      : (ownersOf(building.elements).get(entityId) ?? []).flatMap((owner) => elementGuids(doc, building, owner, schema));
  return [...new Set([...(routedPart === undefined ? [] : [globalIdFor(building?.uid, routedPart)]), ...owned])];
}

/**
 * GlobalIds `export_ifc` (schema `schema`) writes for `entityId`: the products of every element that lists it, or the routed part's product.
 * @invariant seeds and salt come from `exchange/ifcSeeds.ts` / `elementSeeds.ts`, the helpers `export_ifc` itself calls; an entity listed by several elements gets the GlobalIds of all of them; a scoped export (plant.scope) keeps the GlobalIds of what it writes
 * @failure no building and no routed part, unknown entity, or nothing written for it (see `elementSeeds.ts`) -> []
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
