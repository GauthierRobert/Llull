/** fastener_tolerance: floating / fixed fastener positional tolerance, MMC bonus and virtual condition (GDT FR-GDT-19, TR-GDT-12). */

import { report } from '../noop';
import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import { refuseGdt } from './codes';

/**
 * @affects none (query); data = { type, clearance, positionTolerance, perPart?, bonus?, allowedPosition?, virtualCondition?, statedWithinClearance?, allowedPositionAtLmc?, formulas, unit }
 * @invariant floating T = H − F; fixed T1 + T2 = H − F (split = T1 share, default ½); bonus = actual − H; allowed = stated + bonus; VC = H − stated
 * @failure hole MMC <= fastener MMC -> GDT_FASTENER_HOLE_LE_FASTENER; non-positive size, split outside (0,1), actualSize outside [holeMmc, holeLmc] or bonus without statedPosition -> GDT_FASTENER_PARAM_INVALID
 */
export const fastenerTolerance = defineCommand({
  name: 'fastener_tolerance',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only fastener-fit helper (ASME Y14.5 fastener formulas): positional tolerance of a hole pattern from the hole and fastener MMC sizes. ' +
    'floating: both parts have clearance holes, T = H − F per part. fixed: the fastener is held in one part (threaded / press-fit), ' +
    'T1 + T2 = H − F, split by `split` (share of part 1, default 0.5). With statedPosition: the virtual condition H − T; with actualSize too: ' +
    'the MMC bonus (actual − H) and the allowed position (stated + bonus); with holeLmc too: the allowed position at LMC. statedWithinClearance says whether ' +
    'the stated position fits the clearance budget of its part (`part`, fixed fasteners). Sizes in document units.',
  params: z.object({
    holeMmc: z.number().describe('Hole size at maximum material condition H (smallest hole), > 0.'),
    fastenerMmc: z.number().describe('Fastener size at maximum material condition F (largest shank), > 0, < holeMmc.'),
    type: z.enum(['floating', 'fixed']).describe('floating (clearance holes in both parts) or fixed (fastener held in one part).'),
    split: z.number().optional().describe('fixed: share of H − F given to part 1, in (0, 1). Default 0.5 (equal split).'),
    part: z
      .union([z.literal(1), z.literal(2)])
      .optional()
      .describe('fixed: which part statedPosition belongs to (1 or 2); its share of H − F bounds statedWithinClearance. Default 1.'),
    holeLmc: z.number().optional().describe('Hole size at least material condition (largest hole); bounds actualSize.'),
    statedPosition: z.number().optional().describe('Stated position tolerance at MMC (diameter), >= 0: virtual condition and bonus.'),
    actualSize: z.number().optional().describe('Actual (measured) hole size within [holeMmc, holeLmc]: MMC bonus and allowed position.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseGdt(doc, 'fastener_tolerance', code, message, [], [path]);
    const { holeMmc: h, fastenerMmc: f, type } = params;
    if (!(h > 0) || !(f > 0)) return fail('GDT_FASTENER_PARAM_INVALID', 'sizes must be > 0', 'holeMmc');
    if (h <= f) return fail('GDT_FASTENER_HOLE_LE_FASTENER', `hole MMC ${h} <= fastener MMC ${f}`, 'holeMmc');
    const split = params.split ?? 0.5;
    if (!(split > 0 && split < 1)) return fail('GDT_FASTENER_PARAM_INVALID', 'split must be within (0, 1)', 'split');
    const lmc = params.holeLmc;
    if (lmc !== undefined && !(lmc >= h)) return fail('GDT_FASTENER_PARAM_INVALID', 'holeLmc must be >= holeMmc', 'holeLmc');
    const stated = params.statedPosition;
    if (stated !== undefined && !(stated >= 0)) return fail('GDT_FASTENER_PARAM_INVALID', 'statedPosition must be >= 0', 'statedPosition');
    const actual = params.actualSize;
    if (actual !== undefined) {
      if (stated === undefined) return fail('GDT_FASTENER_PARAM_INVALID', 'actualSize needs statedPosition', 'statedPosition');
      if (actual < h || (lmc !== undefined && actual > lmc))
        return fail('GDT_FASTENER_PARAM_INVALID', `actualSize ${actual} outside [${h}, ${lmc ?? '∞'}]`, 'actualSize');
    }
    const clearance = h - f;
    const perPart = type === 'fixed' ? { part1: clearance * split, part2: clearance * (1 - split) } : undefined;
    const bonus = actual === undefined ? undefined : actual - h;
    const data = {
      type,
      unit: doc.units,
      clearance,
      positionTolerance: type === 'floating' ? clearance : clearance * split,
      ...(perPart === undefined ? {} : { perPart, splitDefaulted: params.split === undefined }),
      ...(stated === undefined
        ? {}
        : {
            virtualCondition: h - stated,
            statedWithinClearance:
              stated <= (type === 'floating' ? clearance : clearance * (params.part === 2 ? 1 - split : split)) + 1e-12,
            ...(lmc === undefined ? {} : { allowedPositionAtLmc: stated + (lmc - h) }),
          }),
      ...(bonus === undefined || stated === undefined ? {} : { bonus, allowedPosition: stated + bonus }),
      formulas: {
        floating: 'T = H − F (each part)',
        fixed: 'T1 + T2 = H − F',
        bonus: 'bonus = actual size − MMC size (internal feature)',
        virtualCondition: 'VC = MMC size − position tolerance (internal feature)',
      },
    };
    const parts = perPart === undefined ? `T ${clearance} per part` : `T1 ${perPart.part1}, T2 ${perPart.part2}`;
    return report(
      doc,
      `fastener_tolerance ${type}: H ${h}, F ${f} → ${parts}` +
        (stated === undefined ? '' : `; VC ${h - stated}`) +
        (bonus === undefined || stated === undefined ? '' : `; bonus ${bonus}, allowed position ${stated + bonus}`) +
        ` (${doc.units}).`,
      data,
    );
  },
});
