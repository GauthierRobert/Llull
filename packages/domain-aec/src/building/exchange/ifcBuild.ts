import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, confirmExportControlled } from '@core/commands/schema';
import { toMm } from '@core/model/units';
import { fileSlug, getBuilding } from '../model';
import { getPiping } from '../../plant/piping/model';
import { noop, report, exportRefusal } from '@core/commands/noop';
import { type Context, StepWriter, ifcGuid, ifcString, placement } from './ifcStep';
import { type PipingIfc, exportPipingProducts } from './ifcPipingExport';
import { plantIfcView } from '../../plant/data/view';
import { type IfcOmitted, type IfcScope, ifcScopeOf, omittedMessage, omittedOf, omittedTotal } from './ifcScope';
import { exportLevels } from './ifcLevels';
import { type PlantContext } from './ifcElements';
import { refuseDat } from '../../plant/data/codes';
import {
  type ExportProxy,
  type ExportWarning,
  type IfcSchema,
  type PlantIfcOptions,
  entityCounts,
  newRun,
  plantUnits,
  predefinedTypeCounts,
  writeSystems,
} from './ifcPlant';
import { writePlantNodes } from './ifcPlantHierarchy';
import { connectRealNozzles } from './ifcNozzleConnections';
import { finishNozzles, newPortState } from './ifcPorts';

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
  /** Id of the hierarchy node the export is limited to (plant.scope), null for the whole document. */
  readonly scope: string | null;
  /** What the scope left out: building elements and routed lines, with no plant object or with one outside the subtree (null without a scope). */
  readonly omitted: IfcOmitted | null;
}

