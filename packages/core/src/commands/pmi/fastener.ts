import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { refuse } from './pmiOps';

/**
 * @affects nothing — read-only
 * @invariant floating: T = H - F per part; fixed: T1 + T2 = H - F (split fraction, default equal); bonus = actualSize - holeMmc; allowedPosition = statedPosition + bonus; virtualCondition = holeMmc - statedPosition
 * @failure hole <= fastener, holeLmc < holeMmc, actualSize outside [holeMmc, holeLmc], actualSize without statedPosition, split outside (0, 1) -> coded refusal
 */
export const fastenerTolerance = defineCommand({
  name: 'fastener_tolerance',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Positional tolerance budget of a bolted joint from the clearance between the hole at maximum material (holeMmc, the smallest hole) and the ' +
    'fastener at maximum material (fastenerMmc, its largest diameter), document length units. Floating fastener (both parts have clearance holes): ' +
    'each part may have a position tolerance T = holeMmc - fastenerMmc. Fixed fastener (one part threaded / pressed): T1 + T2 = holeMmc - fastenerMmc, ' +
    'split equally or by split (fraction given to part 1). With statedPosition (the position tolerance diameter at MMC) it also returns the MMC ' +
    'bonus for an actualSize (actualSize - holeMmc), the allowed position at that size (statedPosition + bonus), the virtual condition ' +
    '(holeMmc - statedPosition) and, with holeLmc, the allowed position at LMC. Refusals: GDT_FASTENER_HOLE_LE_FASTENER, GDT_FASTENER_INVALID.',
  params: z.object({
    holeMmc: z.number().describe('Hole size at maximum material = the smallest hole diameter, document units.'),
    fastenerMmc: z.number().describe('Fastener size at maximum material = the largest fastener diameter, document units.'),
    type: z.enum(['floating', 'fixed']).describe('floating: clearance holes in both parts; fixed: the fastener is held by one part.'),
    split: z.number().optional().describe('Fixed only: fraction of the clearance given to part 1, in (0, 1). Default 0.5 (equal).'),
    holeLmc: z
      .number()
      .optional()
      .describe(
        'Hole size at least material = the largest hole diameter, document units (to bound actualSize and give the LMC allowance).',
      ),
    statedPosition: z.number().optional().describe('Position tolerance diameter stated at MMC, document units, > 0.'),
    actualSize: z.number().optional().describe('Produced hole size, within [holeMmc, holeLmc]; needs statedPosition.'),
  }),
  run: (doc, { holeMmc, fastenerMmc, type, split, holeLmc, statedPosition, actualSize }): CommandResult => {
    const command = 'fastener_tolerance';
    if (!(holeMmc > fastenerMmc))
      return refuse(
        doc,
        command,
        'GDT_FASTENER_HOLE_LE_FASTENER',
        `holeMmc ${holeMmc} does not exceed fastenerMmc ${fastenerMmc}`,
        [],
        ['holeMmc'],
      );
    if (holeLmc !== undefined && holeLmc < holeMmc)
      return refuse(doc, command, 'GDT_FASTENER_INVALID', 'holeLmc is below holeMmc', [], ['holeLmc']);
    if (split !== undefined && !(split > 0 && split < 1))
      return refuse(doc, command, 'GDT_FASTENER_INVALID', 'split must be within (0, 1)', [], ['split']);
    if (statedPosition !== undefined && !(statedPosition > 0))
      return refuse(doc, command, 'GDT_FASTENER_INVALID', 'statedPosition must be > 0', [], ['statedPosition']);
    if (actualSize !== undefined && statedPosition === undefined)
      return refuse(doc, command, 'GDT_FASTENER_INVALID', 'actualSize needs statedPosition', [], ['actualSize']);
    if (actualSize !== undefined && (actualSize < holeMmc || (holeLmc !== undefined && actualSize > holeLmc)))
      return refuse(doc, command, 'GDT_FASTENER_INVALID', `actualSize ${actualSize} is outside [holeMmc, holeLmc]`, [], ['actualSize']);
    const clearance = holeMmc - fastenerMmc;
    const share = split ?? 0.5;
    const positionTolerance =
      type === 'floating' ? { eachPart: clearance } : { part1: clearance * share, part2: clearance * (1 - share), total: clearance };
    const bonus = actualSize === undefined ? undefined : actualSize - holeMmc;
    const data = {
      unit: doc.units,
      type,
      clearance,
      positionTolerance,
      ...(statedPosition === undefined
        ? {}
        : {
            virtualCondition: holeMmc - statedPosition,
            statedWithinClearance: statedPosition <= (type === 'floating' ? clearance : clearance * Math.max(share, 1 - share)) + 1e-12,
            ...(bonus === undefined ? {} : { bonus, allowedPosition: statedPosition + bonus }),
            ...(holeLmc === undefined ? {} : { allowedPositionAtLmc: statedPosition + (holeLmc - holeMmc) }),
          }),
      formulas: [
        'floating: T = H - F',
        'fixed: T1 + T2 = H - F',
        'bonus = actualSize - holeMmc',
        'virtual condition = holeMmc - statedPosition',
      ],
    };
    const text =
      type === 'floating'
        ? `T = ${clearance} per part`
        : `T1 + T2 = ${clearance} (${positionTolerance.part1} + ${positionTolerance.part2})`;
    return report(
      doc,
      `fastener_tolerance: ${type} fastener, clearance ${clearance} ${doc.units}: ${text}${statedPosition === undefined ? '' : `; virtual condition ${holeMmc - statedPosition}`}${bonus === undefined ? '' : `; bonus ${bonus}, allowed position ${statedPosition === undefined ? '' : statedPosition + bonus}`}.`,
      data,
    );
  },
});
