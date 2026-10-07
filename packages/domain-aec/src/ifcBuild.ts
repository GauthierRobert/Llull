/**
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import type { BuildingElement, BuildingLevel } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { fileSlug, getBuilding, orderedElements, toMm } from './model';
import { noop } from '@core/commands/noop';
import { type Context, StepWriter, ifcGuid, ifcReal, ifcString, placement } from './ifcStep';
import { type Exported, exportCurvedWallElement, exportWallElement } from './ifcElementExport';
import { exportConnection, exportIndustrial, exportPlate } from './ifcIndustrialExport';
import { exportOther } from './ifcOtherExport';
import { exportPipeSupport } from './ifcSupportExport';

type LevelElement = Extract<BuildingElement, { levelId: string }>;

export interface IfcExport {
  readonly filename: string;
  readonly ifc: string;
  readonly entityCount: number;
  readonly productCount: number;
}

/** Every IFC product of one element placed on `level`, in export order (hosted openings follow their wall). */
function exportElement(
  context: Context,
  doc: CadDocument,
  element: LevelElement,
  level: BuildingLevel,
  storeyPlacement: string,
): Exported[] {
  const building = getBuilding(doc);
  switch (element.category) {
    case 'wall':
      return exportWallElement(context, building, element, storeyPlacement);
    case 'curvedWall':
      return exportCurvedWallElement(context, building, element, storeyPlacement);
    case 'member':
    case 'footing':
    case 'panel':
    case 'equipment':
    case 'pipe':
    case 'tray': {
      const exported = exportIndustrial(context, element, storeyPlacement);
      return exported ? [exported] : [];
    }
    case 'pipeSupport': {
      const pipe = building.elements[element.pipeId];
      const exported = exportPipeSupport(
        context,
        doc,
        building,
        element,
        pipe?.category === 'pipe' ? pipe : undefined,
        storeyPlacement,
      );
      return exported ? [exported] : [];
    }
    case 'connection':
      return exportConnection(context, doc, element, building, level, storeyPlacement);
    case 'plate': {
      const member = building.elements[element.memberId];
      return member?.category === 'member'
        ? exportPlate(context, doc, element, member, level, storeyPlacement)
        : [];
    }
    case 'slab':
    case 'column':
    case 'beam':
    case 'stair':
    case 'room':
      return [exportOther(context, element, level, storeyPlacement)];
  }
}

