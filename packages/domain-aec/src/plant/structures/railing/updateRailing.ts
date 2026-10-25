import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { noop } from '@core/commands/noop';
import type { RailingElement } from '@aec/building/types';
import { getBuilding, withElement } from '../../../building/model';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { refuse } from '../codes';
import { openingParam } from './addRailing';
import { railingProblem } from './railingValidate';

/**
 * @affects replaces the given fields of one railing and regenerates its posts, rails, toe plate and gates
 * @invariant the path, host and level are unchanged; the result is validated like add_railing
 * @failure id that is not a railing -> STA_UNKNOWN_ELEMENT; invalid result -> STA_INVALID_GEOMETRY / STA_RAIL_OPENING; no field changes -> no-op
 */
export const updateRailing = defineCommand({
  name: 'update_railing',
  description:
    'Change fields of an existing railing (add_railing id): height, kneeRails, toePlate, postProfile, railProfile, postSpacingMax (lengths in DOCUMENT UNITS), openings (replaces the list; gaps and gates) or role. ' +
    'Use it to fix check_access findings (STA_RAIL_HEIGHT_LOW, STA_RAIL_GAP, STA_TOE_PLATE_MISSING). Omitted fields stay. To change the path, delete the railing and add a new one.',
  params: z.object({
    id: z.string().describe('Railing element id.'),
    height: z.number().positive().optional().describe('Top of the top rail above the walking surface, DOCUMENT UNITS.'),
    kneeRails: z.number().int().min(0).max(10).optional().describe('Intermediate rails.'),
    toePlate: z.number().min(0).optional().describe('Toe-plate height, DOCUMENT UNITS; 0 removes it.'),
    postProfile: z.string().optional().describe('Steel catalogue name of the posts.'),
    railProfile: z.string().optional().describe('Steel catalogue name of the rails.'),
    postSpacingMax: z.number().positive().optional().describe('Largest distance between posts, DOCUMENT UNITS.'),
    openings: openingParam.optional(),
    role: z.enum(['guardrail', 'handrail']).optional().describe('"guardrail" or "handrail".'),
  }),
  run: (doc, params): CommandResult => {
    const { id, openings, ...fields } = params;
    const building = getBuilding(doc);
    const railing = building.elements[id];
    if (railing?.category !== 'railing')
      return refuse(doc, 'update_railing', 'STA_UNKNOWN_ELEMENT', `${id} is not a railing`, [id], ['id']);
    const changes = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const next: RailingElement = {
      ...railing,
      ...changes,
      ...(openings === undefined
        ? {}
        : { openings: openings.map((opening) => ({ from: opening.from, to: opening.to, gate: opening.gate === true })) }),
    };
    if (JSON.stringify(next) === JSON.stringify(railing))
      return noop(doc, `update_railing: ${railing.id} already has these values; nothing changed.`);
    const problem = railingProblem(doc, next);
    if (problem !== null) return refuse(doc, 'update_railing', problem.code, problem.message, [railing.id], problem.paths);
    return commitBuilding(
      doc,
      withElement(building, next),
      [railing.id],
      `Updated railing ${railing.mark} (${railing.id}): ${Object.keys(changes)
        .concat(openings === undefined ? [] : ['openings'])
        .join(', ')}. Run check_access.`,
      { elementId: railing.id },
    );
  },
});
