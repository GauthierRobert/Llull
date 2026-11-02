/** The platform kinds' handler in the assembly registry (building/assemblyHandlers): regeneration and staleness. */

import type { AssemblyHandler } from '../../../building/assemblyHandlers';
import { generate, specOf } from './platformRegenerate';
import { staleReason } from './platformStale';

export const platformHandler: AssemblyHandler = {
  kinds: ['platform', 'circular_platform'],
  regenerate(doc, building, assembly) {
    const spec = specOf(assembly);
    if (spec === null) return { ok: false, message: `the stored parameters of ${assembly.id} no longer parse` };
    const built = generate(doc, building, assembly, spec);
    return built.ok ? { ok: true, building: built.building, partIds: built.partIds } : { ok: false, message: built.message };
  },
  staleReason,
};
