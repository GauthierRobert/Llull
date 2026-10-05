/**
 * @layer domain-aec
 */

import type { CadDocument, Vec2, Vec3 } from '@core/model/types';
import type {
  EquipmentElement,
  FootingElement,
  PanelElement,
  PipeElement,
  CableTrayElement,
  BasePlateElement,
  MomentConnectionElement,
  SteelMemberElement,
  BuildingLevel,
  BuildingModel,
  MemberRole,
} from '@core/model/building';
import { sweepFrame } from './mesh';
import { panelFrame, trayOutline } from './industrial/evaluate';
import {
  buildingConnectionSolids,
  plateLayout,
  type ConnectionSolid,
} from './industrial/evaluateConnections';
import { type SteelProfile, findProfile } from './steel/profiles';
import {
  type Context,
  circleProfile,
  direction,
  extrusion,
  framePlacement,
  ifcReal,
  ifcString,
  placement,
  point2,
  point3,
  polygonProfile,
  scaledPolygonProfile,
  rectangleProfile,
  shape,
} from './ifcStep';
import type { Exported } from './ifcElementExport';
import { dot3 } from '@lib/vec3';

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

/** One extruded-area solid per non-degenerate segment of a polyline, the profile swept along it. */
function sweptSolids(context: Context, profileRef: string, points: ReadonlyArray<Vec3>): string[] {
  const solids: string[] = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const start = points[index] as Vec3;
    const frame = sweepFrame(start, points[index + 1] as Vec3);
    if (!frame) continue;
    const axes = context.writer.add(
      `IFCAXIS2PLACEMENT3D(${point3(context, start[0], start[1], start[2])},${direction(context, frame.d)},${direction(context, frame.u)})`,
    );
    solids.push(
      context.writer.add(
        `IFCEXTRUDEDAREASOLID(${profileRef},${axes},${context.zAxis},${ifcReal(frame.length)})`,
      ),
    );
  }
  return solids;
}

export function exportIndustrial(
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
      const outline = element.corners.map(mm3).map((corner): Vec2 => {
        const offset: Vec3 = [
          corner[0] - frame.origin[0],
          corner[1] - frame.origin[1],
          corner[2] - frame.origin[2],
        ];
        return [dot3(offset, frame.e1), dot3(offset, frame.e2)];
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
      const properties = [
        `IFCPROPERTYSINGLEVALUE('OperatingWeight','Operating weight in kg',IFCMASSMEASURE(${ifcReal(element.weight)}),$)`,
        `IFCPROPERTYSINGLEVALUE('MaintenanceClearance','Free space around the footprint, mm',IFCLENGTHMEASURE(${ifcReal(mm(element.clearance))}),$)`,
      ].map((property) => writer.add(property));
      const propertySet = writer.add(
        `IFCPROPERTYSET('${context.guid(`${element.id}:pset`)}',$,'Pset_llullEquipment',$,(${properties.join(',')}))`,
      );
      writer.add(
        `IFCRELDEFINESBYPROPERTIES('${context.guid(`${element.id}:rel-pset`)}',$,$,$,(${ref}),${propertySet})`,
      );
      return { ref, material: null };
    }
    case 'pipe': {
      const local = placement(context, storeyPlacement, 0, 0, 0);
      const circle = circleProfile(context, mm(element.diameter) / 2);
      const solids = sweptSolids(context, circle, element.points.map(mm3));
      if (solids.length === 0) return null;
      const description = [element.line, element.service].filter(Boolean).join(' ');
      const ref = writer.add(
        `IFCPIPESEGMENT('${guid}',$,${ifcString(element.mark)},${ifcString(description)},$,${local},${shape(context, solids)},${ifcString(element.id)},.RIGIDSEGMENT.)`,
      );
      return { ref, material: element.material };
    }
    case 'tray': {
      const local = placement(context, storeyPlacement, 0, 0, 0);
      const profile = polygonProfile(
        context,
        trayOutline(mm(element.width), mm(element.height), 2),
      );
      const solids = sweptSolids(context, profile, element.points.map(mm3));
      if (solids.length === 0) return null;
      const ref = writer.add(
        `IFCCABLECARRIERSEGMENT('${guid}',$,${ifcString(element.mark)},${ifcString(element.system)},$,${local},${shape(context, solids)},${ifcString(element.id)},.CABLETRAYSEGMENT.)`,
      );
      return { ref, material: 'galvanized steel' };
    }
  }
}

/** A moment connection: end plate(s) (IfcPlate), haunch (IfcMember), bolt group (fastener). */
export function exportConnection(
  context: Context,
  units: Pick<CadDocument, 'units'>,
  connection: MomentConnectionElement,
  building: BuildingModel,
  level: BuildingLevel,
  storeyPlacement: string,
): Exported[] {
  const { mm, writer } = context;
  const solids = buildingConnectionSolids(units, building, connection);
  if (!solids) return [];
  const solidOf = (solid: ConnectionSolid): { placement: string; body: string } => ({
    placement: framePlacement(
      context,
      storeyPlacement,
      [mm(solid.origin[0]), mm(solid.origin[1]), mm(solid.origin[2] - level.elevation)],
      solid.along,
      solid.x,
    ),
    body: extrusion(context, scaledPolygonProfile(context, solid.outline), mm(solid.depth)),
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
      const profile = scaledPolygonProfile(context, bolt.outline);
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
export function exportPlate(
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
  const circle = circleProfile(context, mm(plate.boltDiameter) / 2);
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
