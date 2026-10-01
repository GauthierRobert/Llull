/**
 * IFC4 (ISO 16739-1, STEP physical file) export of the building model for OpenBIM coordination
 * (Revit, ArchiCAD, Tekla, Solibri, BIMcollab, Navisworks…).
 * Lengths are written in millimetres whatever the document unit.
 * @layer core/commands/building
 */

import type { CadDocument, Vec2, Vec3 } from '../../model/types';
import type {
  BuildingElement,
  EquipmentElement,
  FootingElement,
  MemberRole,
  PanelElement,
  PipeElement,
  CableTrayElement,
  BasePlateElement,
  CurvedWallElement,
  MomentConnectionElement,
  SteelMemberElement,
  BuildingLevel,
  BuildingModel,
  OpeningElement,
  SlabElement,
  WallElement,
} from '../../model/building';
import type { CommandDefinition, CommandResult } from '../types';
import { toCounterClockwise } from '../../../lib/polygon';
import { fileSlug, getBuilding, noChange, toMetres } from './model';
import { openingsOf, wallExtent, wallFrame, type WallExtent } from './evaluate';
import { sweepFrame } from './mesh';
import {
  connectionSolids,
  panelFrame,
  plateLayout,
  trayOutline,
  type ConnectionSolid,
} from './industrial/evaluate';
import { curvedWallBand, tangentWall } from './curvedWallGeometry';
import { findProfile, type SteelProfile } from './steel/profiles';

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
    else if (code > 0xffff)
      out += `\\X4\\${code.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
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
  /** GlobalId for a seed, salted with the building uid. */
  readonly guid: (seed: string) => string;
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
  extent: WallExtent,
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
    [mm((extent.start + extent.end) / 2), 0],
    mm(extent.end - extent.start),
    mm(wall.thickness),
  );
  const ref = context.writer.add(
    `IFCWALL('${context.guid(wall.id)}',$,${ifcString(wall.mark)},$,$,${local},${shape(context, [extrusion(context, profile, mm(wall.height))])},${ifcString(wall.id)},.STANDARD.)`,
  );
  return { ref, material: wall.material, placement: local };
}

/** Material layer set usage for a layered wall (layers across local +Y, from −thickness/2). */
function exportWallLayers(context: Context, wall: WallElement, wallRef: string): void {
  const { mm, writer } = context;
  const layers = (wall.layers ?? []).map((layer) => {
    const material = writer.add(`IFCMATERIAL(${ifcString(layer.material)},$,$)`);
    return writer.add(
      `IFCMATERIALLAYER(${material},${ifcReal(mm(layer.thickness))},$,${ifcString(layer.material)},$,${ifcString(layer.function)},$)`,
    );
  });
  const set = writer.add(
    `IFCMATERIALLAYERSET((${layers.join(',')}),${ifcString(`${wall.mark} build-up`)},$)`,
  );
  const usage = writer.add(
    `IFCMATERIALLAYERSETUSAGE(${set},.AXIS2.,.POSITIVE.,${ifcReal(-mm(wall.thickness) / 2)},$)`,
  );
  writer.add(
    `IFCRELASSOCIATESMATERIAL('${context.guid(`rel:layers:${wall.id}`)}',$,$,$,(${wallRef}),${usage})`,
  );
}

function exportCurvedWall(
  context: Context,
  wall: CurvedWallElement,
  storeyPlacement: string,
): Exported | null {
  const { mm } = context;
  const band = curvedWallBand(wall);
  if (!band) return null;
  const local = placement(context, storeyPlacement, 0, 0, mm(wall.baseOffset));
  const profile = polygonProfile(
    context,
    band.map(([x, y]): Vec2 => [mm(x), mm(y)]),
  );
  const ref = context.writer.add(
    `IFCWALL('${context.guid(wall.id)}',$,${ifcString(wall.mark)},$,$,${local},${shape(context, [extrusion(context, profile, mm(wall.height))])},${ifcString(wall.id)},.STANDARD.)`,
  );
  return { ref, material: wall.material };
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
    `IFCOPENINGELEMENT('${context.guid(`${opening.id}:void`)}',$,${ifcString(`${opening.mark} opening`)},$,$,${voidPlacement},${shape(context, [extrusion(context, voidProfile, mm(opening.height))])},$,.OPENING.)`,
  );
  writer.add(
    `IFCRELVOIDSELEMENT('${context.guid(`${opening.id}:voids`)}',$,$,$,${host.ref},${voidRef})`,
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
  const common = `'${context.guid(opening.id)}',$,${ifcString(opening.mark)},$,$,${fillPlacement},${fillShape},${ifcString(opening.id)},${ifcReal(mm(opening.height))},${ifcReal(mm(opening.width))}`;
  const ref =
    opening.category === 'door'
      ? writer.add(
          `IFCDOOR(${common},.DOOR.,${opening.swing === 'left' ? '.SINGLE_SWING_LEFT.' : '.SINGLE_SWING_RIGHT.'},$)`,
        )
      : writer.add(`IFCWINDOW(${common},.WINDOW.,.SINGLE_PANEL.,$)`);
  writer.add(
    `IFCRELFILLSELEMENT('${context.guid(`${opening.id}:fills`)}',$,$,$,${voidRef},${ref})`,
  );
  storeyElements.push(ref);
  return { ref, material: opening.material };
}

function direction(context: Context, [x, y, z]: Vec3): string {
  return context.writer.add(`IFCDIRECTION((${ifcReal(x)},${ifcReal(y)},${ifcReal(z)}))`);
}

/** Local placement at `origin` (mm) with local Z = `axis` and local X = `reference`. */
function framePlacement(
  context: Context,
  relativeTo: string,
  origin: Vec3,
  axis: Vec3,
  reference: Vec3,
): string {
  const axes = context.writer.add(
    `IFCAXIS2PLACEMENT3D(${point3(context, origin[0], origin[1], origin[2])},${direction(context, axis)},${direction(context, reference)})`,
  );
  return context.writer.add(`IFCLOCALPLACEMENT(${relativeTo},${axes})`);
}

/** IFC parametric profile definition of a catalogue section (dimensions in mm). */
function steelProfileDef(context: Context, profile: SteelProfile): string {
  const position = context.writer.add(`IFCAXIS2PLACEMENT2D(${point2(context, [0, 0])},$)`);
  const name = ifcString(profile.name);
  const r = ifcReal;
  switch (profile.shape) {
    case 'I':
      return context.writer.add(
        `IFCISHAPEPROFILEDEF(.AREA.,${name},${position},${r(profile.b)},${r(profile.h)},${r(profile.tw)},${r(profile.tf)},$,$,$)`,
      );
    case 'U':
      return context.writer.add(
        `IFCUSHAPEPROFILEDEF(.AREA.,${name},${position},${r(profile.h)},${r(profile.b)},${r(profile.tw)},${r(profile.tf)},$,$,$)`,
      );
    case 'C':
      return context.writer.add(
        `IFCCSHAPEPROFILEDEF(.AREA.,${name},${position},${r(profile.h)},${r(profile.b)},${r(profile.tw)},${r(profile.lip)},$)`,
      );
    case 'L':
      return context.writer.add(
        `IFCLSHAPEPROFILEDEF(.AREA.,${name},${position},${r(profile.h)},${r(profile.b)},${r(profile.tw)},$,$,$)`,
      );
    case 'SHS':
    case 'RHS':
      return context.writer.add(
        `IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,${name},${position},${r(profile.b)},${r(profile.h)},${r(profile.tw)},$,$)`,
      );
    case 'CHS':
      return context.writer.add(
        `IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,${name},${position},${r(profile.h / 2)},${r(profile.tw)})`,
      );
  }
}

const MEMBER_CLASS: Readonly<Record<MemberRole, { entity: string; type: string }>> = {
  column: { entity: 'IFCCOLUMN', type: '.COLUMN.' },
  rafter: { entity: 'IFCBEAM', type: '.BEAM.' },
  beam: { entity: 'IFCBEAM', type: '.BEAM.' },
  crane: { entity: 'IFCBEAM', type: '.BEAM.' },
  brace: { entity: 'IFCMEMBER', type: '.BRACE.' },
  purlin: { entity: 'IFCMEMBER', type: '.PURLIN.' },
  rail: { entity: 'IFCMEMBER', type: '.MEMBER.' },
};

function exportIndustrial(
  context: Context,
  element:
    | SteelMemberElement
    | FootingElement
    | PanelElement
    | EquipmentElement
    | PipeElement
    | CableTrayElement,
  storeyPlacement: string,
): Exported | null {
  const { mm, writer } = context;
  const guid = context.guid(element.id);
  const mm3 = ([x, y, z]: Vec3): Vec3 => [mm(x), mm(y), mm(z)];
  switch (element.category) {
    case 'member': {
      const profile = findProfile(element.profile);
      const frame = sweepFrame(element.start, element.end, element.roll);
      if (!profile || !frame) return null;
      const local = framePlacement(context, storeyPlacement, mm3(element.start), frame.d, frame.u);
      const solid = extrusion(context, steelProfileDef(context, profile), mm(frame.length));
      const { entity, type } = MEMBER_CLASS[element.role];
      const ref = writer.add(
        `${entity}('${guid}',$,${ifcString(element.mark)},${ifcString(element.note ?? '')},${ifcString(profile.name)},${local},${shape(context, [solid])},${ifcString(element.id)},${type})`,
      );
      return { ref, material: element.material };
    }
    case 'footing': {
      const local = placement(
        context,
        storeyPlacement,
        mm(element.location[0]),
        mm(element.location[1]),
        mm(element.topOffset - element.thickness),
      );
      const profile = rectangleProfile(context, [0, 0], mm(element.width), mm(element.length));
      const ref = writer.add(
        `IFCFOOTING('${guid}',$,${ifcString(element.mark)},$,$,${local},${shape(context, [extrusion(context, profile, mm(element.thickness))])},${ifcString(element.id)},.PAD_FOOTING.)`,
      );
      return { ref, material: element.material };
    }
    case 'panel': {
      const frame = panelFrame(element.corners.map(mm3));
      if (!frame) return null;
      const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const outline = element.corners.map(mm3).map((corner): Vec2 => {
        const offset: Vec3 = [
          corner[0] - frame.origin[0],
          corner[1] - frame.origin[1],
          corner[2] - frame.origin[2],
        ];
        return [dot(offset, frame.e1), dot(offset, frame.e2)];
      });
      const local = framePlacement(context, storeyPlacement, frame.origin, frame.normal, frame.e1);
      const solid = extrusion(context, polygonProfile(context, outline), mm(element.thickness));
      const ref = writer.add(
        `IFCCOVERING('${guid}',$,${ifcString(element.mark)},$,$,${local},${shape(context, [solid])},${ifcString(element.id)},${element.role === 'roof' ? '.ROOFING.' : '.CLADDING.'})`,
      );
      return { ref, material: element.material };
    }
    case 'equipment': {
      const [length, width, height] = element.size;
      const local = placement(
        context,
        storeyPlacement,
        mm(element.location[0]),
        mm(element.location[1]),
        0,
        element.angle,
      );
      const profile = rectangleProfile(context, [0, 0], mm(length), mm(width));
      const ref = writer.add(
        `IFCBUILDINGELEMENTPROXY('${guid}',$,${ifcString(element.mark)},$,${ifcString(element.name)},${local},${shape(context, [extrusion(context, profile, mm(height))])},${ifcString(element.id)},.ELEMENT.)`,
      );
      return { ref, material: null };
    }
    case 'pipe': {
      const local = placement(context, storeyPlacement, 0, 0, 0);
      const position = writer.add(`IFCAXIS2PLACEMENT2D(${point2(context, [0, 0])},$)`);
      const circle = writer.add(
        `IFCCIRCLEPROFILEDEF(.AREA.,$,${position},${ifcReal(mm(element.diameter) / 2)})`,
      );
      const solids: string[] = [];
      for (let index = 0; index + 1 < element.points.length; index++) {
        const start = mm3(element.points[index] as Vec3);
        const frame = sweepFrame(start, mm3(element.points[index + 1] as Vec3));
        if (!frame) continue;
        const axes = writer.add(
          `IFCAXIS2PLACEMENT3D(${point3(context, start[0], start[1], start[2])},${direction(context, frame.d)},${direction(context, frame.u)})`,
        );
        solids.push(
          writer.add(
            `IFCEXTRUDEDAREASOLID(${circle},${axes},${context.zAxis},${ifcReal(frame.length)})`,
          ),
        );
      }
      if (solids.length === 0) return null;
      const ref = writer.add(
        `IFCPIPESEGMENT('${guid}',$,${ifcString(element.mark)},${ifcString(element.service)},$,${local},${shape(context, solids)},${ifcString(element.id)},.RIGIDSEGMENT.)`,
      );
      return { ref, material: element.material };
    }
    case 'tray': {
      const local = placement(context, storeyPlacement, 0, 0, 0);
      const profile = polygonProfile(
        context,
        trayOutline(mm(element.width), mm(element.height), 2),
      );
      const solids: string[] = [];
      for (let index = 0; index + 1 < element.points.length; index++) {
        const start = mm3(element.points[index] as Vec3);
        const frame = sweepFrame(start, mm3(element.points[index + 1] as Vec3));
        if (!frame) continue;
        const axes = writer.add(
          `IFCAXIS2PLACEMENT3D(${point3(context, start[0], start[1], start[2])},${direction(context, frame.d)},${direction(context, frame.u)})`,
        );
        solids.push(
          writer.add(
            `IFCEXTRUDEDAREASOLID(${profile},${axes},${context.zAxis},${ifcReal(frame.length)})`,
          ),
        );
      }
      if (solids.length === 0) return null;
      const ref = writer.add(
        `IFCCABLECARRIERSEGMENT('${guid}',$,${ifcString(element.mark)},${ifcString(element.system)},$,${local},${shape(context, solids)},${ifcString(element.id)},.CABLETRAYSEGMENT.)`,
      );
      return { ref, material: 'galvanized steel' };
    }
  }
}

/** A moment connection: end plate(s) (IfcPlate), haunch (IfcMember), bolt group (fastener). */
function exportConnection(
  context: Context,
  units: Pick<CadDocument, 'units'>,
  connection: MomentConnectionElement,
  building: BuildingModel,
  level: BuildingLevel,
  storeyPlacement: string,
): Exported[] {
  const { mm, writer } = context;
  const members: Record<string, SteelMemberElement | undefined> = {};
  for (const id of [connection.rafterId, connection.otherId]) {
    const member = building.elements[id];
    if (member?.category === 'member') members[id] = member;
  }
  const solids = connectionSolids(units, connection, members, level);
  if (!solids) return [];
  const solidOf = (solid: ConnectionSolid): { placement: string; body: string } => ({
    placement: framePlacement(
      context,
      storeyPlacement,
      [mm(solid.origin[0]), mm(solid.origin[1]), mm(solid.origin[2] - level.elevation)],
      solid.along,
      solid.x,
    ),
    body: extrusion(
      context,
      polygonProfile(
        context,
        solid.outline.map(([x, y]): Vec2 => [mm(x), mm(y)]),
      ),
      mm(solid.depth),
    ),
  });
  const exported: Exported[] = [];
  for (const solid of solids.filter((candidate) => !candidate.part.startsWith('bolt'))) {
    const { placement: local, body } = solidOf(solid);
    const haunch = solid.part === 'haunch';
    const ref = writer.add(
      haunch
        ? `IFCMEMBER('${context.guid(`${connection.id}:${solid.part}`)}',$,${ifcString(`${connection.mark} haunch`)},$,'HAUNCH',${local},${shape(context, [body])},${ifcString(connection.id)},.USERDEFINED.)`
        : `IFCPLATE('${context.guid(`${connection.id}:${solid.part}`)}',$,${ifcString(`${connection.mark} end plate`)},$,'END_PLATE',${local},${shape(context, [body])},${ifcString(connection.id)},.USERDEFINED.)`,
    );
    exported.push({ ref, material: connection.material });
  }
  // Bolts: one fastener product, each bolt its own extrusion in its own frame.
  const bolts = solids.filter((solid) => solid.part.startsWith('bolt'));
  if (bolts.length > 0) {
    const items = bolts.map((bolt) => {
      const axes = writer.add(
        `IFCAXIS2PLACEMENT3D(${point3(context, mm(bolt.origin[0]), mm(bolt.origin[1]), mm(bolt.origin[2] - level.elevation))},${direction(context, bolt.along)},${direction(context, bolt.x)})`,
      );
      const profile = polygonProfile(
        context,
        bolt.outline.map(([x, y]): Vec2 => [mm(x), mm(y)]),
      );
      return writer.add(
        `IFCEXTRUDEDAREASOLID(${profile},${axes},${context.zAxis},${ifcReal(mm(bolt.depth))})`,
      );
    });
    const ref = writer.add(
      `IFCMECHANICALFASTENER('${context.guid(`${connection.id}:bolts`)}',$,${ifcString(`${connection.mark} bolts`)},$,$,${placement(context, storeyPlacement, 0, 0, 0)},${shape(context, items)},$,${ifcReal(mm(connection.boltDiameter))},${ifcReal(mm(bolts[0]?.depth ?? 0))},.BOLT.)`,
    );
    exported.push({ ref, material: connection.material });
  }
  return exported;
}

/** A base plate (IfcPlate) and its anchor bolts (IfcMechanicalFastener). */
function exportPlate(
  context: Context,
  units: Pick<CadDocument, 'units'>,
  plate: BasePlateElement,
  member: SteelMemberElement,
  level: BuildingLevel,
  storeyPlacement: string,
): Exported[] {
  const { mm, writer } = context;
  const layout = plateLayout(units, plate, member, level);
  if (!layout) return [];
  const [cx, cy, cz] = layout.center;
  const bottom = cz - level.elevation - plate.thickness / 2;
  const local = placement(context, storeyPlacement, mm(cx), mm(cy), mm(bottom), layout.angle);
  const body = extrusion(
    context,
    rectangleProfile(context, [0, 0], mm(plate.length), mm(plate.width)),
    mm(plate.thickness),
  );
  const plateRef = writer.add(
    `IFCPLATE('${context.guid(plate.id)}',$,${ifcString(plate.mark)},$,'BASE_PLATE',${local},${shape(context, [body])},${ifcString(plate.id)},.USERDEFINED.)`,
  );
  const origin = writer.add(`IFCAXIS2PLACEMENT2D(${point2(context, [0, 0])},$)`);
  const circle = writer.add(
    `IFCCIRCLEPROFILEDEF(.AREA.,$,${origin},${ifcReal(mm(plate.boltDiameter) / 2)})`,
  );
  const boltLength = layout.boltBelow + plate.thickness + layout.boltAbove;
  const boltBottom = bottom - layout.boltBelow;
  const bolts = layout.bolts.map(([x, y]) =>
    extrusion(context, circle, mm(boltLength), mm(x), mm(y), mm(boltBottom)),
  );
  const fastenerRef = writer.add(
    `IFCMECHANICALFASTENER('${context.guid(`${plate.id}:bolts`)}',$,${ifcString(`${plate.mark} anchors`)},$,$,${placement(context, storeyPlacement, 0, 0, 0)},${shape(context, bolts)},$,${ifcReal(mm(plate.boltDiameter))},${ifcReal(mm(boltLength))},.ANCHORBOLT.)`,
  );
  return [
    { ref: plateRef, material: plate.material },
    { ref: fastenerRef, material: plate.material },
  ];
}

const SLAB_TYPE: Readonly<Record<SlabElement['role'], string>> = {
  floor: '.FLOOR.',
  roof: '.ROOF.',
  foundation: '.BASESLAB.',
};

function exportOther(
  context: Context,
  element: Extract<BuildingElement, { category: 'slab' | 'column' | 'beam' | 'stair' | 'room' }>,
  level: BuildingLevel,
  storeyPlacement: string,
): Exported & { isSpace: boolean } {
  const { mm, writer } = context;
  const guid = context.guid(element.id);
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
      (element.openings ?? []).forEach((opening, index) => {
        const voidProfile = polygonProfile(
          context,
          opening.map(([x, y]): Vec2 => [mm(x), mm(y)]),
        );
        const voidRef = writer.add(
          `IFCOPENINGELEMENT('${context.guid(`${element.id}:void-${index}`)}',$,${ifcString(`${element.mark} opening ${index + 1}`)},$,$,${placement(context, local, 0, 0, 0)},${shape(context, [extrusion(context, voidProfile, mm(element.thickness) + 20, 0, 0, -10)])},$,.OPENING.)`,
        );
        writer.add(
          `IFCRELVOIDSELEMENT('${context.guid(`${element.id}:voids-${index}`)}',$,$,$,${ref},${voidRef})`,
        );
      });
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
        if (element.layers) exportWallLayers(context, element, wall.ref);
        else record(wall);
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
        const exported = exportCurvedWall(context, element, storeyPlacement);
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
          record(exportOpening(context, opening, tangent, host, contained));
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
