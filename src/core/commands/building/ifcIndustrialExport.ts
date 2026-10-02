/**
 * ifc: ifcIndustrialExport.
 * @layer core/commands/building
 */

import type { CadDocument, Vec2, Vec3 } from '../../model/types';
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
} from '../../model/building';
import { sweepFrame } from './mesh';
import {
  connectionSolids,
  panelFrame,
  plateLayout,
  trayOutline,
  type ConnectionSolid,
} from './industrial/evaluate';
import { findProfile } from './steel/profiles';
import {
  type Context,
  extrusion,
  ifcReal,
  ifcString,
  placement,
  point2,
  point3,
  polygonProfile,
  rectangleProfile,
  shape,
} from './ifcStep';
import {
  type Exported,
  MEMBER_CLASS,
  direction,
  framePlacement,
  steelProfileDef,
} from './ifcElementExport';

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
export function exportConnection(
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
