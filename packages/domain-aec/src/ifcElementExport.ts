/**
 * @layer domain-aec
 */

import type { Vec2, Vec3 } from '@core/model/types';
import type {
  MemberRole,
  CurvedWallElement,
  OpeningElement,
  WallElement,
} from '@core/model/building';
import { wallFrame, type WallExtent } from './wallGeometry';
import { curvedBandBetween } from './curvedWallGeometry';
import type { SteelProfile } from './steel/profiles';
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

export interface Exported {
  readonly ref: string;
  readonly material: string | null;
}

function addWall(
  context: Context,
  wall: WallElement | CurvedWallElement,
  local: string,
  profile: string,
): string {
  const body = shape(context, [extrusion(context, profile, context.mm(wall.height))]);
  return context.writer.add(
    `IFCWALL('${context.guid(wall.id)}',$,${ifcString(wall.mark)},$,$,${local},${body},${ifcString(wall.id)},.STANDARD.)`,
  );
}

export function exportWall(
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
  const ref = addWall(context, wall, local, profile);
  return { ref, material: wall.material, placement: local };
}

/** Material layer set usage for a layered wall (layers across local +Y, from −thickness/2). */
export function exportWallLayers(context: Context, wall: WallElement, wallRef: string): void {
  const { mm, writer } = context;
  const layers = (wall.layers ?? []).map((layer) => {
    const material = writer.add(`IFCMATERIAL(${ifcString(layer.material)},$,$)`);
    return writer.add(
      `IFCMATERIALLAYER(${material},${ifcReal(mm(layer.thickness))},$,${ifcString(layer.material)},$,${ifcString(layer.function ?? 'structure')},$)`,
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

export function exportCurvedWall(
  context: Context,
  wall: CurvedWallElement,
  extent: { start: number; end: number },
  storeyPlacement: string,
): Exported | null {
  const { mm } = context;
  const band = curvedBandBetween(wall, extent.start, extent.end);
  if (!band) return null;
  const local = placement(context, storeyPlacement, 0, 0, mm(wall.baseOffset));
  const profile = polygonProfile(
    context,
    band.map(([x, y]): Vec2 => [mm(x), mm(y)]),
  );
  const ref = addWall(context, wall, local, profile);
  return { ref, material: wall.material };
}

export function exportOpening(
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

export function direction(context: Context, [x, y, z]: Vec3): string {
  return context.writer.add(`IFCDIRECTION((${ifcReal(x)},${ifcReal(y)},${ifcReal(z)}))`);
}

/** Local placement at `origin` (mm) with local Z = `axis` and local X = `reference`. */
export function framePlacement(
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
export function steelProfileDef(context: Context, profile: SteelProfile): string {
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

export const MEMBER_CLASS: Readonly<Record<MemberRole, { entity: string; type: string }>> = {
  column: { entity: 'IFCCOLUMN', type: '.COLUMN.' },
  rafter: { entity: 'IFCBEAM', type: '.BEAM.' },
  beam: { entity: 'IFCBEAM', type: '.BEAM.' },
  crane: { entity: 'IFCBEAM', type: '.BEAM.' },
  brace: { entity: 'IFCMEMBER', type: '.BRACE.' },
  purlin: { entity: 'IFCMEMBER', type: '.PURLIN.' },
  rail: { entity: 'IFCMEMBER', type: '.MEMBER.' },
};
