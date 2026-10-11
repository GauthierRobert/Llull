/**
 * Simply supported beam under piecewise-uniform line loads and point loads: reactions, exact
 * maximum moment and shear, mid-span deflection by double integration of the exact moment diagram.
 * Units: positions m, line loads kN/m, point loads kN, moments kNm, deflection mm.
 * @layer domain-aec
 * @pure
 */

/** A uniform load `from`–`to` (m from the start), split into permanent and imposed parts. */
export interface LinePiece {
  readonly from: number;
  readonly to: number;
  readonly permanent: number;
  readonly imposed: number;
}

export interface PointLoad {
  readonly at: number;
  readonly permanent: number;
  readonly imposed: number;
}

export interface LoadFactors {
  readonly permanent: number;
  readonly imposed: number;
}

export interface BeamResponse {
  readonly reactionStart: number;
  readonly reactionEnd: number;
  readonly maxMoment: number;
  /** Position of the maximum moment, m. */
  readonly momentAt: number;
  /** Larger shear magnitude at the section of the maximum moment, kN. */
  readonly shearAtMoment: number;
  readonly maxShear: number;
  /** Total factored load, kN. */
  readonly totalLoad: number;
  /** Maximum downward deflection, mm (0 when no flexural rigidity is given). */
  readonly deflection: number;
}

const EPSILON = 1e-9;
const MESH = 400;

/** Total permanent and imposed load (kN) of a load set. */
export function loadTotals(
  pieces: ReadonlyArray<LinePiece>,
  points: ReadonlyArray<PointLoad>,
): { permanent: number; imposed: number } {
  let permanent = 0;
  let imposed = 0;
  for (const piece of pieces) {
    permanent += piece.permanent * (piece.to - piece.from);
    imposed += piece.imposed * (piece.to - piece.from);
  }
  for (const point of points) {
    permanent += point.permanent;
    imposed += point.imposed;
  }
  return { permanent, imposed };
}

interface Line {
  readonly from: number;
  readonly to: number;
  readonly q: number;
}

interface Point {
  readonly at: number;
  readonly force: number;
}

/** Deflection (mm, downward positive) from the moment diagram M(x) given by interval data. */
function deflectionOf(
  length: number,
  stations: ReadonlyArray<{ x: number; moment: number; shear: number; q: number }>,
  flexuralRigidity: number,
): number {
  const xs: number[] = [];
  const curvature: number[] = [];
  stations.forEach((station, index) => {
    const next = stations[index + 1];
    const end = next?.x ?? length;
    const span = end - station.x;
    if (!(span > EPSILON)) return;
    const steps = Math.max(1, Math.ceil((span / length) * MESH));
    for (let step = 0; step < steps; step++) {
      const local = (span * step) / steps;
      const moment = station.moment + station.shear * local - (station.q * local * local) / 2;
      xs.push(station.x + local);
      curvature.push(-moment / flexuralRigidity);
    }
  });
  xs.push(length);
  curvature.push(0);
  const slope: number[] = [0];
  const sag: number[] = [0];
  for (let i = 1; i < xs.length; i++) {
    const dx = (xs[i] as number) - (xs[i - 1] as number);
    slope.push(
      (slope[i - 1] as number) +
        (((curvature[i] as number) + (curvature[i - 1] as number)) / 2) * dx,
    );
    sag.push((sag[i - 1] as number) + (((slope[i] as number) + (slope[i - 1] as number)) / 2) * dx);
  }
  const initialSlope = -(sag[sag.length - 1] as number) / length;
  let maximum = 0;
  xs.forEach((x, index) => {
    maximum = Math.max(maximum, initialSlope * x + (sag[index] as number));
  });
  return maximum * 1000;
}

/**
 * @invariant loads act downward; supports at 0 and `length`; factors scale permanent / imposed parts
 * @param flexuralRigidity E·I in kNm² (0 = skip the deflection)
 */
export function analyseSimpleBeam(
  length: number,
  pieces: ReadonlyArray<LinePiece>,
  points: ReadonlyArray<PointLoad>,
  factors: LoadFactors,
  flexuralRigidity = 0,
): BeamResponse {
  const clamp = (value: number): number => Math.min(length, Math.max(0, value));
  const lines: Line[] = pieces
    .map((piece) => ({
      from: clamp(piece.from),
      to: clamp(piece.to),
      q: factors.permanent * piece.permanent + factors.imposed * piece.imposed,
    }))
    .filter((line) => line.to - line.from > EPSILON && line.q !== 0);
  const concentrated: Point[] = points
    .map((point) => ({
      at: clamp(point.at),
      force: factors.permanent * point.permanent + factors.imposed * point.imposed,
    }))
    .filter((point) => point.force !== 0);
  let totalLoad = 0;
  let firstMoment = 0;
  for (const line of lines) {
    const resultant = line.q * (line.to - line.from);
    totalLoad += resultant;
    firstMoment += (resultant * (line.from + line.to)) / 2;
  }
  for (const point of concentrated) {
    totalLoad += point.force;
    firstMoment += point.force * point.at;
  }
  const reactionEnd = firstMoment / length;
  const reactionStart = totalLoad - reactionEnd;
  const breakpoints = [
    0,
    length,
    ...lines.flatMap((line) => [line.from, line.to]),
    ...concentrated.map((point) => point.at),
  ]
    .sort((a, b) => a - b)
    .filter((x, index, all) => index === 0 || x - (all[index - 1] as number) > EPSILON);
  const pointsAt = (x: number): number =>
    concentrated.reduce(
      (sum, point) => (Math.abs(point.at - x) <= EPSILON ? sum + point.force : sum),
      0,
    );
  let shear = reactionStart - pointsAt(0);
  let moment = 0;
  let maxMoment = 0;
  let momentAt = 0;
  let shearAtMoment = Math.abs(reactionStart);
  let maxShear = Math.abs(reactionStart);
  const stations: { x: number; moment: number; shear: number; q: number }[] = [];
  for (let k = 0; k < breakpoints.length - 1; k++) {
    const x = breakpoints[k] as number;
    const span = (breakpoints[k + 1] as number) - x;
    const middle = x + span / 2;
    const q = lines.reduce(
      (sum, line) => (line.from <= middle && middle <= line.to ? sum + line.q : sum),
      0,
    );
    stations.push({ x, moment, shear, q });
    if (moment > maxMoment) {
      maxMoment = moment;
      momentAt = x;
      shearAtMoment = Math.max(Math.abs(shear), Math.abs(shear + pointsAt(x)));
    }
    if (q > 0 && shear > 0 && shear / q < span) {
      const peak = moment + (shear * shear) / (2 * q);
      if (peak > maxMoment) {
        maxMoment = peak;
        momentAt = x + shear / q;
        shearAtMoment = 0;
      }
    }
    moment += shear * span - (q * span * span) / 2;
    const before = shear - q * span;
    maxShear = Math.max(maxShear, Math.abs(shear), Math.abs(before));
    shear = before - pointsAt(breakpoints[k + 1] as number);
  }
  maxShear = Math.max(maxShear, Math.abs(reactionEnd));
  return {
    reactionStart,
    reactionEnd,
    maxMoment,
    momentAt,
    shearAtMoment,
    maxShear,
    totalLoad,
    deflection: flexuralRigidity > 0 ? deflectionOf(length, stations, flexuralRigidity) : 0,
  };
}
