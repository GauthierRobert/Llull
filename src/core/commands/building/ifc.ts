/**
 * IFC4 (ISO 16739-1, STEP physical file) export of the building model for OpenBIM coordination
 * (Revit, ArchiCAD, Tekla, Solibri, BIMcollab, Navisworks…).
 * Lengths are written in millimetres whatever the document unit.
 * @layer core/commands/building
 */

import type { CadDocument, Vec2 } from '../../model/types';
import type {
  BuildingElement,
  BuildingLevel,
  OpeningElement,
  SlabElement,
  WallElement,
} from '../../model/building';
import type { CommandDefinition, CommandResult } from '../types';
import { toCounterClockwise } from '../../../lib/polygon';
import { fileSlug, getBuilding, noChange, toMetres } from './model';
import { wallFrame } from './evaluate';

const GUID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** Deterministic 22-character IFC GlobalId derived from a seed (FNV-1a, 128 bits). */
export function ifcGuid(seed: string): string {
  const words = [0x811c9dc5, 0x01000193, 0x1b873593, 0xcc9e2d51];
  for (let index = 0; index < seed.length; index++) {
    const code = seed.charCodeAt(index);
    for (let word = 0; word < 4; word++) {
      words[word] = Math.imul((words[word] as number) ^ (code + word * 31), 0x01000193) >>> 0;
    }
  }
  let bits = '';
  for (const word of words) bits += word.toString(2).padStart(32, '0');
  let guid = GUID_ALPHABET[parseInt(bits.slice(0, 2), 2)] as string;
  for (let offset = 2; offset < 128; offset += 6) {
    guid += GUID_ALPHABET[parseInt(bits.slice(offset, offset + 6), 2)] as string;
  }
  return guid;
}

/** STEP string literal with IFC escapes (\X2\ for non-ASCII). */
export function ifcString(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 63;
    if (character === "'") out += "''";
    else if (character === '\\') out += '\\\\';
    else if (code >= 32 && code < 127) out += character;
    else out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
  }
  return `'${out}'`;
}

/** STEP REAL: always carries a decimal point. */
export function ifcReal(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  if (rounded === 0) return '0.';
  const text = String(rounded);
  if (text.includes('e'))
    return rounded
      .toExponential()
      .replace('e', 'E')
      .replace(/^(-?\d+)E/, '$1.E');
  return text.includes('.') ? text : `${text}.`;
}

class StepWriter {
  private readonly records: string[] = [];

  add(entity: string): string {
    this.records.push(entity);
    return `#${this.records.length}`;
  }

  get count(): number {
    return this.records.length;
  }

  data(): string {
    return this.records.map((record, index) => `#${index + 1}=${record};`).join('\n');
  }
}

interface Context {
  readonly writer: StepWriter;
  readonly mm: (value: number) => number;
  readonly body: string;
  readonly zAxis: string;
  readonly xAxis: string;
}

function point3(context: Context, x: number, y: number, z: number): string {
  return context.writer.add(`IFCCARTESIANPOINT((${ifcReal(x)},${ifcReal(y)},${ifcReal(z)}))`);
}

function point2(context: Context, [x, y]: Vec2): string {
  return context.writer.add(`IFCCARTESIANPOINT((${ifcReal(x)},${ifcReal(y)}))`);
}

function axis3(context: Context, origin: string, angle = 0): string {
  const reference =
    angle === 0
      ? context.xAxis
      : context.writer.add(
          `IFCDIRECTION((${ifcReal(Math.cos(angle))},${ifcReal(Math.sin(angle))},0.))`,
        );
  return context.writer.add(`IFCAXIS2PLACEMENT3D(${origin},${context.zAxis},${reference})`);
}

function placement(
  context: Context,
  relativeTo: string,
  x: number,
  y: number,
  z: number,
  angle = 0,
): string {
  return context.writer.add(
    `IFCLOCALPLACEMENT(${relativeTo},${axis3(context, point3(context, x, y, z), angle)})`,
  );
}

function extrusion(context: Context, profile: string, depth: number, x = 0, y = 0, z = 0): string {
  return context.writer.add(
    `IFCEXTRUDEDAREASOLID(${profile},${axis3(context, point3(context, x, y, z))},${context.zAxis},${ifcReal(depth)})`,
  );
}

