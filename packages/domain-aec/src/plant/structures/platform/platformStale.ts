/** Staleness of a platform assembly: a fresh derivation from the current vessel / beams would differ from the stored parts. */

import type { CadDocument } from '@core/model/types';
import type { AssemblyElement, BuildingModel } from '@aec/building/types';
import { generate, specOf } from './platformRegenerate';
import { sameAssembly } from '../assembly/definition';

/** Why `assembly` is out of date (or cannot be derived at all), or null when it is current. */
export function staleReason(doc: CadDocument, building: BuildingModel, assembly: AssemblyElement): string | null {
  const spec = specOf(assembly);
  if (spec === null) return 'the stored parameters no longer parse';
  const fresh = generate(doc, building, assembly, spec);
  if (!fresh.ok) return fresh.message;
  return sameAssembly(building, fresh.building, assembly.id) ? null : 'the vessel or the beams changed since the parts were derived';
}
