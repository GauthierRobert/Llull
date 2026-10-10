/**
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import { PURLIN_LOAD_SHAPE } from './purlinLoadParams';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { existingLevelId, getBuilding } from '../model';
import { noop } from '@core/commands/noop';
import { isNonNegativeNumber } from '@lib/isFiniteNumber';
import type { PurlinRow } from './purlinModel';
import { analysePurlins, locatePurlinMembers } from './purlinAnalysis';
import { round } from '../numeric';
import { LIMIT_COLUMNS, checkTable, failureSummary, limitCells } from './checkReport';

/**
 * @command check_purlins
 * @pure read-only
 * @affects none; data = { rows: PurlinRow[], csv, maxUtilisation, failures, zones, ... }
 * @invariant simply supported over one bay; ULS gravity 1.35G + 1.5S; uplift 1.5 W - 1.0 G
 * @failure negative loads / unknown level / no purlins -> no data
 */
export const checkPurlins = defineCommand({
  name: 'check_purlins',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Preliminary check of the roof purlins (role purlin) and side rails (role rail) of the steel hall ' +
    'on a level, e.g. from add_portal_frame_building. Each member is simply supported over its bay ' +
    '(conservative: lapped / continuous purlins are not modelled). Tributary width = half the ' +
    'distance along the slope to each neighbouring purlin (rails: half the vertical distance, ' +
    'ground to eaves at the ends). Roof, per purlin: (1) gravity 1.35 (roofDeadLoad + self-weight) + ' +
    '1.5 snow on plan, components normal to the slope (× cos pitch), bending with the top flange ' +
    'restrained by the sheeting (χLT = 1); (2) wind uplift 1.5 qp (|cpe| + cpi 0.2) - 1.0 dead, with ' +
    'EN 1991-1-4 duopitch roof zones (pitch about 5-15°): e = min(b, 2h) with b the crosswind dimension ' +
    'and h the ridge height; worst of wind across the ridge (θ = 0°: F -1.7 / G -1.2 / H and I -0.6; F/G ' +
    'within e/10 of the eaves, F also within e/4 of a gable) and along the ridge (θ = 90°, Tab. 7.4b: F ' +
    '-1.6 / G -1.3 / H -0.7 / I -0.6; F and G within e/10 of a gable, F within e/4 of the eaves, H up to ' +
    'e/2); multi-span halls (valleys between roofs, EN 1991-1-4 Fig. 7.10 simplified): spans between ' +
    'two valleys are downwind of the windward span for either wind direction and use zone H/I with ' +
    'cpe × 0.6 for θ = 0°; monopitch halls (no ridge) use EN 1991-1-4 Tab. 7.3a instead: θ = 0° (wind on the low ' +
    'eaves) F -1.7 / G -1.2 / H -0.6, θ = 180° (wind on the high eaves) F -2.3 / G -1.3 / H -0.8 with the zones ' +
    'measured from the low / high eaves, θ = 90° F -1.6 / G -1.8 / H -0.6 / I -0.5; the worst zone touching the member applies to its whole length. The ' +
    'bottom flange is in compression: χLT from §6.3.2.3 for I sections with Lcr = span/2, simplified ' +
    'EN 1993-1-3 §10.1 value for cold-formed C sections (0.6 for spans > 6 m, else 0.75), assuming one ' +
    'row of anti-sag bars at mid-span; (3) shear; (4) deflection under characteristic dead + snow ≤ ' +
    'span/200. Rails: horizontal wind on the strong axis, zones A -1.2 (within e/5 of a gable) / B ' +
    '-0.8 (within e) / C -0.5, with cpi +0.2 (inner flange free and in compression: χLT as for purlin uplift), ' +
    'and pressure D +0.8 with cpi -0.3 (restrained, χLT = 1); bending, shear, ' +
    'deflection under characteristic wind ≤ span/150. Cold-formed C sections use an effective section ' +
    'modulus (EN 1993-1-3 §5.5 / 1993-1-5 §4.4, simplified: flange kσ 4 with 0.9 when λp > 0.673, web ψ -1, lips fully effective, no distortional buckling); weak-axis, torsion and cladding self-weight on rails are not ' +
    'checked. Returns one row per member with its governing check; values > 1 fail. Preliminary - ' +
    'not a substitute for the engineer of record.',
  params: z.object({
    ...PURLIN_LOAD_SHAPE,
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const { windPressure = 0.6, snowLoad = 0.8, roofDeadLoad = 0.3 } = params;
    if (
      !isNonNegativeNumber(windPressure) ||
      !isNonNegativeNumber(snowLoad) ||
      !isNonNegativeNumber(roofDeadLoad)
    ) {
      return noop(
        doc,
        'check_purlins failed: windPressure, snowLoad and roofDeadLoad must be >= 0.',
      );
    }
    const levelId = existingLevelId(getBuilding(doc), params.levelId);
    if (levelId === undefined)
      return noop(doc, `check_purlins failed: no level '${params.levelId ?? ''}'.`);
    const { members, skipped } = locatePurlinMembers(doc, levelId);
    const analysis = analysePurlins(members, levelId, { windPressure, snowLoad, roofDeadLoad });
    if ('reason' in analysis) return noop(doc, analysis.reason);
    const { rows, zones, monopitch, eAcross, eAlong } = analysis;
    const { csv, failures, worst } = checkTable(
      rows,
      ['Mark', 'Type', 'Zone', 'Span (m)', ...LIMIT_COLUMNS],
      (row, status) => [row.mark, row.kind, row.zone, round(row.span), ...limitCells(row, status)],
    );
    const purlinRows = rows.filter((row) => row.kind === 'purlin');
    const maxOf = (list: readonly PurlinRow[]): number =>
      round(Math.max(0, ...list.map((row) => row.utilisation)));
    return {
      document: doc,
      summary:
        `Purlin check (qp ${windPressure} kN/m², S ${snowLoad}, roof G ${roofDeadLoad}): ` +
        `${purlinRows.length} purlin(s), ${rows.length - purlinRows.length} rail(s), simply supported per bay; ` +
        `max utilisation purlins ${maxOf(purlinRows)}, rails ${maxOf(rows.filter((row) => row.kind === 'rail'))} ` +
        `(governing ${worst?.mark ?? '—'} ${worst?.kind ?? ''} zone ${worst?.zone ?? '—'}: ${worst?.check ?? '—'}); ` +
        `e = ${round(eAcross / 1000, 1)} m across / ${round(eAlong / 1000, 1)} m along the ridge; ` +
        failureSummary(failures, (row) => `${row.mark} ${row.kind}`, 'all OK (preliminary).') +
        (skipped.length > 0 ? ` Not checked: ${skipped.join(', ')}.` : ''),
      affected: [],
      data: {
        rows,
        csv,
        maxUtilisation: worst?.utilisation ?? 0,
        failures: failures.map((row) => row.elementId),
        zones,
        roofType: monopitch ? 'monopitch' : 'duopitch',
        edgeDistanceAcrossRidge: eAcross,
        edgeDistanceAlongRidge: eAlong,
      },
    };
  },
});
