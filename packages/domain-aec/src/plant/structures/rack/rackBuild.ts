/**
 * Generation of a pipe rack (06 STA M7): the members of `layoutRack` placed with the ids and marks of the previous generation. The caller has put the
 * assembly element into `base` and removed its previous parts; the outcome has the members added and the assembly updated.
 */

import type { CadDocument } from '@core/model/types';
import type { AssemblyElement, BuildingModel } from '@aec/building/types';
import { withElement, withoutElements } from '../../../building/model';
import { type AssemblyOutcome, type Slots, failure, placeMemberRuns, slotsOf } from '../assembly/assemblyParts';
import { isRackProblem, layoutRack } from './rackLayout';
import { type RackSpec, rackSpecSchema } from './rackSpec';

/** The stored spec of a pipe rack assembly, or null when its params no longer parse. */
export function rackSpecOf(assembly: AssemblyElement): RackSpec | null {
  const parsed = rackSpecSchema.safeParse(assembly.params);
  return parsed.success ? parsed.data : null;
}

/** Members of `spec` added to `base` (the assembly is in it, its previous parts are not). */
export function buildRack(doc: CadDocument, base: BuildingModel, assembly: AssemblyElement, spec: RackSpec, slots: Slots): AssemblyOutcome {
  const layout = layoutRack(doc, spec);
  if (isRackProblem(layout)) return failure(layout.code, layout.message, layout.paths);
  const level = base.levels[assembly.levelId];
  if (level === undefined) return failure('STA_INVALID_GEOMETRY', `unknown level '${assembly.levelId}'`, ['levelId']);
  const placed = placeMemberRuns(base, slots.member, { levelId: level.id, assemblyId: assembly.id }, layout.runs);
  return {
    ok: true,
    building: withElement(placed.building, { ...assembly, partIds: placed.ids, params: spec, generation: assembly.generation + 1 }),
    partIds: placed.ids,
    notes: [],
  };
}

/** Builds the parts of `spec` for `assembly` in `building`: the previous parts are removed first and their ids and marks reused. */
export function generateRack(doc: CadDocument, building: BuildingModel, assembly: AssemblyElement, spec: RackSpec): AssemblyOutcome {
  return buildRack(doc, withoutElements(building, new Set(assembly.partIds)), assembly, spec, slotsOf(building, assembly.partIds));
}
