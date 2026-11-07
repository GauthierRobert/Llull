/**
 * One building element as IFC products (the element switch of the export), shared by the whole and the hierarchy-scoped export.
 * @invariant pure over the document; the products are written to the StepWriter of `context` in element order
 */

import type { CadDocument } from '@core/model/types';
import type { BuildingElement, BuildingLevel, EquipmentElement, PipeElement } from '@aec/building/types';
import { getBuilding } from '../model';
import { type Context } from './ifcStep';
import { type Exported, exportCurvedWallElement, exportWallElement } from './ifcElementExport';
import { exportConnection, exportIndustrial, exportPlate } from './ifcIndustrialExport';
import { exportOther } from './ifcOtherExport';
import { exportGrating, exportRailing } from '../../plant/structures/exchange/ifcAccessExport';
import { exportSteelStair } from '../../plant/structures/exchange/ifcSteelStairExport';
import { exportLadder } from '../../plant/structures/exchange/ifcLadderExport';
import { exportAssembly } from '../../plant/structures/exchange/ifcPlatformExport';
import { isRackStrut } from '../../plant/structures/rack/rackMeasure';
import { exportPipeSupport } from './ifcSupportExport';
import { carrierOfSupport } from '../../industrial/piping/pipeCarrier';
import type { PlantIfcView } from '../../plant/data/view';
import { type PlantIfcRun, addPlantPsets, elementTag, equipmentProduct } from './ifcPlant';
import { type PlantSpatial, containerOf } from './ifcPlantHierarchy';
import { equipmentProperties, exportEquipmentPorts, parametricBody } from './ifcEquipmentExport';
import { type PortState, exportPipeProducts } from './ifcPorts';

export type LevelElement = Extract<BuildingElement, { levelId: string }>;

/** Everything one export run threads through the element exporters. */
export interface PlantContext {
  readonly run: PlantIfcRun;
  readonly ports: PortState;
  readonly spatial: PlantSpatial | null;
  readonly view: PlantIfcView;
  /** Hierarchy scope: a process line object outside it names no system and gives no flow direction (the scoped file carries nothing of it). */
  readonly lineInScope?: (lineObjectId: string) => boolean;
}

/** Every IFC product of one element placed on `level`, in export order (hosted openings follow their wall). */
export function exportElement(
  context: Context,
  doc: CadDocument,
  element: LevelElement,
  level: BuildingLevel,
  storeyPlacement: string,
  plant: PlantContext,
): Exported[] {
  const building = getBuilding(doc);
  switch (element.category) {
    case 'wall':
      return exportWallElement(context, building, element, storeyPlacement);
    case 'curvedWall':
      return exportCurvedWallElement(context, building, element, storeyPlacement);
    case 'equipment':
      return exportEquipment(context, doc, element, level, storeyPlacement, plant);
    case 'pipe':
      return plant.run.x3
        ? exportPipe(context, element, level, storeyPlacement, plant)
        : exportLegacyPipe(context, element, storeyPlacement, plant);
    case 'member': {
      const exported = exportIndustrial(context, element, storeyPlacement, undefined, isRackStrut(building, element));
      return exported ? [exported] : [];
    }
    case 'footing':
    case 'panel':
    case 'tray': {
      const exported = exportIndustrial(context, element, storeyPlacement);
      return exported ? [exported] : [];
    }
    case 'pipeSupport': {
      const exported = exportPipeSupport(context, doc, building, element, carrierOfSupport(doc, building, element), storeyPlacement);
      return exported ? [exported] : [];
    }
    case 'grating': {
      const exported = exportGrating(context, element, storeyPlacement);
      return exported ? [exported] : [];
    }
    case 'railing': {
      const exported = exportRailing(context, doc, element, storeyPlacement);
      return exported ? [exported] : [];
    }
    case 'ladder': {
      const exported = exportLadder(context, doc, element, storeyPlacement);
      return exported ? [exported] : [];
    }
    case 'steelStair': {
      const exported = exportSteelStair(context, doc, element, storeyPlacement);
      return exported ? [exported] : [];
    }
    case 'assembly':
      return [exportAssembly(context, element, storeyPlacement)];
    case 'connection':
      return exportConnection(context, doc, element, building, level, storeyPlacement);
    case 'plate': {
      const member = building.elements[element.memberId];
      return member?.category === 'member' ? exportPlate(context, doc, element, member, level, storeyPlacement) : [];
    }
    case 'slab':
    case 'column':
    case 'beam':
    case 'stair':
    case 'room':
      return [exportOther(context, element, level, storeyPlacement)];
  }
}

