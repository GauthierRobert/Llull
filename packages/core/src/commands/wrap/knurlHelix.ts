/**
 * Modeled diagonal and diamond knurl (03 WRP M5, FR-WRP-32): helical V-grooves on a cylindrical face. Each groove is one exact screw sweep (the native helical spine, section in the plane
 * through the axis) of a V whose apex lies `depth` below the surface; the V is defined NORMAL to the groove (the included `toothAngleDeg` of a knurling wheel), which in the plane through
 * the axis has the half-width slope k = tan(gamma) / sin(beta) per unit of depth (gamma half the tooth angle, beta the helix angle from the axis). All grooves of a hand start at equally
 * spaced angles (the tooth count closes round the circumference); a diamond adds the grooves of the other hand. They are united and subtracted in one boolean.
 * @invariant a screw motion keeps the transverse section: one groove removes exactly teeth x length x A_t, A_t = 2 tan(gamma) / (r cos beta) x [(r^3 - (r - h)^3) / 3 - (r - h)(r^2 - (r - h)^2) / 2],
 *   independent of the lead; a diamond removes the union of the two hand families (their overlaps counted once), integrated numerically over the transverse sections
 * @failure a free end cap missing at either end of the face (the sweep overshoots the ends), a cut whose estimated kernel time exceeds the measured envelope (grooves x turns), a helix angle outside (0, 90) -> a named reason
 */

import type { ShapeRecipe, Vec3 } from '../../model/types';
import { curveChain } from '../../geometry/nurbsChain';
import { helixCurve } from '../../lib/helix/helix';
import { newEntity } from '../entity/newEntity';
import { axisFrame } from '../solids/shared';

/**
 * Estimated native kernel time of a cut of `grooves` helical grooves that each turn `turns` times along the face (face length / lead), seconds: grooves x 2.3 x (turns / 0.184)^1.8. Fitted to the
 * measured runs on a face 40 long, radius 20 (0.184 turns at 30 degrees; each groove is a B-spline sweep intersected with the cylinder, and the cost grows with the helix angle, i.e. the turns): 6 grooves at
 * 30 degrees 12.6 s (model 13.8), 12 at 30 degrees 30 s (27.6), 8 at 45 degrees 45 s (49.6), more than 120 s for 8 at 60 degrees with a 60 degree V (133). Accurate to about 10 % on that box.
 */
export function estimatedKernelSeconds(grooves: number, turns: number): number {
  return grooves * 2.3 * (turns / REFERENCE_TURNS) ** 1.8;
}
const REFERENCE_TURNS = 0.184;
/** Longest estimated kernel time one cut may take, seconds: the measured 45 s run (model 49.6) with the model's 10 % error stays under the 60 s limit of one kernel call. */
export const MAX_KERNEL_SECONDS = 50;

/** The axial range the groove sweeps cover (the face plus the V reach at both ends) and the turns of one groove over it. */
export function grooveSpan(
  shape: HelicalKnurl,
  from: number,
  to: number,
): { readonly z0: number; readonly z1: number; readonly turns: number } {
  const top = slope(shape) * (shape.depth + OVERSHOOT * shape.depth);
  const [z0, z1] = [from - top - 0.5 * shape.depth, to + top + 0.5 * shape.depth];
  return { z0, z1, turns: (z1 - z0) / leadOf(shape) };
}
/** The tool rises this fraction of the depth above the surface (a sharp crest would leave the kernel a tangent edge). */
const OVERSHOOT = 0.5;

export interface HelicalKnurl {
  readonly teeth: number;
  readonly radius: number;
  readonly depth: number;
  /** Included angle of the V normal to the groove, degrees. */
  readonly toothAngleDeg: number;
  /** Helix angle from the axis, degrees in (0, 90). */
  readonly helixDeg: number;
  /** One hand (diagonal) or both (diamond). */
  readonly hands: 1 | 2;
  readonly left: boolean;
}

/** Half-width (along the axis) of the V in the plane through the axis, per unit of depth. */
const slope = (shape: HelicalKnurl): number => Math.tan((shape.toothAngleDeg * Math.PI) / 360) / Math.sin((shape.helixDeg * Math.PI) / 180);

/** Axial advance per turn of the groove helix. */
export const leadOf = (shape: HelicalKnurl): number => (2 * Math.PI * shape.radius) / Math.tan((shape.helixDeg * Math.PI) / 180);

/** Area of the transverse section of ONE groove inside the cylinder, closed form (see the module comment). */
export function helicalGrooveArea(shape: HelicalKnurl): number {
  const { radius: r, depth: h } = shape;
  const base = r - h;
  const cosBeta = Math.cos((shape.helixDeg * Math.PI) / 180);
  const gamma = Math.tan((shape.toothAngleDeg * Math.PI) / 360);
  return ((2 * gamma) / (r * cosBeta)) * ((r ** 3 - base ** 3) / 3 - (base * (r * r - base * base)) / 2);
}

