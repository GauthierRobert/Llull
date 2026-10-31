/**
 * A CPU twin of the marching loop of the preview's fragment shader (`fragmentShader` in `gpuProgram.ts`), with the same policy and constants: distances in
 * document units (d = f * stepScale is a lower bound of the distance to the surface), a hit is d < eps, a step is d, a march that ran out of steps within
 * ACCEPT_FACTOR footprints counts, a hit is refined by REFINE_STEPS bisections between the last point outside and itself. The shader text tests pin the
 * same statements, so the twin and the shader cannot drift apart silently.
 */

import { ACCEPT_FACTOR, MAX_MARCH_STEPS, REFINE_STEPS } from '@ui/viewport/3d/implicitPreview/gpuProgram';

export interface TraceSetup {
  readonly stepScale: number;
  /** The cap of a step (document units); absent = none. */
  readonly maxStep?: number | undefined;
  /** World size of a pixel per unit of distance (perspective) and the floor of the footprint. */
  readonly pixel: number;
  readonly minEps: number;
}

export interface TraceResult {
  readonly hit: boolean;
  readonly t: number;
  readonly steps: number;
  /** Steps that jumped over a wall: some point of the step is inside the solid and its end is outside again. */
  readonly crossings: number;
}

type Vec = readonly [number, number, number];

const at = (o: Vec, d: Vec, t: number): Vec => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];

export function trace(field: (p: Vec) => number, origin: Vec, direction: Vec, tNear: number, tFar: number, setup: TraceSetup): TraceResult {
  let t = Math.max(tNear, 0);
  let tOut = t;
  let hit = false;
  let d = 1e30;
  let eps = setup.minEps;
  let crossings = 0;
  let steps = 0;
  for (; steps < MAX_MARCH_STEPS; steps++) {
    eps = setup.pixel * t + setup.minEps;
    const f = field(at(origin, direction, t));
    d = f * setup.stepScale;
    if (d < eps) {
      hit = true;
      break;
    }
    tOut = t;
    const step = Math.min(d, setup.maxStep ?? 1e30);
    let inside = false;
    for (let k = 1; k <= 64; k++) inside = inside || field(at(origin, direction, t + (step * k) / 65)) < 0;
    // stepping INTO the solid is a hit on the next iteration; a crossing is a step that enters the solid and leaves it again
    if (inside && field(at(origin, direction, t + step)) > 0) crossings++;
    t += step;
    if (t > tFar) break;
  }
  if (!hit && d < ACCEPT_FACTOR * eps && t <= tFar) hit = true;
  if (!hit) return { hit, t, steps, crossings };
  let lower = tOut;
  let upper = t;
  for (let i = 0; i < REFINE_STEPS; i++) {
    const mid = 0.5 * (lower + upper);
    if (field(at(origin, direction, mid)) > 0) lower = mid;
    else upper = mid;
  }
  return { hit, t: upper, steps, crossings };
}
