/** Re-derivation of a platform assembly from its stored parameters (06 STA M6): used by update_access_platform and the staleness report. */

import type { CadDocument } from '@core/model/types';
import type { AssemblyElement, BuildingModel } from '@aec/building/types';
import { withoutElements } from '../../../building/model';
import { buildCircularPlatform } from './circularBuild';
import { definitionOf } from './platformDefinition';
import { buildDeckPlatform } from './platformBuild';
import { type PlatformOutcome, slotsOf } from './platformParts';
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
): PlatformOutcome {
  const slots = slotsOf(building, assembly.partIds);
  const base = withoutElements(building, new Set(assembly.partIds));
  return spec.kind === 'platform'
    ? buildDeckPlatform(doc, base, assembly, spec, slots)
    : buildCircularPlatform(doc, base, assembly, spec, slots);
}

/** True when both buildings hold the same assembly and parts (generation number and `elementOrder` ignored). */
export function samePlatform(before: BuildingModel, after: BuildingModel, assemblyId: string): boolean {
  const [a, b] = [before.elements[assemblyId], after.elements[assemblyId]];
  if (a?.category !== 'assembly' || b?.category !== 'assembly' || definitionOf(a, true) !== definitionOf(b, true)) return false;
  return a.partIds.every((id) => definitionOf(before.elements[id], true) === definitionOf(after.elements[id], true));
}

export type FollowOutcome =
  | { readonly ok: true; readonly building: BuildingModel; readonly ids: string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Re-derives every platform hosted by one of `hostIds` (a circular platform follows its vessel, 06 STA FR-STA-14) in `building`, where the hosts
 * already have their new place. Part ids and marks are kept. Refuses (with the reason) when a platform cannot follow, e.g. the vessel no longer reaches its elevation.
 */
export function followHosts(doc: CadDocument, building: BuildingModel, hostIds: ReadonlySet<string>): FollowOutcome {
  let next = building;
  const ids: string[] = [];
  for (const assembly of Object.values(building.elements)) {
    if (assembly.category !== 'assembly' || assembly.hostId === undefined || !hostIds.has(assembly.hostId)) continue;
    const spec = specOf(assembly);
    if (spec === null) return { ok: false, message: `the stored parameters of ${assembly.id} no longer parse` };
    const built = generate(doc, next, assembly, spec);
    if (!built.ok) return { ok: false, message: `platform ${assembly.id} cannot follow ${assembly.hostId}: ${built.message}` };
    next = built.building;
    ids.push(assembly.id, ...built.partIds);
  }
  return { ok: true, building: next, ids };
}
