/**
 * @layer domain-aec
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { elementAffected, fromMm, getBuilding, toMetres, withElement } from '../model';
import { noop } from '@core/commands/noop';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { findProfile } from '../steel/profiles';
import { describeLoads, FRAME_LOAD_SHAPE, resolveFrameLoads } from './frameCheckPortal';
import { baseReactions } from './frameModelSolve';
import { SOIL_SHAPE } from './foundationCheckRun';
import { findFooting, findPlate, ultimateCombinations, hasCase } from './foundationCombinations';
import { defaultThrustTie, groundSlabWeight, slidingHorizontalOf } from './foundationRows';
import { clayLayerError } from './foundationSettlement';
import {
  COVER_MM,
  DEFAULT_SOIL_BEARING,
  DEFAULT_SOIL_MODULUS,
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
  sizeText,
  trialSizes,
} from './footingSizing';
import { round } from '../numeric';

const footingDesignParams = z.object({
  ...FRAME_LOAD_SHAPE,
  ...SOIL_SHAPE,
  allowShrink: z
    .boolean()
    .optional()
    .describe(
      'true = also reduce oversized pads that already pass to the smallest passing size. Default false (pads are only grown, never shrunk).',
    ),
});

/**
 * @command design_footings
 * @pure
 * @affects sizes (grows, or shrinks with allowShrink) and reinforces every analysed footing; a footing
 *          with no passing size within 6 m × 6 m × 1.5 m is left unchanged
 * @failure bad loads / unknown level / no footing under an analysed frame column -> no-op
 */
