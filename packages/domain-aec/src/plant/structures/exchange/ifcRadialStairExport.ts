/** IFC export of a winder / spiral stair (06 STA §13.15): an IfcStair (QUARTER_WINDING_STAIR / SPIRAL_STAIR) aggregating its treads as one IfcStairFlight (WINDER / SPIRAL) and the sections as IfcMember. */

import type { CadDocument, Vec3 } from '@core/model/types';
import { toMm } from '@core/model/units';
import type { RadialStairElement } from '@aec/building/types';
import {
  type Context,
  addPropertySet,
  extrusion,
  framePlacement,
  ifcReal,
  ifcString,
  placement,
  scaledPolygonProfile,
  shape,
} from '../../../building/exchange/ifcStep';
import type { Exported } from '../../../building/exchange/ifcElementExport';
import { steelProfileDef } from '../../../building/exchange/ifcIndustrialExport';
import { sweepFrame } from '../../../shared/mesh';
import { findProfile } from '../../../steel/profiles';
import { treadThickness } from '../stair/steelStairMeasure';

/** One radial stair; null when the section or the tread type left the catalogue. */
export function exportRadialStair(context: Context, doc: CadDocument, stair: RadialStairElement, storeyPlacement: string): Exported | null {
  const { mm, writer } = context;
  const profile = findProfile(stair.profile);
  const thickness = treadThickness(doc, stair.tread);
  if (profile === undefined || !(thickness > 0)) return null;
  const mm3 = ([x, y, z]: Vec3): Vec3 => [mm(x), mm(y), mm(z)];
  const local = placement(context, storeyPlacement, 0, 0, 0);
  const section = steelProfileDef(context, profile);
  const spiral = stair.form === 'spiral';
  const parts: string[] = [];
  stair.runs.forEach((run, index) => {
    const [from, to] = [mm3(run.from), mm3(run.to)];
    const frame = sweepFrame(from, to, 0);
    if (frame === null) return;
    const id = `${stair.id}:section-${index + 1}`;
    const memberPlacement = framePlacement(context, storeyPlacement, from, frame.d, frame.u);
    const solid = extrusion(context, section, frame.length);
    parts.push(
      writer.add(
        `IFCMEMBER('${context.guid(id)}',$,${ifcString(`${stair.mark} section ${index + 1}`)},$,${ifcString(profile.name)},${memberPlacement},${shape(context, [solid])},${ifcString(id)},${spiral ? '.POST.' : '.STRINGER.'})`,
      ),
    );
  });
  const solids = stair.plates.map((plate) =>
    extrusion(context, scaledPolygonProfile(context, plate.corners), mm(thickness), 0, 0, mm(plate.top - thickness)),
  );
  const flightId = `${stair.id}:flight-1`;
  parts.push(
    writer.add(
      `IFCSTAIRFLIGHT('${context.guid(flightId)}',$,${ifcString(`${stair.mark} treads`)},$,$,${local},${shape(context, solids)},${ifcString(flightId)},` +
        `${stair.riserCount},${stair.riserCount - 1},${ifcReal(mm(stair.riserHeight))},$,${spiral ? '.SPIRAL.' : '.WINDER.'})`,
    ),
  );
  const ref = writer.add(
    `IFCSTAIR('${context.guid(stair.id)}',$,${ifcString(stair.mark)},$,$,${local},$,${ifcString(stair.id)},${spiral ? '.SPIRAL_STAIR.' : '.QUARTER_WINDING_STAIR.'})`,
  );
  writer.add(`IFCRELAGGREGATES('${context.guid(`rel:radial-stair-parts:${stair.id}`)}',$,$,$,${ref},(${parts.join(',')}))`);
  addPropertySet(context, { id: stair.id, ref }, 'Pset_llullRadialStair', [
    `IFCPROPERTYSINGLEVALUE('Form','winder or spiral',IFCLABEL(${ifcString(stair.form)}),$)`,
    `IFCPROPERTYSINGLEVALUE('Rise','Total rise, mm',IFCLENGTHMEASURE(${ifcReal(toMm(doc, stair.rise))}),$)`,
    `IFCPROPERTYSINGLEVALUE('RiserCount','Risers',IFCINTEGER(${stair.riserCount}),$)`,
    `IFCPROPERTYSINGLEVALUE('RiserHeight','Riser height, mm',IFCLENGTHMEASURE(${ifcReal(toMm(doc, stair.riserHeight))}),$)`,
  ]);
  return { ref, material: 'steel', parts };
}
