/**
 * Eccentric reducers of an imported line (plant 05 ISO M6c, `import_pcf as route`): the axis offset the file carries through the plan, and the flat side.
 * The RTE keeps its points of intersection on the axis UPSTREAM of an eccentric reducer: the pipe after it runs `e = (OD big - OD small) / 2` toward the flat side
 * and the next turn takes that offset up along its own leg. So a component downstream of the reducer on the same leg is planned at its stored-axis position
 * (position minus the carried offset) and the corner after the leg at the elbow centre minus the offset's component along the next leg.
 * @invariant the flat side is a measurement or an explicit input, never a guess: the offset between the two END-POINTs of the file gives it (reducer: toward the
 *   smaller axis, expander: away from it); a file with both ends on one axis needs `eccentricFlat`
 */

import type { Vec3 } from '@core/model/vectors';
import { dot3, len3, normalize3, scale3, sub3 } from '@lib/vec3';
import { outsideDiameterMm } from '../../../industrial/piping/pipeSizes';
import type { NetworkComponent, NetworkPoint } from '../model';

export type FlatSide = 'top' | 'bottom';

/** The flat side the RTE takes: a measured direction, or `top` / `bottom` (the RTE projects them on the pipe). */
export type PlannedFlat = { readonly direction: Vec3 } | { readonly side: FlatSide };

export interface EccentricStep {
  /** Offset of the downstream axis from the upstream one (zero when the file's ends are on one axis). */
  readonly offset: Vec3;
  readonly flat: PlannedFlat;
}

export const ZERO: Vec3 = [0, 0, 0];
const MIN_OFFSET_MM = 0.1;
/** How far the measured offset may differ from (OD big - OD small) / 2 (mm): the two tabulated ODs of EN 10220 / B36.10M differ by up to 1.5 mm. */
const OFFSET_TOLERANCE_MM = 1.5;
const SIDE_VECTOR: Readonly<Record<FlatSide, Vec3>> = { top: [0, 0, 1], bottom: [0, 0, -1] };

export const isShifted = (shift: Vec3): boolean => len3(shift) > 1e-9;

/** Unit vector along the coordinate axis `delta` points to most. */
function dominantAxis(delta: Vec3): Vec3 {
  const at = [0, 1, 2].reduce((best, k) => (Math.abs(delta[k] as number) > Math.abs(delta[best] as number) ? k : best), 0);
  return [at === 0 ? Math.sign(delta[0]) : 0, at === 1 ? Math.sign(delta[1]) : 0, at === 2 ? Math.sign(delta[2]) : 0];
}

/**
 * Offset and flat side of the eccentric reducer between `entry` and `exit`; `heading` is the stored-axis direction of travel when the run already has length.
 * @failure no offset in the file and no `eccentricFlat` -> a message (code ISO_ROUTE_FLAT_MISSING); `eccentricFlat` against the offset of the file -> a message
 */
export function eccentricStep(
  component: NetworkComponent,
  entry: NetworkPoint,
  exit: NetworkPoint,
  heading: Vec3 | undefined,
  eccentricFlat: FlatSide | undefined,
): EccentricStep | { readonly message: string; readonly code: 'ISO_ROUTE_FLAT_MISSING' | 'ISO_PARAM_INVALID' } {
  const delta = sub3(exit.xyz, entry.xyz);
  const axis = heading ?? dominantAxis(delta);
  const offset = sub3(delta, scale3(axis, dot3(delta, axis)));
  const reducing = exit.boreMm < entry.boreMm;
  if (len3(offset) <= MIN_OFFSET_MM) {
    if (eccentricFlat === undefined)
      return {
        message: `eccentric reducer ${component.id} has both end points on one axis, so the file does not say which side is flat: pass eccentricFlat ("top" or "bottom")`,
        code: 'ISO_ROUTE_FLAT_MISSING',
      };
    return { offset: ZERO, flat: { side: eccentricFlat } };
  }
  const [odEntry, odExit] = [outsideDiameterMm(entry.boreMm), outsideDiameterMm(exit.boreMm)];
  const expected = odEntry === null || odExit === null ? null : Math.abs(odEntry - odExit) / 2;
  if (expected !== null && Math.abs(len3(offset) - expected) > OFFSET_TOLERANCE_MM)
    return {
      message: `eccentric reducer ${component.id}: its end points are ${+len3(offset).toFixed(2)} mm off axis, but DN${entry.boreMm} x DN${exit.boreMm} offsets by (OD big - OD small) / 2 = ${+expected.toFixed(2)} mm (tolerance ${OFFSET_TOLERANCE_MM} mm): the file does not describe an eccentric reducer of these sizes`,
      code: 'ISO_PARAM_INVALID',
    };
  const flat = normalize3(reducing ? offset : scale3(offset, -1));
  if (eccentricFlat !== undefined && dot3(flat, SIDE_VECTOR[eccentricFlat]) < 0.5)
    return {
      message: `eccentricFlat "${eccentricFlat}" disagrees with eccentric reducer ${component.id}, whose end points put the flat side toward [${flat.map((v) => +v.toFixed(3)).join(', ')}]`,
      code: 'ISO_PARAM_INVALID',
    };
  return { offset, flat: { direction: flat } };
}

/** Corner of the stored axes after a leg that carries `shift`: the elbow centre minus the shift's component along the next leg (`next` is its unit direction). */
export const storedCorner = (centre: Vec3, shift: Vec3, next: Vec3): Vec3 => sub3(centre, scale3(next, dot3(shift, next)));
