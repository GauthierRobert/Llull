/**
 * Design-speed checks for a road alignment: minimum horizontal radius and minimum vertical curve K
 * (crest / sag), from simple AASHTO-style tables.
 * Assumptions: R = V^2 / (127 (e + f)) with superelevation e = 0.07 and the side-friction f below;
 * K = stopping-sight-distance based minimum for the next table speed >= the design speed; a grade
 * change above 0.5 % needs a vertical curve.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { AlignmentObject } from '@core/model/civil';
import { horizontalElements } from './alignmentGeometry';
import { validateProfile, verticalCurves } from './profileGeometry';
import { formatStation } from './model';
import { toMetres } from '../model';

export const MAX_SUPERELEVATION = 0.07;

/** Speed km/h -> [side friction f, minimum crest K, minimum sag K]. */
const SPEED_TABLE: ReadonlyArray<readonly [number, number, number, number]> = [
  [20, 0.18, 1, 3],
  [30, 0.28, 2, 6],
  [40, 0.23, 4, 9],
  [50, 0.19, 7, 13],
  [60, 0.17, 11, 18],
  [70, 0.15, 17, 23],
  [80, 0.14, 26, 30],
  [90, 0.13, 39, 38],
  [100, 0.12, 52, 45],
  [110, 0.11, 74, 55],
  [120, 0.09, 95, 63],
];

function rowFor(speed: number): readonly [number, number, number, number] {
  return (
    SPEED_TABLE.find((row) => row[0] >= speed) ??
    (SPEED_TABLE[SPEED_TABLE.length - 1] as readonly [number, number, number, number])
  );
}

export interface DesignChecks {
  readonly designSpeedKmh: number;
  readonly assumptions: string;
  readonly horizontal: ReadonlyArray<{
    readonly station: string;
    readonly radiusM: number;
    readonly minRadiusM: number;
    readonly ok: boolean;
  }>;
  readonly vertical: ReadonlyArray<{
    readonly station: string;
    readonly kind: string;
    readonly k: number;
    readonly minK: number;
    readonly ok: boolean;
  }>;
  readonly failures: string[];
}

export function designChecks(
  doc: CadDocument,
  alignment: AlignmentObject,
  designSpeedKmh: number,
): DesignChecks {
  const [, friction, crestK, sagK] = rowFor(designSpeedKmh);
  const minRadius = (designSpeedKmh * designSpeedKmh) / (127 * (MAX_SUPERELEVATION + friction));
  const failures: string[] = [];
  const horizontal = horizontalElements(alignment).flatMap((element) => {
    if (element.kind !== 'arc') return [];
    const radiusM = toMetres(doc, element.radius);
    const station = formatStation(toMetres(doc, element.startStation));
    const ok = radiusM >= minRadius - 1e-9;
    if (!ok) {
      failures.push(
        `Horizontal curve at ${station}: R=${radiusM.toFixed(1)} m is below the minimum ${minRadius.toFixed(1)} m for ${designSpeedKmh} km/h.`,
      );
    }
    return [
      {
        station,
        radiusM: Number(radiusM.toFixed(2)),
        minRadiusM: Number(minRadius.toFixed(1)),
        ok,
      },
    ];
  });
  const profileOk = validateProfile(alignment.profile) === null;
  const vertical = (profileOk ? verticalCurves(alignment.profile) : []).map((curve) => {
    const minK = curve.kind === 'crest' ? crestK : sagK;
    const station = formatStation(toMetres(doc, curve.pviStation));
    const ok = curve.k >= minK - 1e-9;
    if (!ok) {
      failures.push(
        `Vertical ${curve.kind} curve at PVI ${station}: K=${curve.k.toFixed(1)} is below the minimum ${minK} for ${designSpeedKmh} km/h.`,
      );
    }
    return { station, kind: curve.kind, k: Number(curve.k.toFixed(2)), minK, ok };
  });
  if (profileOk) {
    alignment.profile.slice(1, -1).forEach((pvi, index) => {
      const before = alignment.profile[index];
      const after = alignment.profile[index + 2];
      if (!before || !after || pvi.curveLength > 0) return;
      const change = Math.abs(
        (after.elevation - pvi.elevation) / (after.station - pvi.station) -
          (pvi.elevation - before.elevation) / (pvi.station - before.station),
      );
      if (change > 0.005) {
        failures.push(
          `Grade break at PVI ${formatStation(toMetres(doc, pvi.station))} changes grade by ${(change * 100).toFixed(2)} % without a vertical curve.`,
        );
      }
    });
  }
  return {
    designSpeedKmh,
    assumptions:
      `Minimum radius R = V^2/(127(e+f)) with e = ${MAX_SUPERELEVATION} and f = ${friction} ` +
      `(table value for ${rowFor(designSpeedKmh)[0]} km/h); minimum K crest ${crestK}, sag ${sagK} ` +
      '(stopping sight distance); grade breaks over 0.5 % need a vertical curve.',
    horizontal,
    vertical,
    failures,
  };
}
