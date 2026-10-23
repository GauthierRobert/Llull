/**
 * Entity property provider of the plant display plugin (plant 09 VIS §3.3): resolves a derived entity to its owning element and returns the
 * domain facts colour rules match on. Building elements: `category`, `mark`; pipes add `service`, `line`, `dn`, `odMm`, `material`, `from`, `to`;
 * equipment adds `equipmentShape`. Plant piping part entities (02 RTE) add `service`, `line`, `dn`, `spec`, `partKind`, `odMm` (pipe pieces and elbows only), `insulationMm`, `from`, `to`.
 */

import type { PropertyValue } from '@core/model/display';
import type { EntityPropertyProvider, PropertyBag } from '@core/model/entityProperties';
import type { CadDocument } from '@core/model/types';
import { buildingElementOf } from '../../building/evaluate/integrity';
import type { BuildingElement } from '../../building/types';
import { getPiping } from '../piping/model';
import { pipeOutsideDiameter } from '../piping/specLookup';

type Bag = Record<string, PropertyValue>;

const set = (bag: Bag, key: string, value: PropertyValue | undefined): void => {
  if (value !== undefined) bag[key] = value;
};

function elementProperties(element: BuildingElement): PropertyBag {
  const bag: Bag = { category: element.category, mark: element.mark };
  if (element.category === 'pipe') {
    bag['service'] = element.service;
    bag['material'] = element.material;
    bag['odMm'] = element.diameter;
    set(bag, 'line', element.line);
    set(bag, 'dn', element.dn);
    set(bag, 'from', element.from);
    set(bag, 'to', element.to);
  } else if (element.category === 'equipment') {
    bag['equipmentShape'] = element.shape ?? 'box';
  }
  return bag;
}

function runProperties(doc: CadDocument, entityId: string): PropertyBag {
  const piping = getPiping(doc);
  // Part entities are `<runId>/<kind>-<k>`; the run owns the entity only if it lists it.
  const runId = entityId.split('/')[0] as string;
  const run = piping.entityIds[runId]?.includes(entityId) === true ? piping.runs[runId] : undefined;
  const line = run === undefined ? undefined : piping.lines[run.lineId];
  if (line === undefined) return {};
  const bag: Bag = { category: 'pipe', service: line.service, line: line.lineNumber, dn: line.dn, spec: line.spec };
  const kind = entityId.split('/')[1]?.replace(/-\d+$/, '');
  set(bag, 'partKind', kind);
  // The outside diameter is that of the pipe itself: pipe pieces and elbows only, not flanges or gaskets.
  if (kind === 'pipe' || kind === 'elbow') set(bag, 'odMm', pipeOutsideDiameter(doc, line.spec, line.dn) ?? undefined);
  set(bag, 'insulationMm', line.insulation?.thicknessMm);
  set(bag, 'from', line.from);
  set(bag, 'to', line.to);
  return bag;
}

/** @invariant pure; {} for an entity that is neither a building element's nor a plant piping run's */
export const plantEntityProperties: EntityPropertyProvider = (doc, entityId) => {
  const elementId = buildingElementOf(doc, entityId);
  const element = elementId === null ? undefined : doc.building?.elements[elementId];
  if (element !== undefined) return elementProperties(element);
  return runProperties(doc, entityId);
};