function rectangleProfile(context: Context, center: Vec2, xDim: number, yDim: number): string {
  const position = context.writer.add(`IFCAXIS2PLACEMENT2D(${point2(context, center)},$)`);
  return context.writer.add(
    `IFCRECTANGLEPROFILEDEF(.AREA.,$,${position},${ifcReal(xDim)},${ifcReal(yDim)})`,
  );
}

function polygonProfile(context: Context, points: ReadonlyArray<Vec2>): string {
  const refs = toCounterClockwise(points).map((point) => point2(context, point));
  const polyline = context.writer.add(`IFCPOLYLINE((${[...refs, refs[0]].join(',')}))`);
  return context.writer.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${polyline})`);
}

function shape(context: Context, items: ReadonlyArray<string>): string {
  const representation = context.writer.add(
    `IFCSHAPEREPRESENTATION(${context.body},'Body','SweptSolid',(${items.join(',')}))`,
  );
  return context.writer.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${representation}))`);
}

interface Exported {
  readonly ref: string;
  readonly material: string | null;
}

function exportWall(
  context: Context,
  wall: WallElement,
  storeyPlacement: string,
): Exported & { placement: string } {
  const { mm } = context;
  const frame = wallFrame(wall);
  const local = placement(
    context,
    storeyPlacement,
    mm(wall.start[0]),
    mm(wall.start[1]),
    mm(wall.baseOffset),
    frame.angle,
  );
  const profile = rectangleProfile(
    context,
    [mm(frame.length) / 2, 0],
    mm(frame.length),
    mm(wall.thickness),
  );
  const ref = context.writer.add(
    `IFCWALL('${ifcGuid(wall.id)}',$,${ifcString(wall.mark)},$,$,${local},${shape(context, [extrusion(context, profile, mm(wall.height))])},${ifcString(wall.id)},.STANDARD.)`,
  );
  return { ref, material: wall.material, placement: local };
}

function exportOpening(
  context: Context,
  opening: OpeningElement,
  wall: WallElement,
  host: { readonly ref: string; readonly placement: string },
  storeyElements: string[],
): Exported {
  const { mm, writer } = context;
  const left = opening.offset - opening.width / 2;
  const voidPlacement = placement(context, host.placement, mm(left), 0, mm(opening.sillHeight));
  const voidProfile = rectangleProfile(
    context,
    [mm(opening.width) / 2, 0],
    mm(opening.width),
    mm(wall.thickness) + 20,
  );
  const voidRef = writer.add(
    `IFCOPENINGELEMENT('${ifcGuid(`${opening.id}:void`)}',$,${ifcString(`${opening.mark} opening`)},$,$,${voidPlacement},${shape(context, [extrusion(context, voidProfile, mm(opening.height))])},$,.OPENING.)`,
  );
  writer.add(
    `IFCRELVOIDSELEMENT('${ifcGuid(`${opening.id}:voids`)}',$,$,$,${host.ref},${voidRef})`,
  );
  const panelThickness = Math.min(mm(wall.thickness), opening.category === 'door' ? 40 : 24);
  const fillPlacement = placement(context, voidPlacement, 0, 0, 0);
  const fillProfile = rectangleProfile(
    context,
    [mm(opening.width) / 2, 0],
    mm(opening.width),
    panelThickness,
  );
  const fillShape = shape(context, [extrusion(context, fillProfile, mm(opening.height))]);
  const common = `'${ifcGuid(opening.id)}',$,${ifcString(opening.mark)},$,$,${fillPlacement},${fillShape},${ifcString(opening.id)},${ifcReal(mm(opening.height))},${ifcReal(mm(opening.width))}`;
  const ref =
    opening.category === 'door'
      ? writer.add(
          `IFCDOOR(${common},.DOOR.,${opening.swing === 'left' ? '.SINGLE_SWING_LEFT.' : '.SINGLE_SWING_RIGHT.'},$)`,
        )
      : writer.add(`IFCWINDOW(${common},.WINDOW.,.SINGLE_PANEL.,$)`);
  writer.add(`IFCRELFILLSELEMENT('${ifcGuid(`${opening.id}:fills`)}',$,$,$,${voidRef},${ref})`);
  storeyElements.push(ref);
  return { ref, material: opening.material };
}

