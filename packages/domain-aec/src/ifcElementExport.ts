/**
 * @layer domain-aec
 */

import type {
  BuildingModel,
  CurvedWallElement,
  OpeningElement,
  WallElement,
} from '@core/model/building';
import { openingsOf, wallExtent, wallFrame, type WallExtent } from './wallGeometry';
import {
  curvedBandBetween,
  curvedWallArc,
  curvedWallExtent,
  tangentWall,
} from './curvedWallGeometry';
import {
  type Context,
  extrusion,
  ifcReal,
  ifcString,
  placement,
  scaledPolygonProfile,
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
  const profile = scaledPolygonProfile(context, band);
  const ref = addWall(context, wall, local, profile);
  return { ref, material: wall.material };
}

export function exportOpening(
  context: Context,
  opening: OpeningElement,
  wall: WallElement,
  host: { readonly ref: string; readonly placement: string },
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
  return { ref, material: opening.material };
}

/** A wall with its material layers, then the doors and windows it hosts (in element order). */
export function exportWallElement(
  context: Context,
  building: BuildingModel,
  wall: WallElement,
  storeyPlacement: string,
): Exported[] {
  const exported = exportWall(context, wall, wallExtent(building, wall), storeyPlacement);
  if (wall.layers) exportWallLayers(context, wall, exported.ref);
  const exports: Exported[] = [wall.layers ? { ...exported, material: null } : exported];
  for (const id of building.elementOrder) {
    const opening = building.elements[id];
    if (
      (opening?.category === 'door' || opening?.category === 'window') &&
      opening.hostId === wall.id
    ) {
      exports.push(exportOpening(context, opening, wall, exported));
    }
  }
  return exports;
}

/** A curved wall and its openings, each cut along the tangent to the arc at its offset. */
export function exportCurvedWallElement(
  context: Context,
  building: BuildingModel,
  wall: CurvedWallElement,
  storeyPlacement: string,
): Exported[] {
  const exported = exportCurvedWall(
    context,
    wall,
    curvedWallExtent(building, wall),
    storeyPlacement,
  );
  if (!exported) return [];
  const radius = curvedWallArc(wall)?.radius ?? 0;
  const exports: Exported[] = [exported];
  for (const opening of openingsOf(building, wall.id)) {
    const tangent = tangentWall(wall, opening.offset);
    const host = {
      ref: exported.ref,
      placement: placement(
        context,
        storeyPlacement,
        context.mm(tangent.start[0]),
        context.mm(tangent.start[1]),
        context.mm(wall.baseOffset),
        wallFrame(tangent).angle,
      ),
    };
    // The arc leaves the tangent by its sagitta at the jambs: deepen the void to cut through.
    const half = Math.min(opening.width / 2, radius);
    const sagitta = radius - Math.sqrt(radius * radius - half * half);
    exports.push(
      exportOpening(
        context,
        opening,
        { ...tangent, thickness: wall.thickness + 2 * sagitta },
        host,
      ),
    );
  }
  return exports;
}
