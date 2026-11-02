/** Shared tail of the platform commands: refusal from a failed build, commit and the answer (summary, data) of a built platform. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import type { AssemblyElement, BuildingModel } from '@aec/building/types';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { refuse } from '../codes';
import type { AssemblyBuilt, AssemblyFailure } from '../assembly/assemblyParts';
import { platformQuantities } from './platformMeasure';

export const refusal = (doc: CadDocument, command: string, failed: AssemblyFailure): CommandResult =>
  refuse(doc, command, failed.code, failed.message, failed.ids, failed.paths);

const idsByCategory = (building: BuildingModel, ids: ReadonlyArray<string>, category: 'member' | 'grating' | 'railing'): string[] =>
  ids.filter((id) => building.elements[id]?.category === category);

/** Commits `built` (the assembly and its parts) and answers with the ids, the quantities and the defaults used. */
export function commitPlatform(
  doc: CadDocument,
  verb: 'Added' | 'Updated',
  assemblyId: string,
  built: AssemblyBuilt,
  defaults: ReadonlyArray<string>,
): CommandResult {
  const assembly = built.building.elements[assemblyId] as AssemblyElement;
  const quantities = platformQuantities({ ...doc, building: built.building }, built.building, assembly);
  const summary =
    `${verb} ${assembly.kind === 'platform' ? 'platform' : 'circular platform'} ${assembly.mark} (${assemblyId}, generation ${assembly.generation}): ` +
    `${quantities.members} ${assembly.kind === 'platform' ? 'beam(s)' : 'bracket(s)'}, ${quantities.panels} grating panel(s) ${quantities.gratingAreaM2} m2 ${quantities.gratingMassKg} kg, ` +
    `${quantities.railings} railing(s) ${quantities.railingLengthM} m with ${quantities.posts} post(s), steel ${quantities.steelKg} kg` +
    `${quantities.innerRadiusMm === null ? '' : `, ri ${quantities.innerRadiusMm} mm ro ${quantities.outerRadiusMm} mm, outer arc ${quantities.outerArcM} m`}. ` +
    `${built.notes.length > 0 ? `${built.notes.join('; ')}. ` : ''}` +
    `${defaults.length > 0 ? `Defaults: ${defaults.join('; ')}. ` : ''}Run check_access { ids: ["${assemblyId}"] }.`;
  return commitBuilding(doc, built.building, [assemblyId, ...built.partIds], summary, {
    assemblyId,
    elementIds: [assemblyId, ...built.partIds],
    partIds: built.partIds,
    memberIds: idsByCategory(built.building, built.partIds, 'member'),
    gratingIds: idsByCategory(built.building, built.partIds, 'grating'),
    railingIds: idsByCategory(built.building, built.partIds, 'railing'),
    quantities,
    notes: built.notes,
    defaults,
  });
}
