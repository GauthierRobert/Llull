/**
 * ifc: ifcBuild.
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { fileSlug, getBuilding, noChange, toMetres } from './model';
import { openingsOf, wallExtent, wallFrame } from './evaluate';
import { curvedWallArc, curvedWallExtent, tangentWall } from './curvedWallGeometry';
import { type Context, StepWriter, ifcGuid, ifcReal, ifcString, placement } from './ifcStep';
import {
  type Exported,
  exportCurvedWall,
  exportOpening,
  exportWall,
  exportWallLayers,
} from './ifcElementExport';
import { exportConnection, exportIndustrial, exportPlate } from './ifcIndustrialExport';
import { exportOther } from './ifcOtherExport';

export interface IfcExport {
  readonly filename: string;
  readonly ifc: string;
  readonly entityCount: number;
  readonly productCount: number;
}

/** @pure */
export function buildIfc(doc: CadDocument, timestamp: string): IfcExport {
  const building = getBuilding(doc);
  const writer = new StepWriter();
  const factor = toMetres(doc, 1) * 1000;
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
    const record = (exported: Exported): void => {
      productCount += 1;
      if (exported.material === null) return;
      byMaterial.set(exported.material, [
        ...(byMaterial.get(exported.material) ?? []),
        exported.ref,
      ]);
    };
    for (const id of building.elementOrder) {
      const element = building.elements[id];
      if (!element || !('levelId' in element) || element.levelId !== level.id) continue;
      if (element.category === 'wall') {
        const wall = exportWall(context, element, wallExtent(building, element), storeyPlacement);
        contained.push(wall.ref);
        if (element.layers) {
          exportWallLayers(context, element, wall.ref);
          record({ ...wall, material: null });
        } else {
          record(wall);
        }
        for (const openingId of building.elementOrder) {
          const opening = building.elements[openingId];
          if (
            (opening?.category === 'door' || opening?.category === 'window') &&
            opening.hostId === element.id
          ) {
            record(exportOpening(context, opening, element, wall, contained));
          }
        }
        continue;
      }
      if (
        element.category === 'member' ||
        element.category === 'footing' ||
        element.category === 'panel' ||
        element.category === 'equipment' ||
        element.category === 'pipe' ||
        element.category === 'tray'
      ) {
        const industrial = exportIndustrial(context, element, storeyPlacement);
        if (industrial) {
          contained.push(industrial.ref);
          record(industrial);
        }
        continue;
      }
      if (element.category === 'curvedWall') {
        const exported = exportCurvedWall(
          context,
          element,
          curvedWallExtent(building, element),
          storeyPlacement,
        );
        if (!exported) continue;
        contained.push(exported.ref);
        record(exported);
        for (const opening of openingsOf(building, element.id)) {
          // Openings sit on the tangent to the arc at their offset.
          const tangent = tangentWall(element, opening.offset);
          const host = {
            ref: exported.ref,
            placement: placement(
              context,
              storeyPlacement,
              context.mm(tangent.start[0]),
              context.mm(tangent.start[1]),
              context.mm(element.baseOffset),
              wallFrame(tangent).angle,
            ),
          };
          // The arc leaves the tangent by its sagitta at the jambs: deepen the void to cut through.
          const radius = curvedWallArc(element)?.radius ?? 0;
          const half = Math.min(opening.width / 2, radius);
          const sagitta = radius - Math.sqrt(radius * radius - half * half);
          record(
            exportOpening(
              context,
              opening,
              { ...tangent, thickness: element.thickness + 2 * sagitta },
              host,
              contained,
            ),
          );
        }
        continue;
      }
      if (element.category === 'connection') {
        for (const exported of exportConnection(
          context,
          doc,
          element,
          building,
          level,
          storeyPlacement,
        )) {
          contained.push(exported.ref);
          record(exported);
        }
        continue;
      }
      if (element.category === 'plate') {
        const member = building.elements[element.memberId];
        if (member?.category !== 'member') continue;
        for (const exported of exportPlate(context, doc, element, member, level, storeyPlacement)) {
          contained.push(exported.ref);
          record(exported);
        }
        continue;
      }
      const exported = exportOther(context, element, level, storeyPlacement);
      (exported.isSpace ? spaces : contained).push(exported.ref);
      record(exported);
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
      return noChange(
        doc,
        'export_ifc: the building model has no levels (add_level / add_wall first).',
      );
    }
    const stamp =
      timestamp ??
      (building.project.date ? `${building.project.date}T00:00:00` : '1970-01-01T00:00:00');
    const result = buildIfc(doc, stamp);
    return {
      document: doc,
      summary: `IFC4 ${result.filename}: ${result.productCount} building element(s) on ${building.levelOrder.length} storey(s), ${result.entityCount} STEP entities.`,
      affected: [],
      data: result,
    };
  },
});
