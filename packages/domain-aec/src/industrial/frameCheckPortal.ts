/**
 * @layer domain-aec
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { checkFrames } from './frameCheckFrames';
import { round } from '../numeric';
import { checkTable, failureSummary } from './checkReport';
import { describeLoads, FRAME_LOAD_SHAPE, resolveFrameLoads } from './frameLoadParams';

/**
 * @command check_portal_frames
 * @pure read-only
 * @affects none; data = { rows: CheckRow[], csv, maxUtilisation, failures, combinations, alphaCritical }
 * @failure negative loads / unknown level / no frame -> no data
 */
export const checkPortalFrames = defineCommand({
  name: 'check_portal_frames',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Structural check of the steel portal frames of a level. Each frame (rafters in a vertical ' +
    "plane + the columns under them; bases pinned, or fixed when the base plates have columnBase 'fixed') is solved as a 2D frame (direct stiffness, " +
    'section properties from the profile outline, no root radii) for every EN 1990 combination of ' +
    'dead G (deadLoad + self-weight), snow S, wind W (windPressure, both directions, incl. uplift) ' +
    'and crane C (from add_crane_runway capacity, EN 1991-3 load groups 1 and 5: wheel reactions by statics ' +
    'at the minimum hook approach with φ1 / φ2 (hoisting class) / φ4, transverse drive forces HT (φ5) and ' +
    'skewing forces HS at the brackets; combinations C / C5 with the crane at the left or right rail), with sway imperfections and Horne αcr per storey (all moments amplified ' +
    'by 1/(1−1/αcr) when αcr < 10). Checks: member cross-section (EN 1993-1-1 §6.2), flexural buckling with N–M ' +
    'interaction and lateral-torsional buckling (§6.3; columns full height, LTB between side rails, ' +
    'rafters between purlins, compression flanges assumed fly-braced at purlins / rails), frame sway stability ' +
    '(αcr ≥ 3), end-plate bolt groups (EN 1993-1-8, grade 8.8) and SLS deflections (rafters ' +
    'span/200 under snow, eaves h/150 under wind, rail level h/400 under crane). Returns the worst ' +
    'utilisation per element; values > 1 fail. Bracing, foundations and crane runway beams are ' +
    'checked by check_bracing, check_foundations and check_crane_runways. A preliminary design ' +
    'check, not a substitute for the engineer of record.',
  params: z.object(FRAME_LOAD_SHAPE),
  run: (doc, params): CommandResult => {
    const resolved = resolveFrameLoads(doc, params);
    if ('reason' in resolved) return noop(doc, `check_portal_frames failed: ${resolved.reason}.`);
    const { loads, levelId } = resolved;
    const { rows, frames, skipped, combinations, minAlphaCritical } = checkFrames(
      doc,
      levelId,
      loads,
    );
    if (frames === 0) {
      return noop(
        doc,
        `check_portal_frames failed: no analysable portal frame on the level${skipped.length > 0 ? ` (${skipped.join(', ')})` : ''}.`,
      );
    }
    const { csv, failures, worst } = checkTable(
      rows,
      [
        'Frame',
        'Mark',
        'Type',
        'N (kN)',
        'M (kNm)',
        'V (kN)',
        'Utilisation',
        'Status',
        'Combination',
        'Check',
      ],
      (row, status) => [
        row.frame,
        row.mark,
        row.kind,
        round(row.axial, 1),
        round(row.moment, 1),
        round(row.shear, 1),
        round(row.utilisation),
        status,
        row.combination,
        row.check,
      ],
    );
    return {
      document: doc,
      summary:
        `Checked ${frames} frame(s), ${rows.length} check(s) over ${combinations.length} ULS combination(s) + SLS (${describeLoads(loads)}): ` +
        `max utilisation ${round(worst?.utilisation ?? 0)} (${worst?.mark ?? '—'} ${worst?.kind ?? ''}, ${worst?.frame ?? '—'}, ${worst?.combination ?? '—'}); ` +
        `min αcr ${Number.isFinite(minAlphaCritical) ? round(minAlphaCritical, 1) : '—'}; ` +
        failureSummary(
          failures,
          (row) => `${row.mark} ${row.kind}`,
          'all OK (frames only: see check_bracing, check_foundations, check_crane_runways).',
        ) +
        `${skipped.length > 0 ? ` Not checked: ${skipped.join(', ')}.` : ''}`,
      affected: [],
      data: {
        rows,
        csv,
        maxUtilisation: worst?.utilisation ?? 0,
        failures: [...new Set(failures.map((row) => row.elementId))],
        combinations,
        alphaCritical: Number.isFinite(minAlphaCritical) ? minAlphaCritical : null,
      },
    };
  },
});
