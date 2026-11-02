import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { noop } from '@core/commands/noop';
import { getBuilding } from '../../../building/model';
import { sameAssembly } from '../assembly/definition';
import { refuse } from '../codes';
import { generateRack, rackSpecOf } from './rackBuild';
import { commitRack, rackRefusal } from './rackCommit';
import { isRackProblem } from './rackLayout';
import { rackFieldParams, resolveRack } from './rackParams';

/**
 * @affects regenerates the members of one pipe rack assembly (ids and marks of the members are kept, extra members are added or removed)
 * @invariant the stored parameters change only by the given fields; the result is validated like the add command; with no field given the members are re-derived from the stored parameters
 * @failure id that is not a pipe rack -> STA_UNKNOWN_ELEMENT; an invalid result -> the add command's codes; nothing changes -> no-op
 */
export const updatePipeRack = defineCommand({
  name: 'update_pipe_rack',
  description:
    'Change a generated pipe rack (add_pipe_rack `assemblyId`) and regenerate its members; member ids and marks are kept (extra members get new ids, surplus ones are removed). ' +
    'Give only the fields to change, lengths in DOCUMENT UNITS: origin, direction, length / bentSpacing / stations, width / baysAcross, tiers, columnProfile, tierBeamProfile, strutProfile, struts, bracingBays (empty list removes the bracing), bracingProfile, baseFixity, gridPrefix. ' +
    'The level cannot change (delete the rack and add it again). With NO field it re-derives the rack from its stored parameters (clears STA_RACK_STALE). Result data as add_pipe_rack.',
  params: z.object({
    assemblyId: z.string().describe('Assembly element id (the `assemblyId` of add_pipe_rack).'),
    origin: rackFieldParams.origin.optional(),
    direction: rackFieldParams.direction.optional(),
    length: rackFieldParams.length.optional(),
    bentSpacing: rackFieldParams.bentSpacing.optional(),
    stations: rackFieldParams.stations.optional(),
    width: rackFieldParams.width.optional(),
    baysAcross: rackFieldParams.baysAcross.optional(),
    tiers: rackFieldParams.tiers.optional(),
    columnProfile: rackFieldParams.columnProfile.optional(),
    tierBeamProfile: rackFieldParams.tierBeamProfile.optional(),
    strutProfile: rackFieldParams.strutProfile.optional(),
    struts: rackFieldParams.struts.optional(),
    bracingBays: rackFieldParams.bracingBays.optional(),
    bracingProfile: rackFieldParams.bracingProfile.optional(),
    baseFixity: rackFieldParams.baseFixity.optional(),
    gridPrefix: rackFieldParams.gridPrefix.optional(),
  }),
  run: (doc, params): CommandResult => {
    const { assemblyId, ...fields } = params;
    const building = getBuilding(doc);
    const assembly = building.elements[assemblyId];
    if (assembly?.category !== 'assembly' || assembly.kind !== 'pipe_rack')
      return refuse(
        doc,
        'update_pipe_rack',
        'STA_UNKNOWN_ELEMENT',
        `${assemblyId} is not a pipe rack assembly`,
        [assemblyId],
        ['assemblyId'],
      );
    const current = rackSpecOf(assembly);
    if (current === null)
      return refuse(doc, 'update_pipe_rack', 'STA_INVALID_GEOMETRY', `the stored parameters of ${assemblyId} no longer parse`, [
        assemblyId,
      ]);
    const spec = resolveRack(fields, current, []);
    if (isRackProblem(spec)) return rackRefusal(doc, 'update_pipe_rack', spec);
    const built = generateRack(doc, building, assembly, spec);
    if (!built.ok) return rackRefusal(doc, 'update_pipe_rack', built);
    if (sameAssembly(building, built.building, assemblyId))
      return noop(doc, `update_pipe_rack: ${assembly.mark} (${assemblyId}) already matches these parameters; nothing changed.`);
    return commitRack(doc, 'Updated', assemblyId, built, []);
  },
});