const SLAB_TYPE: Readonly<Record<SlabElement['role'], string>> = {
  floor: '.FLOOR.',
  roof: '.ROOF.',
  foundation: '.BASESLAB.',
};

function exportOther(
  context: Context,
  element: Exclude<BuildingElement, WallElement | OpeningElement | { category: 'grid' }>,
  level: BuildingLevel,
  storeyPlacement: string,
): Exported & { isSpace: boolean } {
  const { mm, writer } = context;
  const guid = ifcGuid(element.id);
  switch (element.category) {
    case 'slab': {
      const local = placement(
        context,
        storeyPlacement,
        0,
        0,
        mm(element.offset - element.thickness),
      );
      const profile = polygonProfile(
        context,
        element.boundary.map(([x, y]): Vec2 => [mm(x), mm(y)]),
      );
      const ref = writer.add(
        `IFCSLAB('${guid}',$,${ifcString(element.mark)},$,$,${local},${shape(context, [extrusion(context, profile, mm(element.thickness))])},${ifcString(element.id)},${SLAB_TYPE[element.role]})`,
      );
      return { ref, material: element.material, isSpace: false };
    }
    case 'column': {
      const local = placement(
        context,
        storeyPlacement,
        mm(element.location[0]),
        mm(element.location[1]),
        0,
      );
      const position = writer.add(`IFCAXIS2PLACEMENT2D(${point2(context, [0, 0])},$)`);
      const profile =
        element.shape === 'circular'
          ? writer.add(
              `IFCCIRCLEPROFILEDEF(.AREA.,$,${position},${ifcReal(mm(element.width) / 2)})`,
            )
          : writer.add(
              `IFCRECTANGLEPROFILEDEF(.AREA.,$,${position},${ifcReal(mm(element.width))},${ifcReal(mm(element.depth))})`,
            );
      const ref = writer.add(
        `IFCCOLUMN('${guid}',$,${ifcString(element.mark)},$,$,${local},${shape(context, [extrusion(context, profile, mm(element.height))])},${ifcString(element.id)},.COLUMN.)`,
      );
      return { ref, material: element.material, isSpace: false };
    }
    case 'beam': {
      const frame = wallFrame(element);
      const top = level.height + element.topOffset;
      const local = placement(
        context,
        storeyPlacement,
        mm(element.start[0]),
        mm(element.start[1]),
        mm(top - element.depth),
        frame.angle,
      );
      const profile = rectangleProfile(
        context,
        [mm(frame.length) / 2, 0],
        mm(frame.length),
        mm(element.width),
      );
      const ref = writer.add(
        `IFCBEAM('${guid}',$,${ifcString(element.mark)},$,$,${local},${shape(context, [extrusion(context, profile, mm(element.depth))])},${ifcString(element.id)},.BEAM.)`,
      );
      return { ref, material: element.material, isSpace: false };
    }
    case 'stair': {
      const local = placement(
        context,
        storeyPlacement,
        mm(element.start[0]),
        mm(element.start[1]),
        0,
        element.angle,
      );
      const steps: string[] = [];
      for (let index = 0; index < element.riserCount; index++) {
        const profile = rectangleProfile(
          context,
          [mm((index + 0.5) * element.treadDepth), 0],
          mm(element.treadDepth),
          mm(element.width),
        );
        steps.push(extrusion(context, profile, mm((index + 1) * element.riserHeight)));
      }
      const ref = writer.add(
        `IFCSTAIR('${guid}',$,${ifcString(element.mark)},$,$,${local},${shape(context, steps)},${ifcString(element.id)},.STRAIGHT_RUN_STAIR.)`,
      );
      return { ref, material: element.material, isSpace: false };
    }
    case 'room': {
      const local = placement(context, storeyPlacement, 0, 0, 0);
      const profile = polygonProfile(
        context,
        element.boundary.map(([x, y]): Vec2 => [mm(x), mm(y)]),
      );
      const ref = writer.add(
        `IFCSPACE('${guid}',$,${ifcString(element.mark)},$,$,${local},${shape(context, [extrusion(context, profile, mm(level.height))])},${ifcString(element.name)},.ELEMENT.,.INTERNAL.,$)`,
      );
      return { ref, material: null, isSpace: true };
    }
  }
}

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
  const context: Context = { writer, mm: (value) => value * factor, body, zAxis, xAxis };
  const units = [
    writer.add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)'),
    writer.add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'),
    writer.add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'),
    writer.add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)'),
  ];
  const unitAssignment = writer.add(`IFCUNITASSIGNMENT((${units.join(',')}))`);
  const { project } = building;
  const projectRef = writer.add(
    `IFCPROJECT('${ifcGuid('project')}',$,${ifcString(project.name)},${ifcString(project.client)},$,$,$,(${modelContext}),${unitAssignment})`,
  );
  const sitePlacement = writer.add(`IFCLOCALPLACEMENT($,${worldAxes})`);
  const site = writer.add(
    `IFCSITE('${ifcGuid('site')}',$,'Site',${ifcString(project.address)},$,${sitePlacement},$,$,.ELEMENT.,$,$,$,$,$)`,
  );
  const buildingPlacement = placement(context, sitePlacement, 0, 0, 0);
  const buildingRef = writer.add(
    `IFCBUILDING('${ifcGuid('building')}',$,${ifcString(project.name)},$,$,${buildingPlacement},$,$,.ELEMENT.,$,$,$)`,
  );
  writer.add(`IFCRELAGGREGATES('${ifcGuid('rel:project-site')}',$,$,$,${projectRef},(${site}))`);
  writer.add(`IFCRELAGGREGATES('${ifcGuid('rel:site-building')}',$,$,$,${site},(${buildingRef}))`);
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
      `IFCBUILDINGSTOREY('${ifcGuid(level.id)}',$,${ifcString(level.name)},$,$,${storeyPlacement},$,$,.ELEMENT.,${ifcReal(context.mm(level.elevation))})`,
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
        const wall = exportWall(context, element, storeyPlacement);
        contained.push(wall.ref);
        record(wall);
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
      const exported = exportOther(context, element, level, storeyPlacement);
      (exported.isSpace ? spaces : contained).push(exported.ref);
      record(exported);
    }
    if (contained.length > 0) {
      writer.add(
        `IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid(`rel:contains:${level.id}`)}',$,$,$,(${contained.join(',')}),${storey})`,
      );
    }
    if (spaces.length > 0) {
      writer.add(
        `IFCRELAGGREGATES('${ifcGuid(`rel:spaces:${level.id}`)}',$,$,$,${storey},(${spaces.join(',')}))`,
      );
    }
  }
  if (storeys.length > 0) {
    writer.add(
      `IFCRELAGGREGATES('${ifcGuid('rel:building-storeys')}',$,$,$,${buildingRef},(${storeys.join(',')}))`,
    );
  }
  for (const [material, refs] of byMaterial) {
    const materialRef = writer.add(`IFCMATERIAL(${ifcString(material)},$,$)`);
    writer.add(
      `IFCRELASSOCIATESMATERIAL('${ifcGuid(`rel:material:${material}`)}',$,$,$,(${refs.join(',')}),${materialRef})`,
    );
  }
  const name = fileSlug(project.name, 'project');
  const ifc = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
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

interface ExportIfcParams {
  timestamp?: string;
}

/**
 * @command export_ifc
 * @pure read-only
 * @affects none; data = { filename, ifc, entityCount, productCount }
 * @failure no levels -> no data
 */
export const exportIfc: CommandDefinition<ExportIfcParams> = {
  name: 'export_ifc',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Export the building model as IFC4 (OpenBIM, ISO 16739) for Revit, ArchiCAD, Tekla, Solibri, BIMcollab, ' +
    'Navisworks…: project / site / building / storeys, walls with real openings (IfcOpeningElement) filled by ' +
    'doors and windows, slabs (floor / roof / base slab), columns, beams, stairs, spaces and materials. ' +
    'GlobalIds are stable across exports. data.ifc holds the file text.',
  paramsSchema: {
    type: 'object',
    properties: {
      timestamp: {
        type: 'string',
        description:
          'ISO 8601 timestamp written in the file header. Default: project date or 1970-01-01T00:00:00.',
      },
    },
    required: [],
  },
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
};
