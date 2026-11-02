/** Shared tail of the pipe rack commands: refusal from a failed build, commit and the answer (summary, data) of a built rack. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import type { AssemblyElement } from '@aec/building/types';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { type StaCode, refuse } from '../codes';
import type { AssemblyBuilt } from '../assembly/assemblyParts';
import { rackQuantities } from './rackMeasure';
import { rackSpecOf } from './rackBuild';
import { linesOf, stationsOf } from './rackLayout';

/** Commits `built` (the rack assembly and its members) and answers with the ids, the quantities and the defaults used. */
export function commitRack(
  doc: CadDocument,
  verb: 'Added' | 'Updated',
  assemblyId: string,
  built: AssemblyBuilt,
  defaults: ReadonlyArray<string>,
): CommandResult {
  const assembly = built.building.elements[assemblyId] as AssemblyElement;
  const quantities = rackQuantities({ ...doc, building: built.building }, built.building, assembly);
  const spec = rackSpecOf(assembly);
  const unit = doc.units;
  const notes =
    spec !== null && Math.abs(spec.direction[0]) > 1e-9 && Math.abs(spec.direction[1]) > 1e-9
      ? [
          'the direction is not parallel to X or Y: check_steel_members analyses moment frames and bracing only in X / Y vertical planes, so these members are reported not analysed',
        ]
      : [];
  const summary =
    `${verb} pipe rack ${assembly.mark} (${assemblyId}, generation ${assembly.generation}): ${quantities.bents} bent(s) x ${quantities.columnLines} column line(s), ${quantities.tiers} tier(s); ` +
    `${quantities.columns} column(s) ${quantities.columnLengthM} m, ${quantities.tierBeams} tier beam(s) ${quantities.tierBeamLengthM} m, ${quantities.struts} strut(s) ${quantities.strutLengthM} m, ` +
    `${quantities.braces} brace(s) ${quantities.braceLengthM} m; steel ${quantities.steelMassKgExBracing} kg excluding bracing, ${quantities.steelKg} kg in all (lengths in metres, document unit ${unit}). ` +
    `${notes.length > 0 ? `${notes.join('; ')}. ` : ''}${defaults.length > 0 ? `Defaults: ${defaults.join('; ')}. ` : ''}Run check_steel_members (moment frames across, braced bays along) and check_access { ids: ["${assemblyId}"] }.`;
  return commitBuilding(doc, built.building, [assemblyId, ...built.partIds], summary, {
    assemblyId,
    partCount: built.partIds.length,
    ...quantities,
    stations: spec === null ? [] : stationsOf(spec.along),
    columnLineOffsets: spec === null ? [] : linesOf(spec.across),
    notes,
    defaults,
  });
}

export const rackRefusal = (
  doc: CadDocument,
  command: string,
  failed: { code: StaCode; message: string; ids?: string[]; paths: string[] },
): CommandResult => refuse(doc, command, failed.code, failed.message, failed.ids ?? [], failed.paths);
