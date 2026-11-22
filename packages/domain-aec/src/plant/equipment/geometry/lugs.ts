/** Bracket lugs of a vertical vessel / exchanger (plant 03 EQP §13.10): closed-form volumes, centroid height and plan extent from the caller dimensions. */

import type { LugSupport } from '../plantData';

/** What `check_equipment` states for lugs: no source row exists for a lug check, so none is made. */
export const LUGS_NOT_CHECKED =
  'lug structural checks (local shell stress under the lug load, lug plate and weld stress, base plate bearing and bolting): no source row in validation/sources.md, none is made';

interface LugVolumes {
  readonly webVolume: number;
  readonly baseVolume: number;
  /** Metal volume of ONE lug (the bolt hole is subtracted from the base plate). */
  readonly volume: number;
  /** Height of the centroid of one lug above its bottom face. */
  readonly centreHeight: number;
}

/** Volumes in document units cubed: web = t x projection x (height - base plate); base = (width x projection - pi/4 d^2) x base plate thickness. */
export function lugVolumes(lug: LugSupport): LugVolumes {
  const plate = lug.lugBasePlateThickness;
  const webHeight = lug.lugHeight - plate;
  const webVolume = lug.lugThickness * lug.lugProjection * webHeight;
  const hole = lug.lugBoltHoleDiameter === undefined ? 0 : (Math.PI * lug.lugBoltHoleDiameter ** 2) / 4;
  const baseVolume = (lug.lugWidth * lug.lugProjection - hole) * plate;
  const volume = webVolume + baseVolume;
  const centreHeight = volume > 0 ? (webVolume * (plate + webHeight / 2) + baseVolume * (plate / 2)) / volume : 0;
  return { webVolume, baseVolume, volume, centreHeight };
}

/** Azimuth of lug `index` from plant north, clockwise (the first lug half a step off the north axis). */
export const lugAzimuth = (index: number, count: number): number => ((index + 0.5) * 2 * Math.PI) / count;

/** Largest plan radius of the lugs about the axis (the outer corner of the base plate). */
export const lugPlanRadius = (rootRadius: number, lug: LugSupport): number => Math.hypot(rootRadius + lug.lugProjection, lug.lugWidth / 2);

type LugDimensions = Pick<
  LugSupport,
  'count' | 'lugHeight' | 'lugWidth' | 'lugElevation' | 'lugBasePlateThickness' | 'lugBoltHoleDiameter' | 'lugProjection'
>;

/** Why a lug set does not fit the body, or null. `shell` = heights of the shell ends above the bottom tangent line; `rootRadius` = the shell outside radius. */
export function lugFitProblem(
  lug: LugDimensions,
  shell: { readonly from: number; readonly to: number },
  rootRadius: number,
): { message: string; path: string } | null {
  if (lug.lugBasePlateThickness >= lug.lugHeight)
    return {
      message: `lugBasePlateThickness ${lug.lugBasePlateThickness} must be below lugHeight ${lug.lugHeight} (the web stands on the base plate)`,
      path: 'support.lugBasePlateThickness',
    };
  if (lug.lugElevation < shell.from || lug.lugElevation + lug.lugHeight > shell.to)
    return {
      message: `the lug (elevation ${lug.lugElevation}, height ${lug.lugHeight}) must lie on the shell, ${shell.from}..${shell.to} above the bottom tangent line`,
      path: 'support.lugElevation',
    };
  if (lug.count * lug.lugWidth > 2 * Math.PI * rootRadius)
    return {
      message: `${lug.count} lugs of width ${lug.lugWidth} do not fit the shell circumference ${(2 * Math.PI * rootRadius).toPrecision(6)}`,
      path: 'support.lugWidth',
    };
  if (lug.lugBoltHoleDiameter !== undefined && (lug.lugBoltHoleDiameter >= lug.lugWidth || lug.lugBoltHoleDiameter >= lug.lugProjection))
    return {
      message: `lugBoltHoleDiameter ${lug.lugBoltHoleDiameter} must be below lugWidth ${lug.lugWidth} and lugProjection ${lug.lugProjection}`,
      path: 'support.lugBoltHoleDiameter',
    };
  return null;
}
