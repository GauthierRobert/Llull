/**
 * IFC export of a steel stair (06 STA §6): an IfcStair (STRAIGHT_RUN_STAIR, TWO_STRAIGHT_RUN_STAIR with one landing, USERDEFINED with more)
 * aggregating one IfcStairFlight STRAIGHT per flight (its treads as the body), the stringers (IfcMember STRINGER) and the landings (IfcSlab LANDING).
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import { toMm } from '@core/model/units';
import type { SteelStairElement } from '@aec/building/types';
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
import type { StairPlate } from '../stair/steelStairLayout';
import { stairQuantities, treadThickness } from '../stair/steelStairMeasure';

const STAIR_TYPES = ['.STRAIGHT_RUN_STAIR.', '.TWO_STRAIGHT_RUN_STAIR.'];

/** One steel stair; null when the stringer section or the tread type left the catalogue. */
export function exportSteelStair(context: Context, doc: CadDocument, stair: SteelStairElement, storeyPlacement: string): Exported | null {
  const { mm, writer } = context;
  const profile = findProfile(stair.stringerProfile);
  const thickness = treadThickness(doc, stair.tread);
  if (profile === undefined || !(thickness > 0)) return null;
  const { layout } = stairQuantities(doc, stair);
  const mm3 = ([x, y, z]: Vec3): Vec3 => [mm(x), mm(y), mm(z)];
  const local = placement(context, storeyPlacement, 0, 0, 0);
  const plateSolid = (plate: StairPlate): string =>
    extrusion(context, scaledPolygonProfile(context, plate.corners), mm(thickness), 0, 0, mm(plate.top - thickness));
  const parts: string[] = [];
  const section = steelProfileDef(context, profile);
  layout.stringers.forEach((run, index) => {
    const [from, to] = [mm3(run.from), mm3(run.to)];
    const frame = sweepFrame(from, to, 0);
    if (frame === null) return;
    const id = `${stair.id}:stringer-${index + 1}`;
    const memberPlacement = framePlacement(context, storeyPlacement, from, frame.d, frame.u);
    const solid = extrusion(context, section, frame.length);
    parts.push(
      writer.add(
        `IFCMEMBER('${context.guid(id)}',$,${ifcString(`${stair.mark} stringer ${index + 1}`)},$,${ifcString(profile.name)},${memberPlacement},${shape(context, [solid])},${ifcString(id)},.STRINGER.)`,
      ),
    );
  });
  layout.flights.forEach((flight, index) => {
    const id = `${stair.id}:flight-${index + 1}`;
    const risers = flight.lastRiser - flight.firstRiser + 1;
    const treads = layout.treads.filter((_, position) => {
      const riser = layout.treadRisers[position] as number;
      return riser >= flight.firstRiser && riser <= flight.lastRiser;
    });
    parts.push(
      writer.add(
        `IFCSTAIRFLIGHT('${context.guid(id)}',$,${ifcString(`${stair.mark} flight ${index + 1}`)},$,$,${local},${treads.length > 0 ? shape(context, treads.map(plateSolid)) : '$'},${ifcString(id)},` +
          `${risers},${Math.max(risers - 1, 0)},${ifcReal(mm(stair.riserHeight))},${ifcReal(mm(stair.going))},.STRAIGHT.)`,
      ),
    );
  });
  layout.landings.forEach((plate, index) => {
    const id = `${stair.id}:landing-${index + 1}`;
    parts.push(
      writer.add(
        `IFCSLAB('${context.guid(id)}',$,${ifcString(`${stair.mark} landing ${index + 1}`)},$,$,${local},${shape(context, [plateSolid(plate)])},${ifcString(id)},.LANDING.)`,
      ),
    );
  });
  const type = STAIR_TYPES[stair.landings.length] ?? '.USERDEFINED.';
  const objectType = type === '.USERDEFINED.' ? ifcString('MULTI_FLIGHT_STRAIGHT_STAIR') : '$';
  const ref = writer.add(
    `IFCSTAIR('${context.guid(stair.id)}',$,${ifcString(stair.mark)},$,${objectType},${local},$,${ifcString(stair.id)},${type})`,
  );
  writer.add(`IFCRELAGGREGATES('${context.guid(`rel:steel-stair-parts:${stair.id}`)}',$,$,$,${ref},(${parts.join(',')}))`);
  addPropertySet(context, { id: stair.id, ref }, 'Pset_llullSteelStair', [
    `IFCPROPERTYSINGLEVALUE('Rise','Total rise, mm',IFCLENGTHMEASURE(${ifcReal(toMm(doc, stair.rise))}),$)`,
    `IFCPROPERTYSINGLEVALUE('RiserCount','Risers',IFCINTEGER(${stair.riserCount}),$)`,
    `IFCPROPERTYSINGLEVALUE('RiserHeight','Riser height, mm',IFCLENGTHMEASURE(${ifcReal(toMm(doc, stair.riserHeight))}),$)`,
    `IFCPROPERTYSINGLEVALUE('Going','Tread depth, mm',IFCLENGTHMEASURE(${ifcReal(toMm(doc, stair.going))}),$)`,
    `IFCPROPERTYSINGLEVALUE('ClearWidth','Clear width between the stringers, mm',IFCLENGTHMEASURE(${ifcReal(toMm(doc, stair.width))}),$)`,
    `IFCPROPERTYSINGLEVALUE('Tread','Grating type or checker_plate',IFCLABEL(${ifcString(stair.tread.kind === 'grating' ? stair.tread.gratingType : 'checker_plate')}),$)`,
  ]);
  return { ref, material: 'steel', parts };
}
