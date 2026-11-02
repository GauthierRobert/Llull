/**
 * IFC export of a generated assembly (06 STA §6): an IfcElementAssembly without geometry of its own (ACCESSPLATFORM for a platform, USERDEFINED
 * "PIPE_RACK" for a pipe rack); its members, grating panels and railings are exported as their own products and aggregated under it by the building exporter.
 */

import type { AssemblyElement } from '@aec/building/types';
import { type Context, addPropertySet, ifcString, placement } from '../../../building/exchange/ifcStep';
import type { Exported } from '../../../building/exchange/ifcElementExport';

export function exportAssembly(context: Context, assembly: AssemblyElement, storeyPlacement: string): Exported {
  const local = placement(context, storeyPlacement, 0, 0, 0);
  const rack = assembly.kind === 'pipe_rack';
  const ref = context.writer.add(
    `IFCELEMENTASSEMBLY('${context.guid(assembly.id)}',$,${ifcString(assembly.mark)},${ifcString(rack ? 'PIPE_RACK' : assembly.kind)},$,${local},$,${ifcString(assembly.id)},.NOTDEFINED.,${rack ? '.USERDEFINED.' : '.ACCESSPLATFORM.'})`,
  );
  addPropertySet(context, { id: assembly.id, ref }, rack ? 'Pset_llullPipeRack' : 'Pset_llullPlatform', [
    `IFCPROPERTYSINGLEVALUE('Kind','${rack ? 'pipe_rack' : 'platform or circular_platform'}',IFCLABEL(${ifcString(assembly.kind)}),$)`,
    `IFCPROPERTYSINGLEVALUE('PartCount','${rack ? 'Columns, tier beams, struts and braces' : 'Members, grating panels and railings'}',IFCINTEGER(${assembly.partIds.length}),$)`,
  ]);
  return { ref, material: null };
}
