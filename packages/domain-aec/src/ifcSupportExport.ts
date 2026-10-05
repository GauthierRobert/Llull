/**
 * IFC export of a pipe support: one IfcBuildingElementProxy (ObjectType PIPESUPPORT) whose body is
 * the support's extruded parts, with a Pset_llullPipeSupport property set (type, pipe, steel it bears on).
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import type { BuildingModel, PipeElement, PipeSupportElement } from '@core/model/building';
import { supportShape } from './industrial/supportParts';
import {
  type Context,
  circleProfile,
  extrusion,
  ifcReal,
  ifcString,
  placement,
  rectangleProfile,
  shape,
} from './ifcStep';
import type { Exported } from './ifcElementExport';

export function exportPipeSupport(
  context: Context,
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  support: PipeSupportElement,
  pipe: PipeElement | undefined,
  storeyPlacement: string,
): Exported | null {
  if (!pipe) return null;
  const { mm, writer } = context;
  const { angle, parts } = supportShape(doc, support, pipe);
  const [x, y] = [mm(support.position[0]), mm(support.position[1])];
  const local = placement(context, storeyPlacement, x, y, 0, angle);
  const solids = parts.map((part) => {
    const across = mm(part.across);
    if (part.kind === 'box') {
      const profile = rectangleProfile(context, [0, 0], mm(part.size[0]), mm(part.size[1]));
      const bottom = mm(part.z - part.size[2] / 2);
      return extrusion(context, profile, mm(part.size[2]), 0, across, bottom);
    }
    const profile = circleProfile(context, mm(part.radius));
    return extrusion(context, profile, mm(part.height), 0, across, mm(part.z - part.height / 2));
  });
  const member = support.memberId === null ? undefined : building.elements[support.memberId];
  const bearsOn = member?.category === 'member' ? member.mark : '';
  const description = [pipe.line, support.type].filter(Boolean).join(' ');
  const ref = writer.add(
    `IFCBUILDINGELEMENTPROXY('${context.guid(support.id)}',$,${ifcString(support.mark)},${ifcString(description)},'PIPESUPPORT',${local},${shape(context, solids)},${ifcString(support.id)},.ELEMENT.)`,
  );
  const properties = [
    `IFCPROPERTYSINGLEVALUE('SupportType','Shoe, hanger, guide or anchor',IFCLABEL(${ifcString(support.type)}),$)`,
    `IFCPROPERTYSINGLEVALUE('Pipe','Mark of the supported pipe',IFCLABEL(${ifcString(pipe.mark)}),$)`,
    `IFCPROPERTYSINGLEVALUE('BearsOn','Mark of the steel member it bears on (empty = unattached)',IFCLABEL(${ifcString(bearsOn)}),$)`,
    `IFCPROPERTYSINGLEVALUE('RodLength','Hanger rod length, mm',IFCLENGTHMEASURE(${ifcReal(mm(support.rodLength))}),$)`,
  ].map((property) => writer.add(property));
  const propertySet = writer.add(
    `IFCPROPERTYSET('${context.guid(`${support.id}:pset`)}',$,'Pset_llullPipeSupport',$,(${properties.join(',')}))`,
  );
  writer.add(
    `IFCRELDEFINESBYPROPERTIES('${context.guid(`${support.id}:rel-pset`)}',$,$,$,(${ref}),${propertySet})`,
  );
  return { ref, material: 'steel' };
}