function buildIfc(doc: CadDocument, timestamp: string, schema: IfcSchema, options: PlantIfcOptions, scope: IfcScope | null): IfcExport {
  const building = getBuilding(doc);
  const view = scope?.view ?? plantIfcView(doc);
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
  const plant: PlantContext = {
    run,
    ports,
    spatial,
    view,
    ...(scope === null ? {} : { lineInScope: (objectId: string) => scope.hasObject(objectId) }),
  };
  const levels = exportLevels(context, doc, buildingPlacement, plant, scope);
  const { storeys, byMaterial, plantContained } = levels;
  let productCount = levels.productCount;
  for (const [container, refs] of plantContained) {
    writer.add(
      `IFCRELCONTAINEDINSPATIALSTRUCTURE('${context.guid(`rel:contains:plant:${container}`)}',$,$,$,(${refs.join(',')}),${container})`,
    );
  }
  if (run.x3 && options.ports) {
    finishNozzles(context, doc, ports, scope === null ? undefined : (objectId) => scope.hasObject(objectId));
    connectRealNozzles(context, doc, ports);
  }
  if (run.x3 && options.systems === 'line') writeSystems(context, run);
  const piping = exportPipingProducts(
    context,
    doc,
    buildingPlacement,
    ports,
    scope === null ? undefined : (lineId) => scope.lineMembership(lineId) === 'inScope',
  );
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
  const omitted = scope === null ? null : omittedOf(doc, scope, levels.omittedElements);
  if (scope !== null && omitted !== null && omittedTotal(omitted) > 0)
    run.warnings.push({ code: 'DAT_IFC_SCOPE_OMITTED', id: scope.nodeId, message: omittedMessage(omitted) });
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
    elementCount: levels.elementCount,
    piping: pipingSummary,
    schema,
    counts: entityCounts(context),
    predefinedTypes: predefinedTypeCounts(run),
    ports: ports.portCount,
    connections: ports.connectionCount,
    openPorts: ports.portCount - ports.connected.size,
    proxies: run.proxies,
    warnings: run.warnings,
    scope: scope?.nodeId ?? null,
    omitted,
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
 * @affects none; data = { filename, ifc, entityCount, productCount, elementCount, piping, schema, counts, predefinedTypes, ports, connections, openPorts, proxies, warnings, scope, omitted }
 * @invariant IFC4 (default) is unchanged except the Tag of classified equipment and pipes; IFC4X3_ADD2 adds the plant hierarchy, class mapping, pipe decomposition, ports, systems, SI units and property sets
 * @failure no levels and no pipe runs -> no data; plant.scope naming no (or an ambiguous) hierarchy node -> DAT_HIERARCHY_UNKNOWN; export-controlled document without confirmExportControlled -> refused
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
    'IfcDistributionSystem per process line, SI units (Pa, K, kg, m3/s) and Pset_llullPlant. Tag = plant tag in both schemas. data.counts, predefinedTypes, ports, connections, openPorts, proxies and warnings describe the result. ' +
    'plant.scope limits the file to one hierarchy node: only the building elements and routed lines whose plant object sits at that node or below are written (anything without a plant object is left out), ' +
    'under the spatial nodes from the root down to it; a port whose partner is outside the scope stays open (data.openPorts); data.scope is the node id; data.omitted counts what it left out ({ elements, routedLines } each { noPlantObject, outsideScope }) and the warning DAT_IFC_SCOPE_OMITTED repeats it; storeys without an exported product are not written; systems and nozzle ports carry nothing of a line outside the scope. Unknown, empty or ambiguous node: DAT_HIERARCHY_UNKNOWN.',
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
            'Write distribution ports, nests and port connections. IFC4 and IFC4X3_ADD2: the ports of equipment nozzles (03 EQP) and their connections to routed pipes; IFC4X3_ADD2 also the pipe ports and the nozzle ports inferred from line from/to. Default true.',
          ),
        systems: z
          .enum(['line', 'none'])
          .optional()
          .describe('IFC4X3_ADD2: "line" writes one IfcDistributionSystem per process line (default); "none" writes none.'),
        scope: z
          .string()
          .optional()
          .describe(
            'Hierarchy node (code, path S1/P1/U10 or id) to limit the export to: its plant objects and everything below it, with the nodes above it as the spatial structure. Elements and routed lines with no plant object are left out. Omit for the whole document.',
          ),
        hierarchy: z
          .boolean()
          .optional()
          .describe(
            'IFC4X3_ADD2: write the plant hierarchy as IfcSite / IfcFacility / IfcFacilityPartCommon and contain classified products in it. Default true.',
          ),
      })
      .optional()
      .describe(
        'Plant export options: ports applies to both schemas, systems and hierarchy to IFC4X3_ADD2 only. Omit for the defaults: ports, line systems and hierarchy on.',
      ),
  }),
  run: (doc, { confirmExportControlled, timestamp, schema: requested, plant }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_ifc', 'data', confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const scoped = plant?.scope === undefined ? null : ifcScopeOf(doc, plant.scope);
    if (scoped?.ok === false) return refuseDat(doc, 'export_ifc', 'DAT_HIERARCHY_UNKNOWN', scoped.message, [], ['plant.scope']);
    const building = getBuilding(doc);
    if (building.levelOrder.length === 0 && getPiping(doc).runOrder.length === 0)
      return noop(doc, 'export_ifc: the building model has no levels (add_level / draw_walls first) and no pipe runs.');
    const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(building.project.date);
    const stamp = timestamp ?? (isoDate ? `${building.project.date}T00:00:00` : '1970-01-01T00:00:00');
    const schema = requested ?? 'IFC4';
    const result = buildIfc(
      doc,
      stamp,
      schema,
      { ports: plant?.ports ?? true, systems: plant?.systems ?? 'line', hierarchy: plant?.hierarchy ?? true },
      scoped?.scope ?? null,
    );
    const dateNote =
      timestamp === undefined && building.project.date !== '' && !isoDate
        ? ` Project date "${building.project.date}" is not YYYY-MM-DD, so the header uses ${stamp}.`
        : '';
    return report(
      doc,
      `${schema} ${result.filename}: ${result.elementCount} building element(s) as ${result.productCount} IFC product(s) on ${result.counts['IfcBuildingStorey'] ?? 0} storey(s), ${result.entityCount} STEP entities.${pipingNote(result.piping)}${plantNote(result)}${result.scope === null || result.omitted === null ? '' : ` Scope: hierarchy node ${result.scope}; ${omittedMessage(result.omitted)}.`}${dateNote}`,
      result,
    );
  },
});