/** @pure */
function buildIfc(doc: CadDocument, timestamp: string): IfcExport {
  const building = getBuilding(doc);
  const writer = new StepWriter();
  const factor = toMm(doc, 1);
  const origin = writer.add('IFCCARTESIANPOINT((0.,0.,0.))');
  const zAxis = writer.add('IFCDIRECTION((0.,0.,1.))');
  const xAxis = writer.add('IFCDIRECTION((1.,0.,0.))');
  const worldAxes = writer.add(`IFCAXIS2PLACEMENT3D(${origin},${zAxis},${xAxis})`);
  const modelContext = writer.add(
    `IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${worldAxes},$)`,
  );
  const body = writer.add(
    `IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${modelContext},$,.MODEL_VIEW.,$)`,
  );
  const salt = building.uid ?? 'llull';
  const context: Context = {
    writer,
    guid: (seed) => ifcGuid(`${salt}:${seed}`),
    mm: (value) => value * factor,
    body,
    zAxis,
    xAxis,
  };
  const units = [
    writer.add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)'),
    writer.add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'),
    writer.add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'),
    writer.add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)'),
  ];
  const unitAssignment = writer.add(`IFCUNITASSIGNMENT((${units.join(',')}))`);
  const { project } = building;
  const projectRef = writer.add(
    `IFCPROJECT('${context.guid('project')}',$,${ifcString(project.name)},${ifcString(project.client)},$,$,$,(${modelContext}),${unitAssignment})`,
  );
  const sitePlacement = writer.add(`IFCLOCALPLACEMENT($,${worldAxes})`);
  const site = writer.add(
    `IFCSITE('${context.guid('site')}',$,'Site',${ifcString(project.address)},$,${sitePlacement},$,$,.ELEMENT.,$,$,$,$,$)`,
  );
  const buildingPlacement = placement(context, sitePlacement, 0, 0, 0);
  const buildingRef = writer.add(
    `IFCBUILDING('${context.guid('building')}',$,${ifcString(project.name)},$,$,${buildingPlacement},$,$,.ELEMENT.,$,$,$)`,
  );
  writer.add(
    `IFCRELAGGREGATES('${context.guid('rel:project-site')}',$,$,$,${projectRef},(${site}))`,
  );
  writer.add(
    `IFCRELAGGREGATES('${context.guid('rel:site-building')}',$,$,$,${site},(${buildingRef}))`,
  );
  const storeys: string[] = [];
  const byMaterial = new Map<string, string[]>();
  let productCount = 0;
  for (const levelId of building.levelOrder) {
    const level = building.levels[levelId];
    if (!level) continue;
    const storeyPlacement = placement(
      context,
      buildingPlacement,
      0,
      0,
      context.mm(level.elevation),
    );
    const storey = writer.add(
      `IFCBUILDINGSTOREY('${context.guid(level.id)}',$,${ifcString(level.name)},$,$,${storeyPlacement},$,$,.ELEMENT.,${ifcReal(context.mm(level.elevation))})`,
    );
    storeys.push(storey);
    const contained: string[] = [];
    const spaces: string[] = [];
    for (const element of orderedElements(building)) {
      if (!('levelId' in element) || element.levelId !== level.id) continue;
      for (const exported of exportElement(context, doc, element, level, storeyPlacement)) {
        (element.category === 'room' ? spaces : contained).push(exported.ref);
        productCount += 1;
        if (exported.material === null) continue;
        byMaterial.set(exported.material, [
          ...(byMaterial.get(exported.material) ?? []),
          exported.ref,
        ]);
      }
    }
    if (contained.length > 0) {
      writer.add(
        `IFCRELCONTAINEDINSPATIALSTRUCTURE('${context.guid(`rel:contains:${level.id}`)}',$,$,$,(${contained.join(',')}),${storey})`,
      );
    }
    if (spaces.length > 0) {
      writer.add(
        `IFCRELAGGREGATES('${context.guid(`rel:spaces:${level.id}`)}',$,$,$,${storey},(${spaces.join(',')}))`,
      );
    }
  }
  if (storeys.length > 0) {
    writer.add(
      `IFCRELAGGREGATES('${context.guid('rel:building-storeys')}',$,$,$,${buildingRef},(${storeys.join(',')}))`,
    );
  }
  for (const [material, refs] of byMaterial) {
    const materialRef = writer.add(`IFCMATERIAL(${ifcString(material)},$,$)`);
    writer.add(
      `IFCRELASSOCIATESMATERIAL('${context.guid(`rel:material:${material}`)}',$,$,$,(${refs.join(',')}),${materialRef})`,
    );
  }
  const name = fileSlug(project.name, 'project');
  const ifc = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [DesignTransferView_V1.0]'),'2;1');",
    `FILE_NAME(${ifcString(`${name}.ifc`)},${ifcString(timestamp)},(${ifcString(project.author)}),(''),'llull','llull',${ifcString(project.drawingNumber)});`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    writer.data(),
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
  return { filename: `${name}.ifc`, ifc, entityCount: writer.count, productCount };
}

/**
 * @command export_ifc
 * @pure read-only
 * @affects none; data = { filename, ifc, entityCount, productCount }
 * @failure no levels -> no data
 */
export const exportIfc = defineCommand({
  name: 'export_ifc',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Export the building model as IFC4 (OpenBIM, ISO 16739) for Revit, ArchiCAD, Tekla, Solibri, BIMcollab, ' +
    'Navisworks…: project / site / building / storeys, walls with real openings (IfcOpeningElement) filled by ' +
    'doors and windows, slabs (floor / roof / base slab), columns, beams, stairs, spaces and materials. ' +
    'GlobalIds are stable across exports. data.ifc holds the file text.',
  params: z.object({
    timestamp: z
      .string()
      .optional()
      .describe(
        'ISO 8601 timestamp written in the file header. Default: project date or 1970-01-01T00:00:00.',
      ),
  }),
  run: (doc, { timestamp }): CommandResult => {
    const building = getBuilding(doc);
    if (building.levelOrder.length === 0) {
      return noop(
        doc,
        'export_ifc: the building model has no levels (add_level / add_wall first).',
      );
    }
    const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(building.project.date);
    const stamp =
      timestamp ?? (isoDate ? `${building.project.date}T00:00:00` : '1970-01-01T00:00:00');
    const result = buildIfc(doc, stamp);
    const dateNote =
      timestamp === undefined && building.project.date !== '' && !isoDate
        ? ` Project date "${building.project.date}" is not YYYY-MM-DD, so the header uses ${stamp}.`
        : '';
    return {
      document: doc,
      summary: `IFC4 ${result.filename}: ${result.productCount} building element(s) on ${building.levelOrder.length} storey(s), ${result.entityCount} STEP entities.${dateNote}`,
      affected: [],
      data: result,
    };
  },
});