/** Land left between adjacent grooves at the surface (circumferential), document units; negative when they overlap. */
export function helicalLand(pitch: number, shape: Pick<HelicalKnurl, 'depth' | 'toothAngleDeg' | 'helixDeg'>): number {
  return pitch - (2 * shape.depth * Math.tan((shape.toothAngleDeg * Math.PI) / 360)) / Math.cos((shape.helixDeg * Math.PI) / 180);
}

/** Depth that leaves a land of `landRatio` x pitch between the grooves of one hand. */
export function helicalDepthForLand(pitch: number, toothAngleDeg: number, helixDeg: number, landRatio: number): number {
  return (pitch * (1 - landRatio) * Math.cos((helixDeg * Math.PI) / 180)) / (2 * Math.tan((toothAngleDeg * Math.PI) / 360));
}

/**
 * Volume removed along an axial length `length`: teeth x length x A_t for one hand, the union of both hands for a diamond (integral over the transverse sections of the removed area
 * between the floor radius of the nearest groove and the surface).
 */
export function helicalRemovedVolume(shape: HelicalKnurl, length: number): number {
  const single = shape.teeth * length * helicalGrooveArea(shape);
  if (shape.hands === 1) return single;
  const { radius: r, depth: h, teeth } = shape;
  const k = slope(shape);
  const lead = leadOf(shape);
  const reach = h * k;
  // the grooves start at the sweep start, a little before the face: the phase of the pattern at the face start
  const lead0 = k * (h + OVERSHOOT * h) + 0.5 * h;
  const sectionArea = (z: number): number => {
    const steps = 360;
    const period = (2 * Math.PI) / teeth;
    let sum = 0;
    for (let s = 0; s < steps; s++) {
      const phi = ((s + 0.5) / steps) * period;
      let floor = r;
      for (const hand of [1, -1]) {
        // axial distance from the point to the nearest groove line of this hand (tooth 0; the other teeth are rotations by the period)
        const along = (z + lead0 - (hand * phi * lead) / (2 * Math.PI)) % (lead / teeth);
        const a = Math.abs(along > lead / (2 * teeth) ? along - lead / teeth : along < -lead / (2 * teeth) ? along + lead / teeth : along);
        if (a <= reach) floor = Math.min(floor, r - h + a / k);
      }
      sum += 0.5 * (r * r - floor * floor) * (period / steps);
    }
    return sum * teeth;
  };
  const stations = 1200;
  let total = 0;
  for (let i = 0; i < stations; i++) total += sectionArea(((i + 0.5) / stations) * length);
  return (total * length) / stations;
}

/**
 * The recipe of `source` with the helical grooves cut, or the reason it cannot be built.
 * @failure degenerate axis, a helix path that cannot be built -> reason string
 */
export function helicalKnurlRecipe(
  source: ShapeRecipe,
  shape: HelicalKnurl,
  cut: { readonly origin: Vec3; readonly axis: Vec3; readonly span: ReturnType<typeof grooveSpan> },
  idPrefix: string,
  color: string,
): ShapeRecipe | string {
  const frame = axisFrame(cut.axis, cut.origin);
  if (typeof frame === 'string') return frame;
  const { radius: r, depth: h } = shape;
  const over = OVERSHOOT * h;
  const k = slope(shape);
  const top = k * (h + over);
  const lead = leadOf(shape);
  const { z0, turns } = cut.span;
  const grooves: ShapeRecipe[] = [];
  const hands = shape.hands === 2 ? [false, true] : [shape.left];
  for (const left of hands)
    for (let i = 0; i < shape.teeth; i++) {
      const theta = (2 * Math.PI * i) / shape.teeth;
      const origin: Vec3 = [-r * Math.cos(theta), -r * Math.sin(theta), 0];
      const definition = {
        type: 'helix' as const,
        origin,
        axis: [0, 0, 1] as Vec3,
        radius: r,
        endRadius: r,
        turns,
        pitch: lead,
        handedness: left ? ('left' as const) : ('right' as const),
        startAngle: theta,
      };
      const path = curveChain(helixCurve(definition, 1e-6 * r).curve);
      if (typeof path === 'string') return `the helix path cannot be built: ${path}`;
      grooves.push({
        op: 'solid',
        entity: newEntity(
          'sweep',
          `${idPrefix}.${left ? 'l' : 'r'}${i}`,
          {
            path,
            helix: definition,
            section: {
              shape: 'profile' as const,
              profile: [
                [-h, 0],
                [over, -top],
                [over, top],
              ] as Array<[number, number]>,
            },
            orientation: { mode: 'axis_plane' as const, axisPoint: origin, direction: [0, 0, 1] as Vec3, sectionFrame: 'path' as const },
          },
          frame.worldAt([r * Math.cos(theta), r * Math.sin(theta), z0]),
          color,
          { rotation: frame.rotation },
        ),
      });
    }
  return { op: 'boolean', boolean: 'subtract', a: source, b: unionOf(grooves) };
}

/** Balanced union of `parts`. */
function unionOf(parts: readonly ShapeRecipe[]): ShapeRecipe {
  if (parts.length === 1) return parts[0] as ShapeRecipe;
  const half = Math.ceil(parts.length / 2);
  return { op: 'boolean', boolean: 'union', a: unionOf(parts.slice(0, half)), b: unionOf(parts.slice(half)) };
}
