/**
 * Design of one footing under one analysed column: smallest passing pad + reinforcement (EN 1992-1-1).
 * @layer domain-aec
 * @pure
 */

import type { BuildingModel, FootingElement, SteelMemberElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { fromMm, toMetres } from '../model';
import { round } from '../numeric';
import { findProfile } from '../steel/profiles';
import type { BaseReaction } from './frameModelSolve';
import { findPlate, hasCase, ultimateCombinations } from './foundationCombinations';
import {
  COVER_MM,
  FALLBACK_COLUMN_MM,
  type FootingDesignRow,
  MAX_PLAN_MM,
  MAX_THICKNESS_MM,
  type PadSize,
} from './footingModel';
import {
  type SizingContext,
  evaluatePad,
  geometryOf,
  netLoads,
  padVolume,
  sizeText,
  trialSizes,
} from './footingSizing';

export const isResized = (before: PadSize, after: PadSize): boolean =>
  before.some((value, index) => Math.round(value) !== Math.round(after[index] ?? 0));

export interface FootingDesignOutcome {
  readonly row: FootingDesignRow;
  /** Present when the footing's size or reinforcement changed. */
  readonly updated?: FootingElement;
  readonly change?: string;
}

const emptyRow = {
  barDiameter: null,
  spacing: null,
  asProvided: null,
  asRequired: 0,
  shearUtilisation: 0,
  punchingUtilisation: 0,
  punchingDistance: 0,
  combination: '-',
} as const;

export interface FootingDesignInputs {
  readonly doc: CadDocument;
  readonly building: BuildingModel;
  readonly footing: FootingElement;
  readonly column: SteelMemberElement;
  readonly reaction: BaseReaction;
  readonly wind: boolean;
  readonly allowShrink: boolean;
  readonly soilBearing: number;
  readonly soilModulus: number;
  readonly clayLayer: SizingContext['clayLayer'];
  readonly slidingHorizontal: SizingContext['slidingHorizontal'];
  readonly slabShare: number;
}

export function designFootingRow(inputs: FootingDesignInputs): FootingDesignOutcome {
  const { doc, building, footing, column, reaction, wind, allowShrink } = inputs;
  const toMm = (value: number): number => toMetres(doc, value) * 1000;
  const plate = findPlate(building, column.id);
  const profile = findProfile(column.profile);
  const face = plate
    ? { x: toMm(plate.length), y: toMm(plate.width) }
    : { x: profile?.h ?? FALLBACK_COLUMN_MM, y: profile?.b ?? FALLBACK_COLUMN_MM };
  const crane = hasCase(reaction, 'CL') || hasCase(reaction, 'CR');
  const current: PadSize = [toMm(footing.width), toMm(footing.length), toMm(footing.thickness)];
  const base = { id: footing.id, mark: footing.mark, column: column.mark };
  const unloadedNet = netLoads(
    reaction,
    ultimateCombinations(wind, crane, false),
    geometryOf(doc, footing, face).leverM,
  );
  if (unloadedNet.length === 0) {
    return {
      row: {
        ...base,
        ...emptyRow,
        status: 'unloaded',
        sizeBefore: current,
        sizeAfter: current,
        note: 'no ULS combination with net compression; reinforcement not set',
      },
    };
  }
  const context: SizingContext = {
    doc,
    footing,
    face,
    reaction,
    wind,
    crane,
    soilBearing: inputs.soilBearing,
    soilModulus: inputs.soilModulus,
    clayLayer: inputs.clayLayer,
    slidingHorizontal: inputs.slidingHorizontal,
    slabShare: inputs.slabShare,
  };
  const currentVerdict = evaluatePad(context, current);
  let size = current;
  let verdict = currentVerdict;
  if (!currentVerdict.passes || allowShrink) {
    const candidates = trialSizes(current, face, !allowShrink);
    const found = candidates.find((candidate) => {
      if (currentVerdict.passes && padVolume(candidate) >= padVolume(current)) return false;
      const trial = evaluatePad(context, candidate);
      if (trial.passes) verdict = trial;
      return trial.passes;
    });
    if (found) size = found;
    else if (!currentVerdict.passes) {
      const largest = candidates[candidates.length - 1];
      if (largest) verdict = evaluatePad(context, largest);
    }
  }
  const chosen = verdict.passes ? verdict.mat?.chosen : null;
  if (chosen) {
    const resized = isResized(size, current);
    const reinforcement = {
      barDiameter: fromMm(doc, chosen.diameter),
      spacing: fromMm(doc, chosen.spacing),
      cover: fromMm(doc, COVER_MM),
    };
    const { reinforcement: previous, ...bare } = footing;
    const row: FootingDesignRow = {
      ...base,
      status: 'designed',
      sizeBefore: current,
      sizeAfter: size,
      barDiameter: chosen.diameter,
      spacing: chosen.spacing,
      asRequired: chosen.asRequired,
      asProvided: chosen.asProvided,
      shearUtilisation: chosen.shear,
      punchingUtilisation: chosen.punching,
      punchingDistance: chosen.punchingDistance,
      combination: chosen.combination,
      note: '',
    };
    if (
      !resized &&
      previous?.barDiameter === reinforcement.barDiameter &&
      previous.spacing === reinforcement.spacing &&
      previous.cover === reinforcement.cover
    ) {
      return { row };
    }
    return {
      row,
      updated: {
        ...bare,
        ...(resized
          ? {
              width: fromMm(doc, size[0]),
              length: fromMm(doc, size[1]),
              thickness: fromMm(doc, size[2]),
            }
          : {}),
        reinforcement,
      },
      change: `${footing.mark}${resized ? ` ${sizeText(current)} → ${sizeText(size)}` : ''} H${chosen.diameter} @ ${chosen.spacing}`,
    };
  }
  const closest = verdict.mat?.closest ?? null;
  return {
    row: {
      ...base,
      status: 'failed',
      sizeBefore: current,
      sizeAfter: current,
      barDiameter: null,
      spacing: null,
      asRequired: closest?.asRequired ?? 0,
      asProvided: null,
      shearUtilisation: closest?.shear ?? 0,
      punchingUtilisation: closest?.punching ?? 0,
      punchingDistance: closest?.punchingDistance ?? 0,
      combination: closest?.combination ?? '-',
      note:
        verdict.soilUtilisation > 1
          ? `no pad up to ${MAX_PLAN_MM}×${MAX_PLAN_MM}×${MAX_THICKNESS_MM} mm passes soil bearing / overturning / uplift / sliding / settlement (utilisation ${round(verdict.soilUtilisation)} at the largest pad); left unchanged`
          : verdict.mat?.bendingLimited
            ? 'bending needs more than H25 @ 100 within the size limits; left unchanged'
            : 'shear, punching or bending fails with every pad within the size limits; left unchanged',
    },
  };
}
