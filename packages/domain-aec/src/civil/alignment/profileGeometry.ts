/**
 * Vertical alignment geometry: straight grades between PVIs joined by symmetric parabolic curves.
 * Stations and elevations are in document units; grades are ratios (0.025 = 2.5 %).
 * @layer domain-aec/civil
 * @pure
 */

import type { ProfilePvi } from '@core/model/civil';

export interface VerticalCurve {
  readonly pviIndex: number;
  readonly pviStation: number;
  readonly pviElevation: number;
  readonly length: number;
  readonly startStation: number;
  readonly endStation: number;
  readonly startElevation: number;
  readonly endElevation: number;
  readonly gradeIn: number;
  readonly gradeOut: number;
  /** Algebraic grade difference (gradeOut - gradeIn). */
  readonly gradeChange: number;
  /** Curve length per percent of grade change, L / (|A| in %). */
  readonly k: number;
  readonly kind: 'crest' | 'sag';
  /** Local high point (crest) or low point (sag) inside the curve, when the grade passes zero. */
  readonly turning: { readonly station: number; readonly elevation: number } | null;
}

/** Error text for an unusable profile, or null when it is valid. */
export function validateProfile(profile: ReadonlyArray<ProfilePvi>): string | null {
  if (profile.length < 2) return 'a profile needs at least 2 PVIs.';
  for (const pvi of profile) {
    if (!Number.isFinite(pvi.station) || !Number.isFinite(pvi.elevation))
      return 'PVI stations and elevations must be finite numbers.';
    if (!(pvi.curveLength >= 0) || !Number.isFinite(pvi.curveLength))
      return `PVI at station ${pvi.station}: curveLength must be >= 0.`;
  }
  for (let i = 1; i < profile.length; i++) {
    if (!((profile[i] as ProfilePvi).station > (profile[i - 1] as ProfilePvi).station))
      return `PVI stations must increase strictly (PVI ${i} at ${(profile[i] as ProfilePvi).station}).`;
  }
  if (
    (profile[0] as ProfilePvi).curveLength > 0 ||
    (profile[profile.length - 1] as ProfilePvi).curveLength > 0
  ) {
    return 'the first and last PVI cannot carry a vertical curve.';
  }
  for (let i = 1; i + 1 < profile.length; i++) {
    const here = profile[i] as ProfilePvi;
    const next = profile[i + 1] as ProfilePvi;
    if (here.curveLength / 2 + next.curveLength / 2 > next.station - here.station + 1e-9)
      return `vertical curves at PVI ${i} and PVI ${i + 1} overlap; shorten them.`;
  }
  return null;
}

/** Grade of each segment between consecutive PVIs. */
export function grades(profile: ReadonlyArray<ProfilePvi>): number[] {
  return profile.slice(1).map((pvi, i) => {
    const from = profile[i] as ProfilePvi;
    return (pvi.elevation - from.elevation) / (pvi.station - from.station);
  });
}

/** Every vertical curve (interior PVI with curveLength > 0 and a grade change). */
export function verticalCurves(profile: ReadonlyArray<ProfilePvi>): VerticalCurve[] {
  const segmentGrades = grades(profile);
  const curves: VerticalCurve[] = [];
  for (let i = 1; i + 1 < profile.length; i++) {
    const pvi = profile[i] as ProfilePvi;
    const gradeIn = segmentGrades[i - 1] as number;
    const gradeOut = segmentGrades[i] as number;
    const change = gradeOut - gradeIn;
    if (!(pvi.curveLength > 0) || Math.abs(change) < 1e-12) continue;
    const half = pvi.curveLength / 2;
    const x = (-gradeIn * pvi.curveLength) / change;
    const startElevation = pvi.elevation - gradeIn * half;
    curves.push({
      pviIndex: i,
      pviStation: pvi.station,
      pviElevation: pvi.elevation,
      length: pvi.curveLength,
      startStation: pvi.station - half,
      endStation: pvi.station + half,
      startElevation,
      endElevation: pvi.elevation + gradeOut * half,
      gradeIn,
      gradeOut,
      gradeChange: change,
      k: pvi.curveLength / (Math.abs(change) * 100),
      kind: change < 0 ? 'crest' : 'sag',
      turning:
        x > 0 && x < pvi.curveLength
          ? {
              station: pvi.station - half + x,
              elevation: startElevation + gradeIn * x + (change * x * x) / (2 * pvi.curveLength),
            }
          : null,
    });
  }
  return curves;
}

/** Design elevation at `station`; null outside the first / last PVI. */
export function designElevation(
  profile: ReadonlyArray<ProfilePvi>,
  station: number,
): number | null {
  const first = profile[0];
  const last = profile[profile.length - 1];
  if (!first || !last || station < first.station - 1e-9 || station > last.station + 1e-9)
    return null;
  for (const curve of verticalCurves(profile)) {
    if (station >= curve.startStation && station <= curve.endStation) {
      const x = station - curve.startStation;
      return (
        curve.startElevation + curve.gradeIn * x + (curve.gradeChange * x * x) / (2 * curve.length)
      );
    }
  }
  const segmentGrades = grades(profile);
  let index = profile.findIndex((pvi) => pvi.station >= station) - 1;
  if (index < 0) index = 0;
  const from = profile[index] as ProfilePvi;
  return from.elevation + (segmentGrades[index] as number) * (station - from.station);
}

/** Extra sampling stations on vertical curves (start, end and 8 divisions) so they draw smoothly. */
export function verticalCurveStations(profile: ReadonlyArray<ProfilePvi>): number[] {
  return verticalCurves(profile).flatMap((curve) =>
    Array.from({ length: 9 }, (_, k) => curve.startStation + (curve.length * k) / 8),
  );
}
