/**
 * Riser rule of check_pipe_supports. A riser is a run of segments steeper than 44° from horizontal
 * (|dz| / length > 0.7) and at least 0.5 m long. Rule of this check (a design-aid rule, not a quoted
 * code clause): lateral restraints (attached guides and anchors on the riser, an end carried by
 * equipment or a header) at most the MSS SP-69 span of the DN × spanFactor apart, a free end (elbow)
 * at most overhangRatio × that span from the nearest restraint, and the riser weight carried by an end
 * in equipment / on a header (nozzle), a shoe or anchor clamp on the riser, or an attached support of
 * the pipe within overhangRatio × that span (along the pipe) of one of its elbows — the riser hangs on
 * the elbow like a free end, so the leg to the next support is limited as an overhang is.
 * @layer domain-aec
 * @pure
 */

import { round } from '../numeric';
import { metres as shown } from './steelMemberRows';
import { pipeWeightPerMetre } from './pipeWeight';
import { riserRuns } from './routeSupport';
import type { EndCarrier, PipeRun, SupportStation } from './pipeSupportLayout';

export interface RiserRow {
  /** Elevations of the riser start / end (absolute), m. */
  readonly fromZM: number;
  readonly toZM: number;
  readonly lengthM: number;
  /** Attached guides / anchors on the riser. */
  readonly guides: number;
  /** Largest distance between lateral restraints (carried ends included) or from a free end to the nearest one, m. */
  readonly maxGuideSpacingM: number;
  /** Allowed spacing = table span × spanFactor, m. */
  readonly allowedSpacingM: number;
  readonly weightKn: number;
  /** What carries the riser weight; null when nothing does. */
  readonly weightBy: 'carried end' | 'clamp' | 'elbow support' | null;
  readonly ok: boolean;
  readonly issues: string[];
}

const EPSILON = 1e-6;
/** kg/m³: the pipe is taken water-filled, as in check_steel_members. */
const WATER_DENSITY = 1000;

/** Verdict of every riser of `run`; `allowedMm` = span table × spanFactor in mm. */
export function riserRows(
  run: PipeRun,
  stations: ReadonlyArray<SupportStation>,
  carriers: readonly [EndCarrier | null, EndCarrier | null],
  allowedMm: number,
  overhangRatio: number,
): RiserRow[] {
  const metres = (millimetres: number): number => round(millimetres / 1000, 2);
  return riserRuns(run.points).map((riser): RiserRow => {
    const onRun = (station: SupportStation): boolean =>
      station.onRiser &&
      station.attached &&
      station.arc >= riser.startArc - 1 &&
      station.arc <= riser.endArc + 1;
    const lateral = stations
      .filter(
        (station) => onRun(station) && (station.type === 'guide' || station.type === 'anchor'),
      )
      .map((station) => station.arc - riser.startArc)
      .sort((a, b) => a - b);
    const clamps = stations.filter(
      (station) => onRun(station) && (station.type === 'shoe' || station.type === 'anchor'),
    );
    const carried = [
      riser.startArc <= 1 && carriers[0] !== null,
      riser.endArc >= run.lengthMm - 1 && carriers[1] !== null,
    ] as const;
    const { length } = riser;
    const stretch = [...(carried[0] ? [0] : []), ...lateral, ...(carried[1] ? [length] : [])];
    const largest = stretch.reduce(
      (best, position, index) => Math.max(best, position - (stretch[index - 1] ?? position)),
      0,
    );
    const overhangLimit = allowedMm * overhangRatio;
    const free: [number | null, number | null] = [
      carried[0] ? null : (lateral[0] ?? length),
      carried[1] ? null : length - (lateral.at(-1) ?? 0),
    ];
    const issues: string[] = [];
    const label = `riser z ${shown(riser.from[2])} → ${shown(riser.to[2])} m (${shown(length)} m)`;
    if (largest > allowedMm + EPSILON) {
      issues.push(
        `${label}: lateral guide spacing ${shown(largest)} m exceeds ${shown(allowedMm)} m allowed`,
      );
    }
    if (lateral.length === 0 && free.every((value) => value !== null)) {
      if (length > overhangLimit + EPSILON) {
        issues.push(
          `${label}: no lateral guide (an unguided riser between two elbows may be ${shown(overhangLimit)} m at most): add_pipe_support type "guide" on it`,
        );
      }
    } else {
      for (const [end, overhang] of [
        ['start', free[0]],
        ['end', free[1]],
      ] as const) {
        if (overhang !== null && overhang > overhangLimit + EPSILON) {
          issues.push(
            `${label}: ${end} elbow is ${shown(overhang)} m from the nearest lateral guide (max ${shown(overhangLimit)} m = ${overhangRatio} × allowed spacing)`,
          );
        }
      }
    }
    const elbowSupported = stations.some(
      (station) =>
        station.attached &&
        !station.onRiser &&
        (Math.abs(station.arc - riser.startArc) <= overhangLimit + EPSILON ||
          Math.abs(station.arc - riser.endArc) <= overhangLimit + EPSILON),
    );
    const weightBy: RiserRow['weightBy'] =
      carried[0] || carried[1]
        ? 'carried end'
        : clamps.length > 0
          ? 'clamp'
          : elbowSupported
            ? 'elbow support'
            : null;
    const weightKn = (pipeWeightPerMetre(run.diameterMm, WATER_DENSITY) * length) / 1000;
    if (weightBy === null) {
      issues.push(
        `${label}: its ${weightKn.toFixed(1)} kN weight is carried by nothing (add a shoe or anchor clamp on the riser, a support within ${shown(overhangLimit)} m of an elbow, or end it in equipment)`,
      );
    }
    return {
      fromZM: metres(riser.from[2]),
      toZM: metres(riser.to[2]),
      lengthM: metres(length),
      guides: lateral.length,
      maxGuideSpacingM: metres(
        Math.max(largest, ...free.map((value) => (value === null ? 0 : value))),
      ),
      allowedSpacingM: metres(allowedMm),
      weightKn: round(weightKn, 2),
      weightBy,
      ok: issues.length === 0,
      issues,
    };
  });
}
