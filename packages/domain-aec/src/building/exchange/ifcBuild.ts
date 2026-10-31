import type { CadDocument } from '@core/model/types';
import type { BuildingElement, BuildingLevel, EquipmentElement, PipeElement } from '@aec/building/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, confirmExportControlled } from '@core/commands/schema';
import { toMm } from '@core/model/units';
import { fileSlug, getBuilding, orderedElements } from '../model';
import { getPiping } from '../../plant/piping/model';
import { noop, report, exportRefusal } from '@core/commands/noop';
import { type Context, StepWriter, ifcGuid, ifcReal, ifcString, placement } from './ifcStep';
import { type Exported, exportCurvedWallElement, exportWallElement } from './ifcElementExport';
import { exportConnection, exportIndustrial, exportPlate } from './ifcIndustrialExport';
import { exportOther } from './ifcOtherExport';
import { exportGrating, exportRailing } from '../../plant/structures/exchange/ifcAccessExport';
import { exportSteelStair } from '../../plant/structures/exchange/ifcSteelStairExport';
import { exportLadder } from '../../plant/structures/exchange/ifcLadderExport';
import { exportPipeSupport } from './ifcSupportExport';
import { type PipingIfc, exportPipingProducts } from './ifcPipingExport';
import { carrierOfSupport } from '../../industrial/piping/pipeCarrier';
import { plantIfcView, type PlantIfcView } from '../../plant/data/view';
import {
  type ExportProxy,
  type ExportWarning,
  type IfcSchema,
  type PlantIfcOptions,
  type PlantIfcRun,
  addPlantPsets,
  elementTag,
  entityCounts,
  equipmentProduct,
  newRun,
  plantUnits,
  predefinedTypeCounts,
  writeSystems,
} from './ifcPlant';
import { type PlantSpatial, containerOf, writePlantNodes } from './ifcPlantHierarchy';
import { type PortState, exportPipeProducts, finishNozzles, newPortState } from './ifcPorts';

type LevelElement = Extract<BuildingElement, { levelId: string }>;

export interface IfcExport {
  readonly filename: string;
  readonly ifc: string;
  readonly entityCount: number;
  readonly productCount: number;
  /** Building elements that produced at least one product (a pipe or hall member may yield several). */
  readonly elementCount: number;
  /** Pipe products of the spec-driven runs (02 RTE): segments, fittings, valves, ports and systems. */
  readonly piping: Omit<PipingIfc, 'products'>;
  readonly schema: IfcSchema;
  /** Entity counts of the classes the plant data touches (plant 08 DAT), zeros included. */
  readonly counts: Record<string, number>;
  /** `{ IfcValve: { ISOLATING: 1 } }`: products written per class and PredefinedType. */
  readonly predefinedTypes: Record<string, Record<string, number>>;
  /** Plant distribution ports, plant port connections, and the ports no connection reaches. */
  readonly ports: number;
  readonly connections: number;
  readonly openPorts: number;
  /** Equipment exported as IfcBuildingElementProxy (IFC4X3_ADD2) and why. */
  readonly proxies: readonly ExportProxy[];
  readonly warnings: readonly ExportWarning[];
}

/** Everything one export run threads through the element exporters. */
interface PlantContext {
  readonly run: PlantIfcRun;
  readonly ports: PortState;
  readonly spatial: PlantSpatial | null;
  readonly view: PlantIfcView;
}

