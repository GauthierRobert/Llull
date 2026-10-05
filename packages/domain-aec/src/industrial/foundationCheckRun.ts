/**
 * @layer domain-aec
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { describeLoads, FRAME_LOAD_SHAPE, resolveFrameLoads } from './frameLoadParams';
import { DEFAULT_TIE_CAPACITY } from './foundationModel';
import { SOIL_SHAPE, soilInputs } from './soilParams';
import { checkFoundations } from './foundationAssessment';
import { defaultThrustTie } from './foundationThrust';
import { round } from '../numeric';
import { LIMIT_COLUMNS, checkTable, failureSummary, limitCells } from './checkReport';

const foundationCheckParams = z.object({
  ...FRAME_LOAD_SHAPE,
  ...SOIL_SHAPE,
  tieCapacity: z
    .number()
    .optional()
    .describe(
      'Tie capacity in kN used for the tie-force row (thrustTie only). Default 175 = 2 × H16 B500 ' +
        'bars (fyd 435 N/mm²). Must be > 0.',
    ),
});

/**
 * @command check_foundations
 * @pure read-only
 * @affects none; data = { rows: FoundationRow[], csv, maxUtilisation, failures }
 * @failure bad params / unknown level / no footing or base plate under a frame column -> no data
 */
export const foundationCheck = defineCommand({
  name: 'check_foundations',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Preliminary foundation check of the portal-frame columns of a level, from the characteristic ' +
    'base reactions of the same frame analysis as check_portal_frames (same deadLoad / snowLoad / ' +
    'windPressure / craneCapacity inputs). For every column with a pad footing (location at the ' +
    'column base) and/or a base plate: (1) soil bearing under SLS G+S, G+S+0.6W (either way), G+W, ' +
    'G+C, pressure = (V + footing 25 kN/m³ + backfill 18 kN/m³ above the footing up to the level) / ' +
    'area, with load eccentricity from H × (footing depth + backfill) reducing the width to B′ = B − 2e ' +
    '(Meyerhof) against `soilBearing` (kPa, default 150); (2) uplift EQU, 0.9 × (footing + backfill ' +
    'weight) vs net uplift under 0.9G + 1.5W (only with windPressure > 0); (3) sliding, H vs ' +
    'μ = 0.45 × (V + weights) / γR,h (γR,h = 1.1, EN 1997 DA2) under 1.0G + 1.5 S / W / 1.35 C, with ' +
    'the thrust shared across the frame columns when thrustTie (a tie or slab is assumed to take ' +
    'the gravity thrust, checked against tieCapacity under 1.35G + 1.5S / crane without wind, and ' +
    'the ground slab weight adds its friction, shared per column); (4) base plate: concrete bearing under ' +
    '1.35G + 1.5S / wind / crane combinations vs fjd = 2/3 × 1.5 × fcd (C25/30, fcd 16.7 N/mm²) over ' +
    'the whole plate area, anchor tension (uplift shared by all bolts vs 0.9 fub As / 1.25) and ' +
    'bolt shear + tension interaction (shear αbc fub As / 1.25 with αbc = 0.44 − 0.0003 fyb, threads ' +
    'in the shear plane, EN 1993-1-8 §6.2.2(7); Ft/1.4), always grade 8.8. Fixed column bases (base plates ' +
    "with fixity 'fixed', add_portal_frame_building columnBase) add the base moment: bearing eccentricity " +
    'e = (M + H·lever) / (V + W), an overturning EQU row (stabilising 0.9G·B/2 vs destabilising moment) and a ' +
    "'base plate M+N' row (concrete bearing block fjd, tension anchor bolts Ft = (M − N zc)/z, plate bending; " +
    'EN 1993-1-8 §6.2.8 simplified; design_portal_frames sizes the plate). Simplifications: pinned ' +
    'bases have no moment, horizontal force taken at the plate level, bending in the smaller footing ' +
    'side, no biaxial effects, no backfill reduction for the column, no friction in the anchor ' +
    'shear check, no footing reinforcement or punching (see design_footings). (5) Elastic settlement of each pad under SLS G+S, s = q B (1 − ν²) Is / Es (net pressure q − 18 kN/m³ × founding depth, i.e. footing + backfill weight replaces excavated soil; Is 0.88 rigid square, ν 0.3, Es = `soilModulus`, default 20 MPa) vs 25 mm, plus the worst differential settlement between adjacent columns of a frame vs L/500. With the optional `clayLayer` the primary consolidation of a clay layer below the footing (5 sublayers, groundwater at the founding level, γ′ = unitWeight − 9.81, σ′0 = 18 kN/m³ × founding depth + γ′ z, Δσ by 2:1 spreading, s = Σ Cc h/(1+e0) log10((σ′0+Δσ)/σ′0), Cr up to preconsolidationPressure and Cc beyond) is added to the elastic settlement (same 25 mm limit, row text gives both parts) and feeds the differential row. Returns one row per check ' +
    'and column (worst combination); utilisation > 1 fails. Not a substitute for a geotechnical ' +
    'or structural engineer.',
  params: foundationCheckParams,
  run: (doc, params): CommandResult => {
    const soil = soilInputs(params);
    if ('reason' in soil) return noop(doc, `check_foundations failed: ${soil.reason}`);
    const { soilBearing, soilModulus } = soil;
    const resolved = resolveFrameLoads(doc, params);
    if ('reason' in resolved) return noop(doc, `check_foundations failed: ${resolved.reason}.`);
    const { loads, levelId } = resolved;
    const tieCapacity = params.tieCapacity ?? DEFAULT_TIE_CAPACITY;
    if (tieCapacity <= 0) {
      return noop(doc, 'check_foundations failed: tieCapacity must be a number > 0 (kN).');
    }
    const thrustTie = params.thrustTie ?? defaultThrustTie(doc, levelId);
    const { rows, footings, plates, unchecked } = checkFoundations(
      doc,
      levelId,
      loads,
      soilBearing,
      thrustTie,
      tieCapacity,
      soilModulus,
      params.clayLayer,
    );
    const {
      csv,
      failures,
      worst: worstRow,
    } = checkTable(rows, ['Column', 'Footing', ...LIMIT_COLUMNS], (row, status) => [
      row.column,
      row.footing,
      ...limitCells(row, status),
    ]);
    if (!worstRow) {
      return noop(
        doc,
        `check_foundations failed: no portal frame column with a footing or base plate on level '${levelId}'.`,
      );
    }
    const failureIds = [...new Set(failures.map((row) => row.elementId))];
    return {
      document: doc,
      summary:
        `Checked ${footings} footing(s) and ${plates} base plate(s) on level '${levelId}' ` +
        `(${describeLoads(loads)}, soil ${soilBearing} kPa, Es ${soilModulus} MPa, ${thrustTie ? `thrust taken by a tie / slab (capacity ${tieCapacity} kN)` : 'thrust resisted by pad friction'}): ${rows.length} check(s), ` +
        (unchecked > 0
          ? `${unchecked} footing(s) not checked (no analysed frame column, e.g. gable posts); `
          : '') +
        `max utilisation ${round(worstRow.utilisation)} (${worstRow.column} ${worstRow.check}, ${worstRow.combination}); ` +
        failureSummary(
          failures,
          (row) => `${row.column} ${row.check}`,
          'all OK (no reinforcement check).',
        ),
      affected: [],
      data: {
        rows,
        csv,
        maxUtilisation: worstRow.utilisation,
        failures: failureIds,
      },
    };
  },
});
