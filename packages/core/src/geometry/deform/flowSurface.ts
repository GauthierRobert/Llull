/**
 * Flow of a body from a base plane onto a surface (01 DEF §5.4): the base point (x, y, w) goes to S(a*, b*) + w N(a*, b*), where x and y are ARC LENGTHS
 * on the target: x along the iso-curve through the target origin, y along the perpendicular iso-curve at the foot of x (iso-parameter arc length), and w
 * is the offset along the unit normal N. On a cylinder of radius R this is (x, y, w) -> ((R + w) sin(x / R), y, (R + w) cos(x / R) - R), det J = (R + w) / R.
 *
 * The map is sampled once, on a regular (x, y) grid, into a table of P and N stored in the law (so the TypeScript map, the mesh path and the native
 * exact warp evaluate the same function): bicubic Catmull-Rom on P and N, N renormalised; outside the table the coordinates are clamped.
 * @invariant a flow onto the target keeps lengths along both iso-curves at the target origin; folds where w < -(radius of curvature) on the inside
 */

import type { DeformLaw } from '../../model/deform';
import type { Vec3 } from '../../model/vectors';
import { cross3, dot3, len3, normalize3, scale3 } from '../../lib/vec3';
import { surfaceDerivatives, surfaceDomain } from '../../lib/nurbs/surface';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';

export type FlowSurfaceLaw = Extract<DeformLaw, { kind: 'flowSurface' }>;

/** Numbers per table node: P and N. */
const STRIDE = 6;

/** Largest table side (nodes). */
const MAX_FLOW_SURFACE_NODES = 257;

const weights = (t: number): readonly [number, number, number, number] => [
  -0.5 * t * t * t + t * t - 0.5 * t,
  1.5 * t * t * t - 2.5 * t * t + 1,
  -1.5 * t * t * t + 2 * t * t + 0.5 * t,
  0.5 * t * t * t - 0.5 * t * t,
];

/** P and N at the base coordinates (x, y) (clamped to the table). */
function sampleAt(law: FlowSurfaceLaw, x: number, y: number): { point: Vec3; normal: Vec3 } {
  const fx = Math.min(Math.max((x - law.x0) / law.hx, 0), law.nx - 1);
  const fy = Math.min(Math.max((y - law.y0) / law.hy, 0), law.ny - 1);
  const i = Math.min(Math.floor(fx), law.nx - 2);
  const j = Math.min(Math.floor(fy), law.ny - 2);
  const wx = weights(fx - i);
  const wy = weights(fy - j);
  const out = [0, 0, 0, 0, 0, 0];
  for (let a = 0; a < 4; a++) {
    const row = Math.min(Math.max(i - 1 + a, 0), law.nx - 1);
    for (let b = 0; b < 4; b++) {
      const column = Math.min(Math.max(j - 1 + b, 0), law.ny - 1);
      const weight = (wx[a] as number) * (wy[b] as number);
      const at = (row * law.ny + column) * STRIDE;
      for (let c = 0; c < STRIDE; c++) out[c] = (out[c] as number) + weight * (law.nodes[at + c] as number);
    }
  }
  return {
    point: [out[0] as number, out[1] as number, out[2] as number],
    normal: normalize3([out[3] as number, out[4] as number, out[5] as number]),
  };
}

/** The image of local point `q`. */
export function flowSurfaceMap(law: FlowSurfaceLaw, q: Vec3): Vec3 {
  const { point, normal } = sampleAt(law, q[0], q[1]);
  return [point[0] + q[2] * normal[0], point[1] + q[2] * normal[1], point[2] + q[2] * normal[2]];
}

/** det J of the flow at `q`, by central differences of the map (the table is only C1). */
export function flowSurfaceDeterminant(law: FlowSurfaceLaw, q: Vec3): number {
  const h = 1e-5 * Math.max(law.hx, law.hy);
  const column = (axis: 0 | 1 | 2): Vec3 => {
    const plus: [number, number, number] = [q[0], q[1], q[2]];
    const minus: [number, number, number] = [q[0], q[1], q[2]];
    plus[axis] += h;
    minus[axis] -= h;
    const [a, b] = [flowSurfaceMap(law, plus), flowSurfaceMap(law, minus)];
    return [(a[0] - b[0]) / (2 * h), (a[1] - b[1]) / (2 * h), (a[2] - b[2]) / (2 * h)];
  };
  return dot3(column(0), cross3(column(1), column(2)));
}

