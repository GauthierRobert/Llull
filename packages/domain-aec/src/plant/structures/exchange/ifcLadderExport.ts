/**
 * IFC export of a fixed ladder (06 STA §6): an IfcStair LADDER holding the cage hoops and bars as its own body and aggregating the stiles
 * (IfcMember STRINGER), the rungs (IfcMember MEMBER, ObjectType RUNG) and the landing plates (IfcSlab LANDING).
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import { toMm } from '@core/model/units';
import type { LadderElement } from '@aec/building/types';
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
import { steelProfileDef, sweptSolids } from '../../../building/exchange/ifcIndustrialExport';
import { sweepFrame } from '../../../shared/mesh';
import { findProfile } from '../../../steel/profiles';
import { CAGE_BAR_PROFILE, HOOP_PROFILE, LANDING_THICKNESS_MM, RUNG_PROFILE, STILE_PROFILE, type LadderRun } from '../ladder/ladderLayout';
import { ladderQuantities } from '../ladder/ladderMeasure';

/** One ladder; null when a section left the catalogue. */
export function exportLadder(context: Context, doc: CadDocument, ladder: LadderElement, storeyPlacement: string): Exported | null {
  const { mm, writer } = context;
  const [stile, rung, hoop, bar] = [STILE_PROFILE, RUNG_PROFILE, HOOP_PROFILE, CAGE_BAR_PROFILE].map((name) => findProfile(name));
  if (stile === undefined || rung === undefined || hoop === undefined || bar === undefined) return null;
  const { layout } = ladderQuantities(doc, ladder);
  const mm3 = ([x, y, z]: Vec3): Vec3 => [mm(x), mm(y), mm(z)];
  const profiles = {
    stile: steelProfileDef(context, stile),
    rung: steelProfileDef(context, rung),
    hoop: steelProfileDef(context, hoop),
    bar: steelProfileDef(context, bar),
  };
  const cage = [
    ...layout.hoops.flatMap((run) => sweptSolids(context, profiles.hoop, [mm3(run.from), mm3(run.to)])),
    ...layout.bars.flatMap((run) => sweptSolids(context, profiles.bar, [mm3(run.from), mm3(run.to)])),
  ];
  const member = (
    id: string,
    name: string,
    type: string,
    objectType: string,
    profile: string,
    run: LadderRun,
    roll: number,
  ): string | null => {
    const [from, to] = [mm3(run.from), mm3(run.to)];
    const frame = sweepFrame(from, to, roll);
    if (frame === null) return null;
    const local = framePlacement(context, storeyPlacement, from, frame.d, frame.u);
    const solid = extrusion(context, profile, frame.length);
    return writer.add(
      `IFCMEMBER('${context.guid(id)}',$,${ifcString(name)},$,${ifcString(objectType)},${local},${shape(context, [solid])},${ifcString(id)},${type})`,
    );
  };
  const local = placement(context, storeyPlacement, 0, 0, 0);
  const ref = writer.add(
    `IFCSTAIR('${context.guid(ladder.id)}',$,${ifcString(ladder.mark)},$,$,${local},${cage.length > 0 ? shape(context, cage) : '$'},${ifcString(ladder.id)},.LADDER.)`,
  );
  const parts: string[] = [];
  layout.stiles.forEach((run, index) => {
    const id = `${ladder.id}:stile-${index + 1}`;
    const part = member(id, `${ladder.mark} stile ${index + 1}`, '.STRINGER.', stile.name, profiles.stile, run, -ladder.facing);
    if (part !== null) parts.push(part);
  });
  layout.rungs.forEach((run, index) => {
    const id = `${ladder.id}:rung-${index + 1}`;
    const part = member(id, `${ladder.mark} rung ${index + 1}`, '.MEMBER.', 'RUNG', profiles.rung, run, 0);
    if (part !== null) parts.push(part);
  });
  layout.landings.forEach((plate, index) => {
    const id = `${ladder.id}:landing-${index + 1}`;
    const solid = extrusion(
      context,
      scaledPolygonProfile(context, plate.corners),
      LANDING_THICKNESS_MM,
      0,
      0,
      mm(plate.top) - LANDING_THICKNESS_MM,
    );
    parts.push(
      writer.add(
        `IFCSLAB('${context.guid(id)}',$,${ifcString(`${ladder.mark} landing ${index + 1}`)},$,$,${local},${shape(context, [solid])},${ifcString(id)},.LANDING.)`,
      ),
    );
  });
  if (parts.length > 0)
    writer.add(`IFCRELAGGREGATES('${context.guid(`rel:ladder-parts:${ladder.id}`)}',$,$,$,${ref},(${parts.join(',')}))`);
  addPropertySet(context, { id: ladder.id, ref }, 'Pset_llullLadder', [
    `IFCPROPERTYSINGLEVALUE('ClimbHeight','Departure level to arrival surface, mm',IFCLENGTHMEASURE(${ifcReal(toMm(doc, ladder.climbHeight))}),$)`,
    `IFCPROPERTYSINGLEVALUE('RungCount','Rungs',IFCINTEGER(${ladder.rungCount}),$)`,
    `IFCPROPERTYSINGLEVALUE('RungPitch','Rung pitch, mm',IFCLENGTHMEASURE(${ifcReal(toMm(doc, ladder.rungPitch))}),$)`,
    `IFCPROPERTYSINGLEVALUE('ClearWidth','Clear width between the stiles, mm',IFCLENGTHMEASURE(${ifcReal(toMm(doc, ladder.clearWidth))}),$)`,
    `IFCPROPERTYSINGLEVALUE('FallProtection','none, cage, ladder_safety_system or pfas',IFCLABEL(${ifcString(ladder.fallProtection)}),$)`,
    `IFCPROPERTYSINGLEVALUE('InstalledOn','Installation date (absent = unknown)',IFCLABEL(${ifcString(ladder.installedOn ?? '')}),$)`,
  ]);
  return { ref, material: 'steel', parts };
}
