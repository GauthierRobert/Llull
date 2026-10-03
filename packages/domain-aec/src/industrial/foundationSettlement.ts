/**
 * foundationCheck: foundationSettlement.
 * @layer domain-aec
 */

import type { FootingElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { isFiniteNumber, toMetres } from '../model';
import type { BaseReaction } from './frameModel';
import { combine } from './foundationCombinations';
import {
  BACKFILL_UNIT_WEIGHT,
  CONCRETE_UNIT_WEIGHT,
  CONSOLIDATION_SUBLAYERS,
  type ClayLayer,
  DEFAULT_CLAY_UNIT_WEIGHT,
  POISSON_RATIO,
  SETTLEMENT_INFLUENCE,
  WATER_UNIT_WEIGHT,
} from './foundationModel';

function footingNetPressure(
  doc: CadDocument,
  reaction: BaseReaction,
  footing: FootingElement,
): { pressure: number; breadth: number; length: number; foundingDepth: number } {
  const [widthX, lengthY, thickness] = [footing.width, footing.length, footing.thickness].map(
    (value) => toMetres(doc, value),
  ) as [number, number, number];
  const backfill = Math.max(0, -toMetres(doc, footing.topOffset));
  const area = widthX * lengthY;
  const { v } = combine(reaction, { G: 1, S: 1 });
  const gross =
    (v + (CONCRETE_UNIT_WEIGHT * thickness + BACKFILL_UNIT_WEIGHT * backfill) * area) / area;
  return {
    pressure: Math.max(0, gross - BACKFILL_UNIT_WEIGHT * (thickness + backfill)),
    breadth: Math.min(widthX, lengthY),
    length: Math.max(widthX, lengthY),
    foundingDepth: thickness + backfill,
  };
}

/** Strict validation of a clay layer; returns an error message or null. */
export function clayLayerError(layer: unknown): string | null {
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) {
    return 'clayLayer must be an object { topDepth, thickness, compressionIndex, voidRatio, ... }';
  }
  const fields = layer as Record<string, unknown>;
  const positive = (name: string, allowZero = false): string | null => {
    const value = fields[name];
    return isFiniteNumber(value) && (allowZero ? value >= 0 : value > 0)
      ? null
      : `clayLayer.${name} must be a number ${allowZero ? '>= 0' : '> 0'}`;
  };
  const optional = (name: string): string | null =>
    fields[name] === undefined ? null : positive(name);
  const error =
    positive('topDepth', true) ??
    positive('thickness') ??
    positive('compressionIndex') ??
    positive('voidRatio') ??
    optional('recompressionIndex') ??
    optional('unitWeight') ??
    optional('preconsolidationPressure');
  if (error) return error;
  const unitWeight = (fields.unitWeight as number | undefined) ?? DEFAULT_CLAY_UNIT_WEIGHT;
  if (unitWeight <= WATER_UNIT_WEIGHT) {
    return `clayLayer.unitWeight must be > ${WATER_UNIT_WEIGHT} kN/m³ (water)`;
  }
  const cr = fields.recompressionIndex as number | undefined;
  if (cr !== undefined && cr > (fields.compressionIndex as number)) {
    return 'clayLayer.recompressionIndex must be <= compressionIndex';
  }
  return null;
}

/**
 * Primary consolidation settlement (mm) of a clay layer in 5 sublayers: groundwater at the founding level,
 * γ' = unitWeight − 9.81, σ'0 = 18 D + γ' z (D = founding depth, z below the founding level), Δσ = q B L / ((B + z)(L + z)) at the sublayer centre (2:1 spreading),
 * s = Σ Cc h/(1+e0) log10((σ'0+Δσ)/σ'0); with σ'p, Cr up to σ'p and Cc beyond.
 * @pure
 */
export function consolidationSettlement(
  netPressure: number,
  breadth: number,
  length: number,
  layer: ClayLayer,
  foundingDepth: number = 0,
): number {
  const effectiveWeight = (layer.unitWeight ?? DEFAULT_CLAY_UNIT_WEIGHT) - WATER_UNIT_WEIGHT;
  const recompression = layer.recompressionIndex ?? layer.compressionIndex / 5;
  const sublayer = layer.thickness / CONSOLIDATION_SUBLAYERS;
  let total = 0;
  for (let index = 0; index < CONSOLIDATION_SUBLAYERS; index++) {
    const z = layer.topDepth + (index + 0.5) * sublayer;
    const initial = BACKFILL_UNIT_WEIGHT * foundingDepth + effectiveWeight * z;
    const increase = (netPressure * breadth * length) / ((breadth + z) * (length + z));
    const final = initial + increase;
    const preconsolidation = layer.preconsolidationPressure;
    let strainIndex: number;
    if (preconsolidation === undefined || preconsolidation <= initial) {
      strainIndex = layer.compressionIndex * Math.log10(final / initial);
    } else if (final <= preconsolidation) {
      strainIndex = recompression * Math.log10(final / initial);
    } else {
      strainIndex =
        recompression * Math.log10(preconsolidation / initial) +
        layer.compressionIndex * Math.log10(final / preconsolidation);
    }
    total += (sublayer * strainIndex) / (1 + layer.voidRatio);
  }
  return total * 1000;
}

/**
 * Elastic settlement (mm) of a pad under SLS G+S: s = q B (1 − ν²) Is / Es, Is 0.88 (rigid square), q = (V + footing + backfill) / area − 18 kN/m³ × founding depth.
 * @pure
 */
export function footingSettlement(
  doc: CadDocument,
  reaction: BaseReaction,
  footing: FootingElement,
  soilModulus: number,
): number {
  const { pressure, breadth } = footingNetPressure(doc, reaction, footing);
  return (
    ((pressure * breadth * (1 - POISSON_RATIO ** 2) * SETTLEMENT_INFLUENCE) /
      (soilModulus * 1000)) *
    1000
  );
}

/** Elastic + primary consolidation settlement (mm) of a pad. */
export function footingSettlementParts(
  doc: CadDocument,
  reaction: BaseReaction,
  footing: FootingElement,
  soilModulus: number,
  clayLayer?: ClayLayer,
): { elastic: number; consolidation: number; total: number } {
  const elastic = footingSettlement(doc, reaction, footing, soilModulus);
  const { pressure, breadth, length, foundingDepth } = footingNetPressure(doc, reaction, footing);
  const consolidation = clayLayer
    ? consolidationSettlement(pressure, breadth, length, clayLayer, foundingDepth)
    : 0;
  return { elastic, consolidation, total: elastic + consolidation };
}