export interface FlowSurfaceOptions {
  /** The target sheet in world coordinates. */
  readonly surface: NurbsSurfaceData;
  /** Parameters of the target origin. */
  readonly origin: readonly [number, number];
  /** Parameter direction the base x axis runs along on the target. */
  readonly xAlong: 'u' | 'v';
  /** +1 / -1: whether growing x means growing or shrinking that parameter / the other one (y). */
  readonly signX: 1 | -1;
  readonly signY: 1 | -1;
  /** The unit normal side (+1: S_u x S_v, -1: the opposite). */
  readonly normalSign: 1 | -1;
  /** Base rectangle the table must cover (document units). */
  readonly xRange: readonly [number, number];
  readonly yRange: readonly [number, number];
  /** Largest offset |w| of the body (document units): the normal error is scaled by it in the tolerance. */
  readonly offset: number;
  readonly tolerance: number;
}

export type FlowSurfaceFailure = 'OUTSIDE' | 'OVERLAP' | 'DEGENERATE';

const same = (a: Vec3, b: Vec3): boolean => len3([a[0] - b[0], a[1] - b[1], a[2] - b[2]]) < 1e-9 * (1 + len3(a));

/** Whether the patch closes along u (first and last pole rows coincide) or v. */
function isClosed(surface: NurbsSurfaceData, direction: 'u' | 'v'): boolean {
  const rows = surface.poles;
  if (direction === 'u')
    return (rows[0] as ReadonlyArray<Vec3>).every((pole, j) => same(pole, (rows[rows.length - 1] as ReadonlyArray<Vec3>)[j] as Vec3));
  return rows.every((row) => same(row[0] as Vec3, row[row.length - 1] as Vec3));
}

/** Arc-length tables of an iso-curve: parameters from `from` for `span` (wrapped into the domain when closed) with the cumulative length. */
function cumulative(speed: (t: number) => number, from: number, span: number, samples: number): { t: number[]; s: number[] } {
  const t: number[] = [];
  const s: number[] = [0];
  for (let k = 0; k <= samples; k++) t.push(from + (span * k) / samples);
  for (let k = 0; k < samples; k++) {
    const [a, b] = [t[k] as number, t[k + 1] as number];
    s.push((s[k] as number) + ((b - a) / 6) * (speed(a) + 4 * speed((a + b) / 2) + speed(b)));
  }
  return { t, s };
}

/** Cumulative arc length of `table` at parameter `parameter` (inside its range). */
function arcOf(table: { t: number[]; s: number[] }, parameter: number): number {
  let lo = 0;
  let hi = table.t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((table.t[mid] as number) <= parameter) lo = mid;
    else hi = mid;
  }
  const [t0, t1] = [table.t[lo] as number, table.t[hi] as number];
  return (table.s[lo] as number) + (((table.s[hi] as number) - (table.s[lo] as number)) * (parameter - t0)) / (t1 - t0);
}

/** The parameter at signed arc length `length` from the table start (null when it lies beyond the table). */
function invert(table: { t: number[]; s: number[] }, length: number, speed: (t: number) => number): number | null {
  const total = table.s[table.s.length - 1] as number;
  if (length < -1e-9 || length > total + 1e-9) return null;
  const target = Math.min(Math.max(length, 0), total);
  let lo = 0;
  let hi = table.s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((table.s[mid] as number) <= target) lo = mid;
    else hi = mid;
  }
  const [s0, s1, t0, t1] = [table.s[lo] as number, table.s[hi] as number, table.t[lo] as number, table.t[hi] as number];
  let t = s1 === s0 ? t0 : t0 + ((t1 - t0) * (target - s0)) / (s1 - s0);
  for (let i = 0; i < 2; i++) {
    const rate = speed(t);
    if (rate === 0) break;
    const mid = (t0 + t) / 2;
    const arc = s0 + ((t - t0) / 6) * (speed(t0) + 4 * speed(mid) + rate);
    t = Math.min(Math.max(t + (target - arc) / rate, t0), t1);
  }
  return t;
}

/** The exact (not tabulated) map of a target, for building and checking the table. */
class Target {
  readonly domain: readonly [readonly [number, number], readonly [number, number]];
  readonly closedU: boolean;
  readonly closedV: boolean;
  /** Parameters of the origin along x (a) and across (b). */
  private readonly a0: number;
  private readonly b0: number;
  private readonly xTable: { t: number[]; s: number[] };
  private readonly xSpeed: (t: number) => number;
  /** Arc length from the start of the x table to the origin, and the length of one period of a closed x direction (else null). */
  private readonly originLength: number;
  readonly period: number | null;

