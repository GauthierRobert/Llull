/** Re-derivation of a platform assembly from its stored parameters (06 STA M6): used by update_access_platform and the staleness report. */

import type { CadDocument } from '@core/model/types';
import type { AssemblyElement, BuildingModel } from '@aec/building/types';
import { withoutElements } from '../../../building/model';
import { buildCircularPlatform } from './circularBuild';
import { buildDeckPlatform } from './platformBuild';
import { type AssemblyOutcome, slotsOf } from '../assembly/assemblyParts';
import { type CircularSpec, type PlatformSpec, circularSpecSchema, platformSpecSchema } from './platformSpec';

/** The stored spec of an assembly, or null when its params no longer parse. */
export function specOf(assembly: AssemblyElement): PlatformSpec | CircularSpec | null {
  const parsed = (assembly.kind === 'platform' ? platformSpecSchema : circularSpecSchema).safeParse(assembly.params);
  return parsed.success ? parsed.data : null;
}

/** Builds the parts of `spec` for `assembly` in `building`: the previous parts are removed first and their ids and marks reused. */
export function generate(
  doc: CadDocument,
  building: BuildingModel,
  assembly: AssemblyElement,
  spec: PlatformSpec | CircularSpec,
): AssemblyOutcome {
  const slots = slotsOf(building, assembly.partIds);
  const base = withoutElements(building, new Set(assembly.partIds));
  return spec.kind === 'platform'
    ? buildDeckPlatform(doc, base, assembly, spec, slots)
    : buildCircularPlatform(doc, base, assembly, spec, slots);
}