/** Every IFC product of one element placed on `level`, in export order (hosted openings follow their wall). */
function exportElement(
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
      return exportEquipment(context, element, level, storeyPlacement, plant);
    case 'pipe':
      return plant.run.x3
        ? exportPipe(context, element, level, storeyPlacement, plant)
        : exportLegacyPipe(context, element, storeyPlacement, plant);
    case 'member':
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
function appendTo(lists: Map<string, string[]>, key: string, refs: readonly string[]): void {
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
  element: EquipmentElement,
  level: BuildingLevel,
  storeyPlacement: string,
  plant: PlantContext,
): Exported[] {
  const { run } = plant;
  const classified = run.view.forElement(element.id);
  const product = equipmentProduct(run, element);
  const exported = exportIndustrial(context, element, storeyPlacement, { tag: elementTag(run, element.id), product });
  if (!exported) return [];
  plant.ports.equipment.set(element.id, { ref: exported.ref, storeyPlacement, level });
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
  const line = classified?.isLine === true ? classified : owner?.isLine === true ? owner : null;
  if (line !== null && run.options.systems === 'line' && !run.systems.has(line.object.id))
    run.systems.set(line.object.id, { object: line, members: [] });
  const where = classified === undefined ? {} : containerFor(plant, classified.object.hierarchyId);
  return exportPipeProducts(context, run, plant.ports, element, level, storeyPlacement, {
    base: classified?.tag ?? (element.mark === '' ? element.id : element.mark),
    line,
    container: 'container' in where ? where.container : null,
  });
}

function buildIfc(doc: CadDocument, timestamp: string, schema: IfcSchema, options: PlantIfcOptions): IfcExport {
  const building = getBuilding(doc);
  const view = plantIfcView(doc);
  const run = newRun(schema, options, view);
  const ports = newPortState();
  const writer = new StepWriter();
  const factor = toMm(doc, 1);
  const origin = writer.add('IFCCARTESIANPOINT((0.,0.,0.))');
  const zAxis = writer.add('IFCDIRECTION((0.,0.,1.))');
  const xAxis = writer.add('IFCDIRECTION((1.,0.,0.))');
  const worldAxes = writer.add(`IFCAXIS2PLACEMENT3D(${origin},${zAxis},${xAxis})`);
  const modelContext = writer.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${worldAxes},$)`);
  const body = writer.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${modelContext},$,.MODEL_VIEW.,$)`);
  const salt = building.uid ?? 'llull';
  const context: Context = { writer, guid: (seed) => ifcGuid(`${salt}:${seed}`), mm: (value) => value * factor, body, zAxis, xAxis };
  const units = [
    writer.add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)'),
    writer.add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'),
    writer.add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'),
    writer.add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)'),
  ];
  if (run.x3) units.push(...plantUnits(context, units[2] as string));
  const unitAssignment = writer.add(`IFCUNITASSIGNMENT((${units.join(',')}))`);
  const { project } = building;
  const projectRef = writer.add(
    `IFCPROJECT('${context.guid('project')}',$,${ifcString(project.name)},${ifcString(project.client)},$,$,$,(${modelContext}),${unitAssignment})`,
  );
  const sitePlacement = writer.add(`IFCLOCALPLACEMENT($,${worldAxes})`);
  const plantNodes = run.x3 && options.hierarchy && view.nodes.length > 0;
  const ownSite = plantNodes && view.nodes.some((node) => node.kind === 'site');
  const site = ownSite
    ? null
    : writer.add(`IFCSITE('${context.guid('site')}',$,'Site',${ifcString(project.address)},$,${sitePlacement},$,$,.ELEMENT.,$,$,$,$,$)`);
  const spatialFirst = ownSite ? writePlantNodes(context, view, projectRef, null) : null;
  const buildingParent = spatialFirst?.firstSite ?? (site as string);
  const buildingPlacement = placement(context, sitePlacement, 0, 0, 0);
  const buildingRef = writer.add(
    `IFCBUILDING('${context.guid('building')}',$,${ifcString(project.name)},$,$,${buildingPlacement},$,$,.ELEMENT.,$,$,$)`,
  );
  if (site !== null) writer.add(`IFCRELAGGREGATES('${context.guid('rel:project-site')}',$,$,$,${projectRef},(${site}))`);
  writer.add(`IFCRELAGGREGATES('${context.guid('rel:site-building')}',$,$,$,${buildingParent},(${buildingRef}))`);
  const spatial = spatialFirst ?? (plantNodes ? writePlantNodes(context, view, projectRef, site) : null);
  const plant: PlantContext = { run, ports, spatial, view };
  const plantContained = new Map<string, string[]>();
  const storeys: string[] = [];
  const byMaterial = new Map<string, string[]>();
  let productCount = 0;
  let elementCount = 0;
  for (const levelId of building.levelOrder) {
    const level = building.levels[levelId];
    if (!level) continue;
    const storeyPlacement = placement(context, buildingPlacement, 0, 0, context.mm(level.elevation));
    const storey = writer.add(
      `IFCBUILDINGSTOREY('${context.guid(level.id)}',$,${ifcString(level.name)},$,$,${storeyPlacement},$,$,.ELEMENT.,${ifcReal(context.mm(level.elevation))})`,
    );
    storeys.push(storey);
    const contained: string[] = [];
    const spaces: string[] = [];
    for (const element of orderedElements(building)) {
      if (!('levelId' in element) || element.levelId !== level.id) continue;
      const exportedProducts = exportElement(context, doc, element, level, storeyPlacement, plant);
      if (exportedProducts.length > 0) elementCount += 1;
      for (const exported of exportedProducts) {
        if (exported.container !== undefined) appendTo(plantContained, exported.container, [exported.ref]);
        else (element.category === 'room' ? spaces : contained).push(exported.ref);
        productCount += 1;
        if (exported.material === null) continue;
        appendTo(byMaterial, exported.material, [exported.ref, ...(exported.parts ?? [])]);
      }
    }
    if (contained.length > 0) {
      writer.add(
        `IFCRELCONTAINEDINSPATIALSTRUCTURE('${context.guid(`rel:contains:${level.id}`)}',$,$,$,(${contained.join(',')}),${storey})`,
      );
    }
    if (spaces.length > 0) {
      writer.add(`IFCRELAGGREGATES('${context.guid(`rel:spaces:${level.id}`)}',$,$,$,${storey},(${spaces.join(',')}))`);
    }
  }
  for (const [container, refs] of plantContained) {
    writer.add(
      `IFCRELCONTAINEDINSPATIALSTRUCTURE('${context.guid(`rel:contains:plant:${container}`)}',$,$,$,(${refs.join(',')}),${container})`,
    );
  }
  if (run.x3 && options.ports) finishNozzles(context, doc, ports);
  if (run.x3 && options.systems === 'line') writeSystems(context, run);
  const piping = exportPipingProducts(context, doc, buildingPlacement);
  if (piping.products.length > 0) {
    writer.add(
      `IFCRELCONTAINEDINSPATIALSTRUCTURE('${context.guid('rel:contains:piping')}',$,$,$,(${piping.products.join(',')}),${buildingRef})`,
    );
    productCount += piping.productCount;
  }
  if (storeys.length > 0) {
    writer.add(`IFCRELAGGREGATES('${context.guid('rel:building-storeys')}',$,$,$,${buildingRef},(${storeys.join(',')}))`);
  }
  for (const [material, refs] of byMaterial) {
    const materialRef = writer.add(`IFCMATERIAL(${ifcString(material)},$,$)`);
    writer.add(`IFCRELASSOCIATESMATERIAL('${context.guid(`rel:material:${material}`)}',$,$,$,(${refs.join(',')}),${materialRef})`);
  }
  const name = fileSlug(project.name, 'project');
  const ifc = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('ViewDefinition [${run.x3 ? 'DesignTransferView' : 'DesignTransferView_V1.0'}]'),'2;1');`,
    `FILE_NAME(${ifcString(`${name}.ifc`)},${ifcString(timestamp)},(${ifcString(project.author)}),(''),'llull','llull',${ifcString(project.drawingNumber)});`,
    `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;',
    'DATA;',
    writer.data(),
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
  const { products, ...pipingSummary } = piping;
  void products;
  return {
    filename: `${name}.ifc`,
    ifc,
    entityCount: writer.count,
    productCount,
    elementCount,
    piping: pipingSummary,
    schema,
    counts: entityCounts(context),
    predefinedTypes: predefinedTypeCounts(run),
    ports: ports.portCount,
    connections: ports.connectionCount,
    openPorts: ports.portCount - ports.connected.size,
    proxies: run.proxies,
    warnings: run.warnings,
  };
}

