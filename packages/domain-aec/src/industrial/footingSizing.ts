/**
 * @layer domain-aec
 */

import type { FootingElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { fromMm, toMetres } from '../model';
import type { BaseReaction } from './frameModelSolve';
import type { Combination, FootingCheckContext } from './foundationModel';
import { footingRows } from './foundationRows';
import { combine, footingMoment, ultimateCombinations } from './foundationCombinations';
import {
  type Geometry,
  type Load,
  MAX_PLAN_MM,
  MAX_THICKNESS_MM,
  MIN_THICKNESS_MM,
  PLAN_MARGIN_MM,
  PLAN_STEP_MM,
  type PadSize,
  THICKNESS_STEP_MM,
} from './footingModel';
import { designMat } from './footingMat';

export function geometryOf(
  doc: CadDocument,
  footing: FootingElement,
  face: { x: number; y: number },
): Geometry {
  const toMm = (value: number): number => toMetres(doc, value) * 1000;
  return {
    widthMm: toMm(footing.width),
    lengthMm: toMm(footing.length),
    thicknessMm: toMm(footing.thickness),
    faceXmm: Math.min(face.x, toMm(footing.width)),
    faceYmm: Math.min(face.y, toMm(footing.length)),
    leverM: toMetres(doc, footing.thickness) + Math.max(0, -toMetres(doc, footing.topOffset)),
  };
}

/** Net ULS loads (no footing / backfill weight) of the compression combinations. */
export function netLoads(
  reaction: BaseReaction,
  combinations: ReadonlyArray<Combination>,
  leverM: number,
): Load[] {
  return combinations.flatMap((combination) => {
    const { v, h, m } = combine(reaction, combination.factors);
    return v > 0
      ? [{ combination: combination.name, normal: v, moment: footingMoment(m, h, leverM) }]
      : [];
  });
}

const roundUp = (value: number, step: number): number => Math.ceil(value / step - 1e-9) * step;

export const padVolume = (size: PadSize): number => size[0] * size[1] * size[2];

export const sizeText = (size: PadSize): string => size.map((value) => Math.round(value)).join('×');

export interface SizingContext extends FootingCheckContext {
  readonly footing: FootingElement;
  readonly face: { x: number; y: number };
  readonly crane: boolean;
}

interface PadVerdict {
  /** Highest utilisation among the check_foundations footing rows (soil, uplift, overturning, sliding, settlement). */
  soilUtilisation: number;
  mat: ReturnType<typeof designMat> | null;
}

/** Soil rows (same rows as check_foundations) and, when they pass, the reinforced mat of a trial size. */
export function evaluatePad(
  context: SizingContext,
  size: PadSize,
): PadVerdict & { passes: boolean } {
  const [widthMm, lengthMm, thicknessMm] = size;
  const { doc, footing } = context;
  const trial: FootingElement = {
    ...footing,
    width: fromMm(doc, widthMm),
    length: fromMm(doc, lengthMm),
    thickness: fromMm(doc, thicknessMm),
  };
  const rows = footingRows(context, trial, '');
  const soilUtilisation = Math.max(0, ...rows.map((row) => row.utilisation));
  if (soilUtilisation > 1) return { soilUtilisation, mat: null, passes: false };
  const geometry = geometryOf(doc, trial, context.face);
  const net = netLoads(
    context.reaction,
    ultimateCombinations(context.wind, context.crane, false),
    geometry.leverM,
  );
  const mat = designMat(geometry, net);
  return { soilUtilisation, mat, passes: mat.chosen !== null };
}

/** Trial sizes at the current aspect ratio, ascending concrete volume (wider plan first on ties). */
export function trialSizes(
  current: PadSize,
  face: { x: number; y: number },
  grow: boolean,
): PadSize[] {
  const [currentWidth, currentLength, currentThickness] = current;
  const ratio = currentLength / currentWidth;
  const footprintWidth = Math.max(
    face.x + 2 * PLAN_MARGIN_MM,
    (face.y + 2 * PLAN_MARGIN_MM) / ratio,
  );
  const firstWidth = roundUp(
    grow ? Math.max(footprintWidth, currentWidth) : footprintWidth,
    PLAN_STEP_MM,
  );
  const firstThickness = grow
    ? Math.max(MIN_THICKNESS_MM, roundUp(currentThickness, THICKNESS_STEP_MM))
    : MIN_THICKNESS_MM;
  const sizes: PadSize[] = [];
  for (let width = firstWidth; width <= MAX_PLAN_MM; width += PLAN_STEP_MM) {
    const length = roundUp(width * ratio, PLAN_STEP_MM);
    if (length > MAX_PLAN_MM) break;
    if (grow && length < currentLength) continue;
    for (
      let thickness = firstThickness;
      thickness <= MAX_THICKNESS_MM;
      thickness += THICKNESS_STEP_MM
    ) {
      sizes.push([width, length, thickness]);
    }
  }
  return sizes.sort((a, b) => padVolume(a) - padVolume(b) || b[0] - a[0]);
}
