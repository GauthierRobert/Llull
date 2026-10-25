/**
 * IFC export of the access elements (06 STA §6): a grating panel as IfcPlate (USERDEFINED, ObjectType GRATING); a railing as IfcRailing
 * (GUARDRAIL / HANDRAIL) holding the rails, toe plate and gate leaves, with one IfcMember POST per post aggregated under it.
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import { toDegrees } from '@lib/angle';
import { toMm } from '@core/model/units';
import type { GratingElement, RailingElement } from '@aec/building/types';
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
import { findProfile } from '../../../steel/profiles';
import { findGratingType } from '../grating/gratingTypes';
import { toePlateProfile, railingQuantities } from '../railing/railingMeasure';

/** One grating panel: an extruded plate, with its type, bar direction and mass in a property set. */
export function exportGrating(context: Context, grating: GratingElement, storeyPlacement: string): Exported {
  const { mm, writer } = context;
  const type = findGratingType(grating.gratingType);
  const depth = type?.barDepthMm ?? 0;
  const local = placement(context, storeyPlacement, 0, 0, 0);
  const solid = extrusion(context, scaledPolygonProfile(context, grating.boundary), depth, 0, 0, mm(grating.topOffset) - depth);
  const ref = writer.add(
    `IFCPLATE('${context.guid(grating.id)}',$,${ifcString(grating.mark)},${ifcString(grating.gratingType)},'GRATING',${local},${shape(context, [solid])},${ifcString(grating.id)},.USERDEFINED.)`,
  );
  addPropertySet(context, { id: grating.id, ref }, 'Pset_llullGrating', [
    `IFCPROPERTYSINGLEVALUE('GratingType','Catalogue key',IFCLABEL(${ifcString(grating.gratingType)}),$)`,
    `IFCPROPERTYSINGLEVALUE('BearingBarAngle','Plan direction of the bearing bars, degrees from +X',IFCPLANEANGLEMEASURE(${ifcReal(toDegrees(grating.bearingBarAngle))}),$)`,
    `IFCPROPERTYSINGLEVALUE('MassPerArea','Panel mass, kg/m2',IFCREAL(${ifcReal(type?.massKgM2 ?? 0)}),$)`,
    `IFCPROPERTYSINGLEVALUE('Verified','Mass checked against two manufacturer tables',IFCBOOLEAN(${type?.verified === true ? '.T.' : '.F.'}),$)`,
  ]);
  return { ref, material: 'steel' };
}

/** One railing; null when a profile left the catalogue. */
export function exportRailing(context: Context, doc: CadDocument, railing: RailingElement, storeyPlacement: string): Exported | null {
  const { mm, writer } = context;
  const post = findProfile(railing.postProfile);
  const rail = findProfile(railing.railProfile);
  const quantities = railingQuantities(doc, railing);
  if (post === undefined || rail === undefined || quantities === null) return null;
  const { layout } = quantities;
  const mm3 = ([x, y, z]: Vec3): Vec3 => [mm(x), mm(y), mm(z)];
  const railProfile = steelProfileDef(context, rail);
  const solids = [...layout.rails, ...layout.gates].flatMap((run) => sweptSolids(context, railProfile, [mm3(run.from), mm3(run.to)]));
  if (railing.toePlate > 0) {
    const toeProfile = steelProfileDef(context, toePlateProfile(toMm(doc, railing.toePlate)));
    solids.push(...layout.toePlates.flatMap((run) => sweptSolids(context, toeProfile, [mm3(run.from), mm3(run.to)])));
  }
  const local = placement(context, storeyPlacement, 0, 0, 0);
  const type = railing.role === 'guardrail' ? '.GUARDRAIL.' : '.HANDRAIL.';
  const ref = writer.add(
    `IFCRAILING('${context.guid(railing.id)}',$,${ifcString(railing.mark)},${ifcString(railing.role)},$,${local},${solids.length > 0 ? shape(context, solids) : '$'},${ifcString(railing.id)},${type})`,
  );
  const postProfile = steelProfileDef(context, post);
  const posts = layout.posts.map((base, index) => {
    const postPlacement = framePlacement(context, storeyPlacement, mm3(base), [0, 0, 1], [1, 0, 0]);
    const solid = extrusion(context, postProfile, mm(layout.postLength));
    return writer.add(
      `IFCMEMBER('${context.guid(`${railing.id}:post-${index + 1}`)}',$,${ifcString(`${railing.mark} post ${index + 1}`)},$,${ifcString(post.name)},${postPlacement},${shape(context, [solid])},${ifcString(`${railing.id}:post-${index + 1}`)},.POST.)`,
    );
  });
  writer.add(`IFCRELAGGREGATES('${context.guid(`rel:railing-posts:${railing.id}`)}',$,$,$,${ref},(${posts.join(',')}))`);
  addPropertySet(context, { id: railing.id, ref }, 'Pset_llullRailing', [
    `IFCPROPERTYSINGLEVALUE('Height','Top of the top rail above the walking surface, mm',IFCLENGTHMEASURE(${ifcReal(mm(railing.height))}),$)`,
    `IFCPROPERTYSINGLEVALUE('KneeRails','Intermediate rails',IFCINTEGER(${railing.kneeRails}),$)`,
    `IFCPROPERTYSINGLEVALUE('ToePlateHeight','Toe-plate height, mm (0 = none)',IFCLENGTHMEASURE(${ifcReal(mm(railing.toePlate))}),$)`,
    `IFCPROPERTYSINGLEVALUE('PostCount','Posts',IFCINTEGER(${posts.length}),$)`,
  ]);
  return { ref, material: 'steel', parts: posts };
}