/** The summary sentence of the pipe products (empty without runs). */
function pipingNote(piping: IfcExport['piping']): string {
  return piping.productCount === 0 && piping.brokenRuns.length === 0
    ? ''
    : ` Pipe runs: ${piping.productCount} product(s), ${piping.portCount} port(s), ${piping.connectionCount} port connection(s), ${piping.systemCount} system(s)${piping.bodiless > 0 ? `; ${piping.bodiless} part(s) without a product (bolt sets, stub-ins)` : ''}${piping.brokenRuns.length > 0 ? `; broken runs not exported: ${piping.brokenRuns.join(', ')}` : ''}.`;
}

/** The summary sentence of the plant ports and proxies (IFC4X3_ADD2 only). */
function plantNote(result: IfcExport): string {
  if (result.schema !== 'IFC4X3_ADD2') return '';
  const open = result.openPorts > 0 ? `, ${result.openPorts} open` : '';
  const proxies =
    result.proxies.length > 0 ? ` ${result.proxies.length} equipment exported as IfcBuildingElementProxy (data.proxies).` : '';
  return ` Plant: ${result.ports} port(s), ${result.connections} connection(s)${open}.${proxies}`;
}

/**
 * @affects none; data = { filename, ifc, entityCount, productCount, elementCount, piping, schema, counts, predefinedTypes, ports, connections, openPorts, proxies, warnings }
 * @invariant IFC4 (default) is unchanged except the Tag of classified equipment and pipes; IFC4X3_ADD2 adds the plant hierarchy, class mapping, pipe decomposition, ports, systems, SI units and property sets
 * @failure no levels and no pipe runs -> no data; export-controlled document without confirmExportControlled -> refused
 */
