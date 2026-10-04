/**
 * @layer domain-aec
 */

import type { FootingElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { getBuilding } from '../model';
import { noop } from '@core/commands/noop';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { toCsv } from '../scheduleBuild';
import { describeLoads, FRAME_LOAD_SHAPE, resolveFrameLoads } from './frameCheckPortal';
import { type FrameLoads } from './frameModelTypes';
import { baseReactions } from './frameModelSolve';
import {
  type ClayLayer,
  DEFAULT_SOIL_MODULUS,
  DEFAULT_TIE_CAPACITY,
  type FoundationRow,
  MAX_UTILISATION,
} from './foundationModel';
import {
  defaultThrustTie,
  differentialRows,
  footingRows,
  groundSlabWeight,
  plateRows,
  slidingHorizontalOf,
} from './foundationRows';
import {
  combine,
  findFooting,
  findPlate,
  hasCase,
  ultimateCombinations,
} from './foundationCombinations';
import { clayLayerError, footingSettlementParts } from './foundationSettlement';
import { round } from '../numeric';
import { failureSummary } from './checkReport';

/**
 * Checks footings and base plates of the columns of a level.
 * @pure
 */
function checkFoundations(
  doc: CadDocument,
  levelId: string,
  loads: FrameLoads,
  soilBearing: number,
  thrustTie: boolean,
  tieCapacity: number,
  soilModulus: number = DEFAULT_SOIL_MODULUS,
  clayLayer?: ClayLayer,
): { rows: FoundationRow[]; footings: number; plates: number; unchecked: number } {
  const building = getBuilding(doc);
  const wind = loads.windPressure > 0;
  const rows: FoundationRow[] = [];
  let footings = 0;
  let plates = 0;
  const reactions = baseReactions(doc, building, levelId, loads);
  const checkedFootings = new Set<string>();
  const tieDone = new Set<string>();
  const slabWeight = thrustTie ? groundSlabWeight(doc, building, levelId) : 0;
  const settlements: Array<{
    frame: string;
    x: number;
    column: string;
    footing: FootingElement;
    settlement: number;
  }> = [];
  const slabShare = reactions.length > 0 ? slabWeight / reactions.length : 0;
  for (const reaction of reactions) {
    const column = building.elements[reaction.columnId];
    if (column?.category !== 'member') continue;
    const siblings = reactions.filter((other) => other.frame === reaction.frame);
    const slidingHorizontal = slidingHorizontalOf(reactions, reaction, thrustTie);
    const footing = findFooting(doc, building, levelId, column);
    const plate = findPlate(building, column.id);
    if (thrustTie && !tieDone.has(reaction.frame) && (footing || plate)) {
      tieDone.add(reaction.frame);
      const gravity = ultimateCombinations(
        wind,
        siblings.some((other) => hasCase(other, 'CL') || hasCase(other, 'CR')),
        false,
      ).filter((combination) => !/W/.test(combination.name));
      const tie = gravity
        .flatMap((combination) =>
          siblings.map((other) => ({
            other,
            combination,
            force: Math.abs(combine(other, combination.factors).h),
          })),
        )
        .reduce((best, item) => (item.force > best.force ? item : best));
      rows.push({
        column: reaction.frame,
        footing: '—',
        elementId: tie.other.columnId,
        check: `thrust tie force (assumed 2 H16 B500 = ${round(tieCapacity, 0)} kN)`,
        value: tie.force,
        limit: tieCapacity,
        unit: 'kN',
        utilisation: Math.min(tie.force / tieCapacity, MAX_UTILISATION),
        combination: tie.combination.name,
      });
    }
    if (footing) {
      footings += 1;
      checkedFootings.add(footing.id);
      rows.push(
        ...footingRows(
          doc,
          reaction,
          column.mark,
          footing,
          soilBearing,
          wind,
          slidingHorizontal,
          slabShare,
          soilModulus,
          clayLayer,
        ),
      );
      settlements.push({
        frame: reaction.frame,
        x: footing.location[0],
        column: column.mark,
        footing,
        settlement: footingSettlementParts(doc, reaction, footing, soilModulus, clayLayer).total,
      });
    }
    if (plate) {
      plates += 1;
      rows.push(
        ...plateRows(doc, building, reaction, column.mark, footing?.mark ?? '—', plate, wind),
      );
    }
  }
  rows.push(...differentialRows(doc, settlements));
  const unchecked = Object.values(building.elements).filter(
    (element) =>
      element.category === 'footing' &&
      element.levelId === levelId &&
      !checkedFootings.has(element.id),
  ).length;
  return { rows, footings, plates, unchecked };
}

export const SOIL_SHAPE = {
  soilBearing: z
    .number()
    .optional()
    .describe('Allowable (SLS) soil bearing pressure in kPa. Default 150. Must be > 0.'),
  thrustTie: z
    .boolean()
    .optional()
    .describe(
      'true = the frame thrust is carried by a tie (ground slab cast around the columns or tie ' +
        "bars): each frame's columns share the frame's net horizontal reaction for the sliding " +
        'check and one tie-force row per frame is added. false = every pad resists its own ' +
        'horizontal reaction by friction. Default true when the level has a slab element, else false.',
    ),
  soilModulus: z
    .number()
    .optional()
    .describe(
      'Soil elastic (Young) modulus Es in MPa for the settlement rows. Default 20. Must be > 0.',
    ),
  clayLayer: z
    .object({
      topDepth: z.number().describe('Layer top below founding level, m (>= 0).'),
      thickness: z.number().describe('Layer thickness, m (> 0).'),
      compressionIndex: z.number().describe('Compression index Cc (> 0).'),
      recompressionIndex: z
        .number()
        .optional()
        .describe('Recompression index Cr (> 0, <= Cc). Default Cc/5.'),
      voidRatio: z.number().describe('Initial void ratio e0 (> 0).'),
      unitWeight: z.number().optional().describe('Bulk unit weight kN/m³ (> 9.81). Default 19.'),
      preconsolidationPressure: z
        .number()
        .optional()
        .describe("Preconsolidation pressure σ'p in kPa (> 0). Default: normally consolidated."),
    })
    .optional()
    .describe(
      'Optional compressible clay layer under the pads, adds primary consolidation settlement to the settlement rows. ' +
        'topDepth: depth of the layer top below the founding level, m (>= 0). thickness: m (> 0). compressionIndex: Cc (> 0). ' +
        'recompressionIndex: Cr (> 0, <= Cc; default Cc/5, used only with preconsolidationPressure). voidRatio: e0 (> 0). ' +
        'unitWeight: bulk kN/m³ (> 9.81, default 19; groundwater assumed at the founding level; σ′0 = 18 kN/m³ × founding depth + γ′·z). ' +
        'preconsolidationPressure: σ′p in kPa (> 0; omit for normally consolidated clay). Required: topDepth, thickness, compressionIndex, voidRatio.',
    ),
};

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
    const soilBearing = params.soilBearing ?? 150;
    if (!isFiniteNumber(soilBearing) || soilBearing <= 0) {
      return noop(doc, 'check_foundations failed: soilBearing must be a number > 0 (kPa).');
    }
    const soilModulus = params.soilModulus ?? DEFAULT_SOIL_MODULUS;
    if (!isFiniteNumber(soilModulus) || soilModulus <= 0) {
      return noop(doc, 'check_foundations failed: soilModulus must be a number > 0 (MPa).');
    }
    if (params.clayLayer !== undefined) {
      const clayError = clayLayerError(params.clayLayer);
      if (clayError) return noop(doc, `check_foundations failed: ${clayError}.`);
    }
    const resolved = resolveFrameLoads(doc, params);
    if ('reason' in resolved) return noop(doc, `check_foundations failed: ${resolved.reason}.`);
    const { loads, levelId } = resolved;
    const tieCapacity = params.tieCapacity ?? DEFAULT_TIE_CAPACITY;
    if (!isFiniteNumber(tieCapacity) || tieCapacity <= 0) {
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
    if (rows.length === 0) {
      return noop(
        doc,
        `check_foundations failed: no portal frame column with a footing or base plate on level '${levelId}'.`,
      );
    }
    const failures = rows.filter((row) => row.utilisation > 1);
    const worstRow = rows.reduce((best, row) => (row.utilisation > best.utilisation ? row : best));
    const csv = toCsv(
      [
        'Column',
        'Footing',
        'Check',
        'Value',
        'Limit',
        'Unit',
        'Utilisation',
        'Status',
        'Combination',
      ],
      rows.map((row) => [
        row.column,
        row.footing,
        row.check,
        round(row.value),
        round(row.limit),
        row.unit,
        round(row.utilisation),
        row.utilisation > 1 ? 'FAIL' : 'OK',
        row.combination,
      ]),
    );
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