  constructor(readonly options: FlowSurfaceOptions) {
    const { surface, xAlong, origin } = options;
    this.domain = surfaceDomain(surface);
    this.closedU = isClosed(surface, 'u');
    this.closedV = isClosed(surface, 'v');
    this.a0 = xAlong === 'u' ? origin[0] : origin[1];
    this.b0 = xAlong === 'u' ? origin[1] : origin[0];
    this.xSpeed = (t) => this.speedA(t, this.b0);
    const [lo, hi] = xAlong === 'u' ? this.domain[0] : this.domain[1];
    const closed = xAlong === 'u' ? this.closedU : this.closedV;
    // a closed direction is tabulated over two periods centred on the origin (parameters wrap), so x reaches a full period either way, an open one over its domain
    this.xTable = closed ? cumulative(this.xSpeed, this.a0 - (hi - lo), 2 * (hi - lo), 4096) : cumulative(this.xSpeed, lo, hi - lo, 2048);
    this.originLength = arcOf(this.xTable, this.a0);
    this.period = closed ? (this.xTable.s[this.xTable.s.length - 1] as number) / 2 : null;
  }

  private derivatives(u: number, v: number): { su: Vec3; sv: Vec3; point: Vec3 } {
    const [[u0, u1], [v0, v1]] = this.domain;
    const wrap = (value: number, lo: number, hi: number, closed: boolean): number =>
      closed ? lo + ((((value - lo) % (hi - lo)) + (hi - lo)) % (hi - lo)) : Math.min(hi, Math.max(lo, value));
    const d = surfaceDerivatives(this.options.surface, wrap(u, u0, u1, this.closedU), wrap(v, v0, v1, this.closedV), 1);
    return { point: (d[0] as Vec3[])[0] as Vec3, su: (d[1] as Vec3[])[0] as Vec3, sv: (d[0] as Vec3[])[1] as Vec3 };
  }

  private speedA(a: number, b: number): number {
    const { su, sv } = this.options.xAlong === 'u' ? this.derivatives(a, b) : this.derivatives(b, a);
    return len3(this.options.xAlong === 'u' ? su : sv);
  }

  /** Parameter a* at signed arc length x from the target origin along the x iso-curve; null beyond a non-closed direction. */
  parameterOfX(x: number): number | null {
    return invert(this.xTable, this.originLength + this.options.signX * x, this.xSpeed);
  }

  /**
   * The column of the target at arc length x: the foot parameter a* (null beyond an open target) and the arc-length table of the perpendicular iso-curve,
   * built once so every y of the column is a lookup.
   */
  column(x: number): Column | null {
    const a = this.parameterOfX(x);
    if (a === null) return null;
    const { options } = this;
    const closed = options.xAlong === 'u' ? this.closedV : this.closedU;
    const [lo, hi] = options.xAlong === 'u' ? this.domain[1] : this.domain[0];
    const speed = (t: number): number => {
      const { su, sv } = options.xAlong === 'u' ? this.derivatives(a, t) : this.derivatives(t, a);
      return len3(options.xAlong === 'u' ? sv : su);
    };
    const table = closed ? cumulative(speed, this.b0 - (hi - lo), 2 * (hi - lo), 1024) : cumulative(speed, lo, hi - lo, 512);
    const origin = arcOf(table, this.b0);
    return {
      at: (y) => {
        const b = invert(table, origin + options.signY * y, speed);
        if (b === null) return 'OUTSIDE';
        const [u, v] = options.xAlong === 'u' ? [a, b] : [b, a];
        const { point, su, sv } = this.derivatives(u, v);
        const raw = cross3(su, sv);
        if (len3(raw) === 0) return 'DEGENERATE';
        return { point, normal: scale3(normalize3(raw), options.normalSign) };
      },
    };
  }
}

/** The target along one x: P and N for any y. */
interface Column {
  at(y: number): { point: Vec3; normal: Vec3 } | FlowSurfaceFailure;
}

/**
 * The table of the flow of the rectangle `xRange` x `yRange` (plus a margin of two steps) onto the target, refined until its checked error is within the tolerance.
 * @failure the rectangle leaves a non-closed target -> 'OUTSIDE'; it wraps further than a closed target's period -> 'OVERLAP'; a degenerate normal -> 'DEGENERATE'
 */
