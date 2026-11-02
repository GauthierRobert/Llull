/**
 * IFC export of a generated platform (06 STA §6): an IfcElementAssembly (ACCESSPLATFORM) without geometry of its own; its members, grating
 * panels and railings are exported as their own products and aggregated under it by the building exporter.
 */

import type { AssemblyElement } from '@aec/building/types';
import { type Context, addPropertySet, ifcString, placement } from '../../../building/exchange/ifcStep';
import type { Exported } from '../../../building/exchange/ifcElementExport';

export function exportAssembly(context: Context, assembly: AssemblyElement, storeyPlacement: string): Exported {
  const local = placement(context, storeyPlacement, 0, 0, 0);
  const ref = context.writer.add(
    `IFCELEMENTASSEMBLY('${context.guid(assembly.id)}',$,${ifcString(assembly.mark)},${ifcString(assembly.kind)},$,${local},$,${ifcString(assembly.id)},.NOTDEFINED.,.ACCESSPLATFORM.)`,
  );
  addPropertySet(context, { id: assembly.id, ref }, 'Pset_llullPlatform', [
    `IFCPROPERTYSINGLEVALUE('Kind','platform or circular_platform',IFCLABEL(${ifcString(assembly.kind)}),$)`,
    `IFCPROPERTYSINGLEVALUE('PartCount','Members, grating panels and railings',IFCINTEGER(${assembly.partIds.length}),$)`,
  ]);
  return { ref, material: null };
}