export const exportIfc = defineCommand({
  name: 'export_ifc',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Export the building model as IFC4 (OpenBIM, ISO 16739; schema IFC4X3_ADD2 on request) for Revit, ArchiCAD, Tekla, Solibri, BIMcollab, Navisworks…: project / site ' +
    '/ building / storeys, walls with real openings (IfcOpeningElement) filled by doors and windows, slabs (floor / roof / base slab), ' +
    'columns, beams, stairs, spaces and materials. Spec-driven pipe runs (route_pipe) are exported too: IfcPipeSegment for every pipe piece, IfcPipeFitting (BEND, JUNCTION, TRANSITION, CONNECTOR, OBSTRUCTION) for ' +
    'elbows, tees, olets, reducers, flanges, gaskets and caps, IfcValve for valves, each with an IfcDistributionPort per connection nested in it (IfcRelNests) and IfcRelConnectsPorts between ports that meet, and one ' +
    'IfcDistributionSystem per pipe line named by its line number; the pipe geometry is the same as the viewport and the STEP export draw. GlobalIds are stable across exports. data.ifc holds the file text; data.piping counts ' +
    'the pipe products, ports, connections and systems and lists the runs that do not derive (not exported). With schema "IFC4X3_ADD2" the plant data (define_plant_hierarchy, assign_plant_object) is exported too: hierarchy as IfcSite / IfcFacility ' +
    '/ IfcFacilityPartCommon, classified equipment as the IFC class and PredefinedType of its plant class (IfcTank, IfcPump, ... ; unmapped = IfcBuildingElementProxy listed in data.proxies), pipes split into IfcPipeSegment per straight and ' +
    'IfcPipeFitting BEND per vertex with IfcDistributionPort (SINK in, SOURCE out), IfcRelNests and one IfcRelConnectsPorts per connection (RelatingPort = SOURCE), nozzle ports inferred where a line from/to meets its equipment, one ' +
    'IfcDistributionSystem per process line, SI units (Pa, K, kg, m3/s) and Pset_llullPlant. Tag = plant tag in both schemas. data.counts, predefinedTypes, ports, connections, openPorts, proxies and warnings describe the result.',
  params: z.object({
    confirmExportControlled,
    timestamp: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp written in the file header. Default: project date or 1970-01-01T00:00:00.'),
    schema: z
      .enum(['IFC4', 'IFC4X3_ADD2'])
      .optional()
      .describe(
        'IFC schema written in FILE_SCHEMA. IFC4 (default) is the building export; IFC4X3_ADD2 adds the plant mapping (hierarchy, classes, ports, systems, units).',
      ),
    plant: z
      .object({
        ports: z
          .boolean()
          .optional()
          .describe(
            'IFC4X3_ADD2: write distribution ports, nests, port connections and the nozzle ports inferred from line from/to. Default true.',
          ),
        systems: z
          .enum(['line', 'none'])
          .optional()
          .describe('IFC4X3_ADD2: "line" writes one IfcDistributionSystem per process line (default); "none" writes none.'),
        hierarchy: z
          .boolean()
          .optional()
          .describe(
            'IFC4X3_ADD2: write the plant hierarchy as IfcSite / IfcFacility / IfcFacilityPartCommon and contain classified products in it. Default true.',
          ),
      })
      .optional()
      .describe('Plant export options (IFC4X3_ADD2 only; ignored with IFC4). Omit for the defaults: ports, line systems and hierarchy on.'),
  }),
  run: (doc, { confirmExportControlled, timestamp, schema: requested, plant }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_ifc', 'data', confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const building = getBuilding(doc);
    if (building.levelOrder.length === 0 && getPiping(doc).runOrder.length === 0)
      return noop(doc, 'export_ifc: the building model has no levels (add_level / draw_walls first) and no pipe runs.');
    const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(building.project.date);
    const stamp = timestamp ?? (isoDate ? `${building.project.date}T00:00:00` : '1970-01-01T00:00:00');
    const schema = requested ?? 'IFC4';
    const result = buildIfc(doc, stamp, schema, {
      ports: plant?.ports ?? true,
      systems: plant?.systems ?? 'line',
      hierarchy: plant?.hierarchy ?? true,
    });
    const dateNote =
      timestamp === undefined && building.project.date !== '' && !isoDate
        ? ` Project date "${building.project.date}" is not YYYY-MM-DD, so the header uses ${stamp}.`
        : '';
    return report(
      doc,
      `${schema} ${result.filename}: ${result.elementCount} building element(s) as ${result.productCount} IFC product(s) on ${building.levelOrder.length} storey(s), ${result.entityCount} STEP entities.${pipingNote(result.piping)}${plantNote(result)}${dateNote}`,
      result,
    );
  },
});