export const designFootings = defineCommand({
  name: 'design_footings',
  description:
    'Size and design the reinforced-concrete pad footings under the portal-frame columns of a level ' +
    'to EN 1992-1-1 (C25/30, B500) and store the plan size, thickness and bottom reinforcement on each footing, using the same ' +
    'base reactions, loads and soil parameters as check_foundations (deadLoad / snowLoad / windPressure / ' +
    'craneCapacity, soilBearing, thrustTie, soilModulus, clayLayer). Essential for fixed column bases (columnBase "fixed"), whose ' +
    'default pads are far too small. Sizing: plan B × L keeps the existing aspect ratio (square for the default pads) in 100 mm steps ' +
    'from the plate / column footprint + 2 × 100 mm up to 6 m, thickness h 300–1500 mm in 50 mm steps; the smallest concrete volume ' +
    '(ties: wider plan first) that passes ALL of: the check_foundations footing rows (soil bearing with eccentricity incl. base moments, ' +
    'overturning, uplift EQU, sliding, settlement, evaluated with the founding level dropping as h grows, topOffset kept) AND the reinforced ' +
    'mat below. Pads that already pass are not shrunk (only grown) unless allowShrink is true. The top level (topOffset) stays fixed. ' +
    'Mat: ULS net soil pressure (no self-weight) from 1.35G + 1.5S / ' +
    'wind / crane combinations with load eccentricity (trapezoidal or triangular pressure); ' +
    'bending at the face of the base plate (else the column profile), d = h − 50 mm cover − φ, ' +
    'z ≤ 0.95d with K ≤ 0.167, As,min = 0.26 fctm/fyk b d; the lightest bar φ12/16/20/25 at ' +
    '100–250 mm spacing (same both ways) satisfying As, one-way shear VRd,c at d from the face ' +
    '(§6.2.2, CRd,c 0.12) and punching at every control perimeter a ≤ 2d from the face (§6.4.4, vRd,c·2d/a) with the ' +
    'soil pressure inside it deducted (§6.4). If no size within 6 × 6 × 1.5 m passes, the footing is reported as failed and left ' +
    'unchanged (size and reinforcement). The summary lists the size changes (e.g. "F1 1500×1500×400 → 2600×2600×700"); the takeoff ' +
    'reports concrete and `footing.rebar.kg` for the new sizes. ' +
    'Simplifications: bending in the frame plane (x) from the horizontal reaction and, for fixed column bases, the base moment (eccentric pressure), ' +
    'uniform pressure across the other side, no uplift (tension) design, bar anchorage not checked. ' +
    'Preliminary design, not a substitute for a structural engineer.',
  params: footingDesignParams,
  run: (doc, params): CommandResult => {
    const soilBearing = params.soilBearing ?? DEFAULT_SOIL_BEARING;
    const soilModulus = params.soilModulus ?? DEFAULT_SOIL_MODULUS;
    if (!isFiniteNumber(soilBearing) || soilBearing <= 0) {
      return noop(doc, 'design_footings failed: soilBearing must be a number > 0 (kPa).');
    }
    if (!isFiniteNumber(soilModulus) || soilModulus <= 0) {
      return noop(doc, 'design_footings failed: soilModulus must be a number > 0 (MPa).');
    }
    if (params.clayLayer !== undefined) {
      const clayError = clayLayerError(params.clayLayer);
      if (clayError) return noop(doc, `design_footings failed: ${clayError}.`);
    }
    const resolved = resolveFrameLoads(doc, params);
    if ('reason' in resolved) return noop(doc, `design_footings failed: ${resolved.reason}.`);
    const { loads, levelId } = resolved;
    const allowShrink = params.allowShrink ?? false;
    const thrustTie = params.thrustTie ?? defaultThrustTie(doc, levelId);
    const building = getBuilding(doc);
    const wind = loads.windPressure > 0;
    const reactions = baseReactions(doc, building, levelId, loads);
    const slabShare =
      thrustTie && reactions.length > 0
        ? groundSlabWeight(doc, building, levelId) / reactions.length
        : 0;
    const rows: FootingDesignRow[] = [];
    const seen = new Set<string>();
    let next = building;
    const changes: string[] = [];
    const changed: string[] = [];
    const toMm = (value: number): number => toMetres(doc, value) * 1000;
    for (const reaction of reactions) {
      const column = building.elements[reaction.columnId];
      if (column?.category !== 'member') continue;
      const footing = findFooting(doc, building, levelId, column);
      if (!footing || seen.has(footing.id)) continue;
      seen.add(footing.id);
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
        rows.push({
          ...base,
          status: 'unloaded',
          sizeBefore: current,
          sizeAfter: current,
          barDiameter: null,
          spacing: null,
          asRequired: 0,
          asProvided: null,
          shearUtilisation: 0,
          punchingUtilisation: 0,
          punchingDistance: 0,
          combination: '-',
          note: 'no ULS combination with net compression; reinforcement not set',
        });
        continue;
      }
      const context: SizingContext = {
        doc,
        footing,
        face,
        reaction,
        wind,
        crane,
        soilBearing,
        soilModulus,
        clayLayer: params.clayLayer,
        slidingHorizontal: slidingHorizontalOf(reactions, reaction, thrustTie),
        slabShare,
      };
      const currentVerdict = evaluatePad(context, current);
      const volume = (size: PadSize): number => size[0] * size[1] * size[2];
      let size = current;
      let verdict = currentVerdict;
      if (!currentVerdict.passes || allowShrink) {
        const candidates = trialSizes(current, face, !allowShrink);
        const found = candidates.find((candidate) => {
          if (currentVerdict.passes && volume(candidate) >= volume(current)) return false;
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
        const resized = size.some(
          (value, index) => Math.round(value) !== Math.round(current[index] ?? 0),
        );
        const reinforcement = {
          barDiameter: fromMm(doc, chosen.diameter),
          spacing: fromMm(doc, chosen.spacing),
          cover: fromMm(doc, COVER_MM),
        };
        const { reinforcement: previous, ...bare } = footing;
        if (
          resized ||
          previous?.barDiameter !== reinforcement.barDiameter ||
          previous.spacing !== reinforcement.spacing ||
          previous.cover !== reinforcement.cover
        ) {
          next = withElement(next, {
            ...bare,
            ...(resized
              ? {
                  width: fromMm(doc, size[0]),
                  length: fromMm(doc, size[1]),
                  thickness: fromMm(doc, size[2]),
                }
              : {}),
            reinforcement,
          });
          changed.push(footing.id);
          changes.push(
            `${footing.mark}${resized ? ` ${sizeText(current)} → ${sizeText(size)}` : ''} H${chosen.diameter} @ ${chosen.spacing}`,
          );
        }
        rows.push({
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
        });
        continue;
      }
      const closest = verdict.mat?.closest ?? null;
      rows.push({
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
      });
    }
    if (rows.length === 0) {
      return noop(
        doc,
        `design_footings failed: no portal frame column with a footing on level '${levelId}'.`,
      );
    }
    const designed = rows.filter((row) => row.status === 'designed');
    const failed = rows.filter((row) => row.status === 'failed');
    const maxOf = (pick: (row: FootingDesignRow) => number): number =>
      Math.max(0, ...designed.map(pick));
    const maxShear = maxOf((row) => row.shearUtilisation);
    const maxPunching = maxOf((row) => row.punchingUtilisation);
    const format = (row: FootingDesignRow): string => {
      const resized = row.sizeBefore.some(
        (value, index) => Math.round(value) !== Math.round(row.sizeAfter[index] ?? 0),
      );
      return `${row.mark}${resized ? ` ${sizeText(row.sizeBefore)} → ${sizeText(row.sizeAfter)}` : ''} H${row.barDiameter} @ ${row.spacing} (As ${round(row.asRequired, 0)} ≤ ${round(row.asProvided ?? 0, 0)} mm²/m, shear ${round(row.shearUtilisation)}, punching ${round(row.punchingUtilisation)}${row.punchingDistance > 0 ? ` at a=${round(row.punchingDistance, 0)} mm` : ''})`;
    };
    const document = changed.length > 0 ? { ...doc, building: next } : doc;
    return {
      document,
      summary:
        `Designed ${designed.length} of ${rows.length} footing(s) on level '${levelId}' (${describeLoads(loads)}, soil ${soilBearing} kPa, C25/30 B500, cover ${COVER_MM} mm, ${allowShrink ? 'sizes may shrink' : 'sizes only grow'}; sizes B×L×h mm): ` +
        `${designed.length > 0 ? designed.slice(0, 8).map(format).join('; ') + (designed.length > 8 ? '; …' : '') : 'none'}. ` +
        (failed.length > 0
          ? `${failed.length} not sized — left unchanged: ${failed
              .slice(0, 8)
              .map(
                (row) =>
                  `${row.mark} (${row.note}; shear ${round(row.shearUtilisation)}, punching ${round(row.punchingUtilisation)})`,
              )
              .join('; ')}. `
          : '') +
        `Max shear ${round(maxShear)}, max punching ${round(maxPunching)}; ` +
        `${changed.length > 0 ? `${changed.length} footing(s) changed` : 'no change'}. Bending in the frame plane.`,
      affected: elementAffected(document, changed),
      data: { footings: rows, changes },
    };
  },
});