export function buildFlowSurface(options: FlowSurfaceOptions): FlowSurfaceLaw | FlowSurfaceFailure {
  const target = new Target(options);
  const { xRange, yRange } = options;
  if (target.period !== null && xRange[1] - xRange[0] > target.period) return 'OVERLAP';
  const columns = new Map<number, Column | null>();
  const columnAt = (x: number): Column | null => {
    if (!columns.has(x)) columns.set(x, target.column(x));
    return columns.get(x) ?? null;
  };
  const clamp = (value: number, range: readonly [number, number]): number => Math.min(Math.max(value, range[0]), range[1]);
  type Sample = { point: Vec3; normal: Vec3 };
  const valueAt = (x: number, y: number): Sample | FlowSurfaceFailure => columnAt(x)?.at(y) ?? 'OUTSIDE';
  /** A node of the table: on the target, else extrapolated linearly from the rectangle edge (margin nodes only; the body never reaches them). */
  const node = (x: number, y: number, hx: number, hy: number): Sample | FlowSurfaceFailure => {
    const direct = valueAt(x, y);
    if (direct !== 'OUTSIDE') return direct;
    const [cx, cy] = [clamp(x, xRange), clamp(y, yRange)];
    const base = valueAt(cx, cy);
    if (typeof base === 'string') return base;
    const [stepX, stepY] = [(cx === xRange[0] ? 0.5 : -0.5) * hx, (cy === yRange[0] ? 0.5 : -0.5) * hy];
    const [probeX, probeY] = [valueAt(cx + stepX, cy), valueAt(cx, cy + stepY)];
    const slope =
      (probe: Sample | FlowSurfaceFailure, step: number, offset: number): ((read: (sample: Sample) => Vec3) => Vec3) =>
      (read) => {
        if (typeof probe === 'string' || offset === 0) return [0, 0, 0];
        const [near, far] = [read(base), read(probe)];
        return [((far[0] - near[0]) * offset) / step, ((far[1] - near[1]) * offset) / step, ((far[2] - near[2]) * offset) / step];
      };
    const [alongX, alongY] = [slope(probeX, stepX, x - cx), slope(probeY, stepY, y - cy)];
    const extend = (read: (sample: Sample) => Vec3): Vec3 => {
      const [from, dx, dy] = [read(base), alongX(read), alongY(read)];
      return [from[0] + dx[0] + dy[0], from[1] + dx[1] + dy[1], from[2] + dx[2] + dy[2]];
    };
    return { point: extend((sample) => sample.point), normal: normalize3(extend((sample) => sample.normal)) };
  };
  let nx = 17;
  let ny = 9;
  for (;;) {
    const hx = (xRange[1] - xRange[0]) / (nx - 5);
    const hy = (yRange[1] - yRange[0]) / (ny - 5);
    const x0 = xRange[0] - 2 * hx;
    const y0 = yRange[0] - 2 * hy;
    const nodes: number[] = [];
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        const sample = node(x0 + i * hx, y0 + j * hy, hx, hy);
        if (typeof sample === 'string') return sample;
        nodes.push(...sample.point, ...sample.normal);
      }
    const law: FlowSurfaceLaw = { kind: 'flowSurface', x0, y0, hx, hy, nx, ny, nodes };
    let worst = 0;
    for (let i = 2; i < nx - 3; i++)
      for (let j = 2; j < ny - 3; j++)
        for (const [fx, fy] of [
          [0.5, 0.5],
          [0.5, 0],
          [0, 0.5],
        ] as const) {
          const x = x0 + (i + fx) * hx;
          const y = y0 + (j + fy) * hy;
          const exact = columnAt(x)?.at(y);
          if (exact === undefined) return 'OUTSIDE';
          if (typeof exact === 'string') return exact;
          const mapped = flowSurfaceMap(law, [x, y, options.offset]);
          const direct: Vec3 = [
            exact.point[0] + options.offset * exact.normal[0],
            exact.point[1] + options.offset * exact.normal[1],
            exact.point[2] + options.offset * exact.normal[2],
          ];
          worst = Math.max(worst, len3([mapped[0] - direct[0], mapped[1] - direct[1], mapped[2] - direct[2]]));
        }
    if (worst <= options.tolerance / 4 || (nx >= MAX_FLOW_SURFACE_NODES && ny >= MAX_FLOW_SURFACE_NODES)) return law;
    nx = Math.min(MAX_FLOW_SURFACE_NODES, 2 * (nx - 5) + 5);
    ny = Math.min(MAX_FLOW_SURFACE_NODES, 2 * (ny - 5) + 5);
  }
}
