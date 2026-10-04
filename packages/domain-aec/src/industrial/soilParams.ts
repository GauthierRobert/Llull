/**
 * Soil parameters shared by check_foundations and design_footings.
 * @layer domain-aec
 */

import { z } from '@core/commands/schema';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { type ClayLayer } from './foundationModel';
import { clayLayerError } from './foundationSettlement';

/** Allowable SLS soil bearing pressure, kPa. */
const DEFAULT_SOIL_BEARING = 150;

/** Soil elastic modulus Es, MPa. */
export const DEFAULT_SOIL_MODULUS = 20;

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

/** Validated soil bearing (kPa) and modulus (MPa) with defaults; `reason` is a sentence for the failure summary. */
export function soilInputs(params: {
  soilBearing?: number | undefined;
  soilModulus?: number | undefined;
  clayLayer?: ClayLayer | undefined;
}): { soilBearing: number; soilModulus: number } | { reason: string } {
  const soilBearing = params.soilBearing ?? DEFAULT_SOIL_BEARING;
  const soilModulus = params.soilModulus ?? DEFAULT_SOIL_MODULUS;
  if (!isFiniteNumber(soilBearing) || soilBearing <= 0) {
    return { reason: 'soilBearing must be a number > 0 (kPa).' };
  }
  if (!isFiniteNumber(soilModulus) || soilModulus <= 0) {
    return { reason: 'soilModulus must be a number > 0 (MPa).' };
  }
  const clayError = params.clayLayer === undefined ? null : clayLayerError(params.clayLayer);
  if (clayError) return { reason: `${clayError}.` };
  return { soilBearing, soilModulus };
}
