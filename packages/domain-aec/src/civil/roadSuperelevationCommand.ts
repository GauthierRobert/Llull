/**
 * Superelevation design command for a road alignment (the geometry lives in superelevation.ts).
 * @layer domain-aec/civil
 */

import type { AlignmentObject } from '@core/model/civil';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { civilAffected, civilObject, getCivil, toMetresText, withObject } from './model';
import { regenerateCivil } from './evaluate';

/** Largest accepted full superelevation rate (ratio). */
export const MAX_SUPERELEVATION_RATE = 0.15;

/**
 * @command set_superelevation
 * @pure
 * @affects sets or removes the superelevation design of 1 alignment (corridor regenerates)
 * @invariant maxRate 0 removes the design; geometry and profile are unchanged
 * @failure unknown alignment / maxRate outside 0..0.15 / runoffLength <= 0 -> no-op
 */
export const setSuperelevation = defineCommand({
  name: 'set_superelevation',
  description:
    'Set the superelevation (banking) of an alignment: `maxRate` is the full rate on circular curves as ' +
    'a ratio (0.07 = 7 %, at most 0.15; 0 removes the design). The section rotates about the ' +
    'centreline with the outer side raised: normal crown on tangents, the adverse side runs out to flat ' +
    'then up to the full rate at a constant rotation rate, reaching it at the SC / CS of a spiral (or 30 % ' +
    'of the runoff inside a curve without spiral). `runoffLength` (document units, > 0) is the ramp ' +
    'length from flat to full rate at each curve end; default the spiral length, or the length that ' +
    'keeps the lane-edge relative gradient at 0.5 % (maxRate x laneWidth / 0.005). A rate below the ' +
    'crossfall is raised to the crossfall. Corridor, cross sections, volumes and alignment_report follow.',
  params: z.object({
    alignmentId: z.string().describe('Alignment id, e.g. "alignment-1".'),
    maxRate: z
      .number()
      .describe('Full superelevation rate on curves, ratio 0..0.15 (0.07 = 7 %). 0 removes it.'),
    runoffLength: z
      .number()
      .optional()
      .describe(
        'Runoff length per curve end, document units (> 0). Default: spiral length or 0.5 % gradient.',
      ),
  }),
  run: (doc, { alignmentId, maxRate, runoffLength }): CommandResult => {
    const alignment = civilObject(getCivil(doc), alignmentId, 'alignment');
    if (!alignment) return noop(doc, `set_superelevation failed: no alignment ${alignmentId}.`);
    if (!Number.isFinite(maxRate) || maxRate < 0 || maxRate > MAX_SUPERELEVATION_RATE) {
      return noop(
        doc,
        `set_superelevation failed: maxRate must be between 0 and ${MAX_SUPERELEVATION_RATE}.`,
      );
    }
    if (runoffLength !== undefined && !(runoffLength > 0 && Number.isFinite(runoffLength))) {
      return noop(doc, 'set_superelevation failed: runoffLength must be > 0.');
    }
    const { superelevation: previous, ...rest } = alignment;
    const updated: AlignmentObject =
      maxRate === 0
        ? rest
        : {
            ...rest,
            superelevation: { maxRate, ...(runoffLength !== undefined ? { runoffLength } : {}) },
          };
    if (JSON.stringify(updated) === JSON.stringify(alignment)) {
      return noop(doc, `set_superelevation: nothing to change on ${alignment.id}.`);
    }
    const document = regenerateCivil(doc, withObject(getCivil(doc), updated));
    const text =
      maxRate === 0
        ? `Removed superelevation (was ${((previous?.maxRate ?? 0) * 100).toFixed(2)} %)`
        : `Set superelevation ${(maxRate * 100).toFixed(2)} %` +
          (runoffLength !== undefined ? `, runoff ${toMetresText(doc, runoffLength)} m` : '');
    return {
      document,
      summary: `${text} on ${alignment.name} (${alignment.id}).`,
      affected: civilAffected(document, [alignment.id]),
    };
  },
});
