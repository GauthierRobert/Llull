/** The pipe rack's handler in the assembly registry (building/assemblyHandlers): regeneration and staleness. */

import type { AssemblyElement, BuildingModel } from '@aec/building/types';
import type { CadDocument } from '@core/model/types';
import type { AssemblyHandler } from '../../../building/assemblyHandlers';
import { sameAssembly } from '../assembly/definition';
import { generateRack, rackSpecOf } from './rackBuild';

/** Why `assembly` no longer matches a fresh derivation from its stored parameters, or null when it is current. */
export function rackStaleReason(doc: CadDocument, building: BuildingModel, assembly: AssemblyElement): string | null {
  const spec = rackSpecOf(assembly);
  if (spec === null) return 'the stored parameters no longer parse';
  const fresh = generateRack(doc, building, assembly, spec);
  if (!fresh.ok) return fresh.message;
  return sameAssembly(building, fresh.building, assembly.id)
    ? null
    : 'a member of the rack differs from the one the stored parameters generate';
}

export const rackHandler: AssemblyHandler = {
  kinds: ['pipe_rack'],
  regenerate(doc, building, assembly) {
    const spec = rackSpecOf(assembly);
    if (spec === null) return { ok: false, message: `the stored parameters of ${assembly.id} no longer parse` };
    const built = generateRack(doc, building, assembly, spec);
    return built.ok ? { ok: true, building: built.building, partIds: built.partIds } : { ok: false, message: built.message };
  },
  staleReason: rackStaleReason,
};