/** Appends `refs` to the list of `key` in place (linear in the products, unlike copying the list). */
export function appendTo(lists: Map<string, string[]>, key: string, refs: readonly string[]): void {
  const list = lists.get(key);
  if (list === undefined) lists.set(key, [...refs]);
  else list.push(...refs);
}

/** Spatial element of the plant node an object sits in (IFC4X3_ADD2 with the hierarchy option), else no entry. */
const containerFor = (plant: PlantContext, hierarchyId: string): { container: string } | Record<string, never> => {
  const container = plant.run.x3 && plant.run.options.hierarchy ? containerOf(plant.spatial, plant.view, hierarchyId) : null;
  return container === null ? {} : { container };
};

function exportEquipment(
  context: Context,
  doc: CadDocument,
  element: EquipmentElement,
  level: BuildingLevel,
  storeyPlacement: string,
  plant: PlantContext,
): Exported[] {
  const { run } = plant;
  const classified = run.view.forElement(element.id);
  const product = equipmentProduct(run, element);
  const body = parametricBody(context, element, level, run);
  const exported = exportIndustrial(context, element, storeyPlacement, {
    tag: elementTag(run, element.id),
    product,
    ...(body === null ? {} : { body: body.solids }),
    properties: equipmentProperties(doc, element),
  });
  if (!exported) return [];
  plant.ports.equipment.set(element.id, { ref: exported.ref, storeyPlacement, level });
  if (run.options.ports) exportEquipmentPorts(context, plant.ports, doc, element, level, storeyPlacement, exported.ref);
  if (!run.x3 || classified === undefined) return [exported];
  const where = containerFor(plant, classified.object.hierarchyId);
  addPlantPsets(
    context,
    { seed: element.id, ref: exported.ref },
    classified,
    'container' in where ? { name: level.name, elevation: context.mm(level.elevation) } : undefined,
  );
  return [{ ...exported, ...where }];
}

/** A pipe in IFC4: one IfcPipeSegment for the run, its Tag the plant tag when classified. */
function exportLegacyPipe(context: Context, element: PipeElement, storeyPlacement: string, plant: PlantContext): Exported[] {
  const exported = exportIndustrial(context, element, storeyPlacement, { tag: elementTag(plant.run, element.id), product: null });
  return exported ? [exported] : [];
}

/** A pipe in IFC4X3_ADD2: segments, bends and ports of its straights, in the system of its process line. */
function exportPipe(
  context: Context,
  element: PipeElement,
  level: BuildingLevel,
  storeyPlacement: string,
  plant: PlantContext,
): Exported[] {
  const { run, view } = plant;
  const classified = view.forElement(element.id);
  const owner = classified?.object.lineId === undefined ? undefined : view.forObject(classified.object.lineId);
  const candidate = classified?.isLine === true ? classified : owner?.isLine === true ? owner : null;
  const line = candidate !== null && plant.lineInScope?.(candidate.object.id) === false ? null : candidate;
  if (line !== null && run.options.systems === 'line' && !run.systems.has(line.object.id))
    run.systems.set(line.object.id, { object: line, members: [] });
  const where = classified === undefined ? {} : containerFor(plant, classified.object.hierarchyId);
  return exportPipeProducts(context, run, plant.ports, element, level, storeyPlacement, {
    base: classified?.tag ?? (element.mark === '' ? element.id : element.mark),
    line,
    container: 'container' in where ? where.container : null,
  });
}
