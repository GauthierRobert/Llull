/**
 * Axisymmetric nozzle wall contour, throat at axial 0 (Huzel & Huang NASA SP-125 §4.4; Rao 1958 parabolic approximation):
 * conical convergent + upstream throat arc (1.5 R_t), downstream throat arc (0.382 R_t), then a conical or a parabolic (quadratic Bézier) bell.
 */

export interface ContourPoint {
  /** Axial position, throat at 0, flow towards +. */
  readonly axial: number;
  readonly radius: number;
  /** Wall slope angle (rad), dr/dx = tan(angle). */
  readonly angle: number;
}

export interface ContourSpec {
  readonly throatRadius: number;
  readonly expansionRatio: number;
  readonly contractionRatio: number;
  readonly convergentHalfAngle: number;
  readonly chamberLength: number;
  readonly upstreamRadiusFactor: number;
  readonly downstreamRadiusFactor: number;
  readonly divergent:
    | { readonly shape: 'conical'; readonly halfAngle: number }
    | { readonly shape: 'bell'; readonly lengthFraction: number; readonly entranceAngle: number; readonly exitAngle: number };
}

export interface Contour {
  readonly points: readonly ContourPoint[];
  readonly chamberRadius: number;
  readonly exitRadius: number;
  readonly convergentLength: number;
  readonly divergentLength: number;
  /** Length of the 15° reference cone with the same throat arc (the bell length fraction is relative to it). */
  readonly referenceConeLength: number;
}

const ARC_STEPS = 16;
const BELL_STEPS = 48;
const FIFTEEN_DEGREES = (15 * Math.PI) / 180;

/** Length of the 15° half-angle cone from the throat to ε, with the downstream throat arc: (R_t(√ε - 1) + R_d(sec 15° - 1)) / tan 15°. */
export function referenceConeLength(throatRadius: number, expansionRatio: number, downstreamRadius: number): number {
  return (
    (throatRadius * (Math.sqrt(expansionRatio) - 1) + downstreamRadius * (1 / Math.cos(FIFTEEN_DEGREES) - 1)) / Math.tan(FIFTEEN_DEGREES)
  );
}

/** Points of a throat arc of radius `arcRadius` from the throat (φ = 0) to φ = end, on the given side (-1 upstream, +1 downstream). */
function throatArc(throatRadius: number, arcRadius: number, end: number, side: -1 | 1): ContourPoint[] {
  return Array.from({ length: ARC_STEPS + 1 }, (_, step) => {
    const phi = (end * step) / ARC_STEPS;
    return { axial: side * arcRadius * Math.sin(phi), radius: throatRadius + arcRadius * (1 - Math.cos(phi)), angle: side * phi };
  });
}

/**
 * The wall contour from the chamber inlet to the exit.
 * @failure chamber radius below the end of the upstream arc, or bell control point outside the bell span -> string reason
 */
export function nozzleContour(spec: ContourSpec): Contour | string {
  const rt = spec.throatRadius;
  const ru = spec.upstreamRadiusFactor * rt;
  const rd = spec.downstreamRadiusFactor * rt;
  const chamberRadius = rt * Math.sqrt(spec.contractionRatio);
  const exitRadius = rt * Math.sqrt(spec.expansionRatio);
  const upstream = throatArc(rt, ru, spec.convergentHalfAngle, -1);
  const arcStart = upstream[upstream.length - 1] as ContourPoint;
  if (chamberRadius <= arcStart.radius)
    return `contraction ratio ${spec.contractionRatio} gives a chamber radius ${chamberRadius.toPrecision(4)} below the end of the upstream throat arc (${arcStart.radius.toPrecision(4)})`;
  const coneRun = (chamberRadius - arcStart.radius) / Math.tan(spec.convergentHalfAngle);
  const convergentStart = arcStart.axial - coneRun;
  const inlet: ContourPoint[] = [
    ...(spec.chamberLength > 0 ? [{ axial: convergentStart - spec.chamberLength, radius: chamberRadius, angle: 0 }] : []),
    { axial: convergentStart, radius: chamberRadius, angle: -spec.convergentHalfAngle },
  ];
  const convergent = [...inlet, ...[...upstream].reverse()];
  const cone = referenceConeLength(rt, spec.expansionRatio, rd);
  const divergent = spec.divergent;
  if (divergent.shape === 'conical') {
    const arc = throatArc(rt, rd, divergent.halfAngle, 1);
    const last = arc[arc.length - 1] as ContourPoint;
    const run = (exitRadius - last.radius) / Math.tan(divergent.halfAngle);
    const exit = { axial: last.axial + run, radius: exitRadius, angle: divergent.halfAngle };
    return {
      points: [...convergent, ...arc.slice(1), exit],
      chamberRadius,
      exitRadius,
      convergentLength: -convergentStart,
      divergentLength: exit.axial,
      referenceConeLength: cone,
    };
  }
  const arc = throatArc(rt, rd, divergent.entranceAngle, 1);
  const start = arc[arc.length - 1] as ContourPoint;
  const length = divergent.lengthFraction * cone;
  const tn = Math.tan(divergent.entranceAngle);
  const te = Math.tan(divergent.exitAngle);
  const controlAxial = (exitRadius - start.radius + start.axial * tn - length * te) / (tn - te);
  if (!(controlAxial > start.axial && controlAxial < length))
    return `bell angles θn ${((divergent.entranceAngle * 180) / Math.PI).toFixed(1)}° / θe ${((divergent.exitAngle * 180) / Math.PI).toFixed(1)}° do not fit a parabola between the throat arc and the exit at length ${length.toPrecision(4)}`;
  const controlRadius = start.radius + tn * (controlAxial - start.axial);
  const bell = Array.from({ length: BELL_STEPS }, (_, index) => {
    const t = (index + 1) / BELL_STEPS;
    const u = 1 - t;
    const axial = u * u * start.axial + 2 * u * t * controlAxial + t * t * length;
    const radius = u * u * start.radius + 2 * u * t * controlRadius + t * t * exitRadius;
    const dx = 2 * u * (controlAxial - start.axial) + 2 * t * (length - controlAxial);
    const dr = 2 * u * (controlRadius - start.radius) + 2 * t * (exitRadius - controlRadius);
    return { axial, radius, angle: Math.atan2(dr, dx) };
  });
  return {
    points: [...convergent, ...arc.slice(1), ...bell],
    chamberRadius,
    exitRadius,
    convergentLength: -convergentStart,
    divergentLength: length,
    referenceConeLength: cone,
  };
}

/** Closed wall cross-section [radial, axial] for revolve_profile: inner contour forward, outer (normal offset by `thickness`) back. */
export function wallSection(points: readonly ContourPoint[], thickness: number): Array<[number, number]> {
  const inner = points.map((point): [number, number] => [point.radius, point.axial]);
  const outer = points.map((point): [number, number] => [
    point.radius + thickness * Math.cos(point.angle),
    point.axial - thickness * Math.sin(point.angle),
  ]);
  return [...inner, ...outer.reverse()];
}
