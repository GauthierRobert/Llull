/**
 * Bounding-volume hierarchy over the axis segments of an explicit strut set (05 IMP §14.9). It only decides which beams are NOT evaluated; every
 * evaluated beam uses the unchanged brute arithmetic, so the result is bit-identical to the loop over all beams (twin: `struts.rs` BVH).
 * @invariant a node is skipped only when a conservative lower bound of the signed distance of every beam under it is strictly greater than the best
 * @invariant the minimum is order independent: a skipped beam is strictly worse than the final best, and ties (including 0 against -0) go to the lowest beam index, as in the brute loop
 */

export interface BvhSegment {
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly length: number;
  readonly ra: number;
  readonly rb: number;
}

export interface StrutBvh {
  /** Lower bound of the distance to every beam (-Infinity when not provable): what a skip decision compares with the best. */
  rootBound(x: number, y: number, z: number, radius: number): number;
  /** Minimum of `distanceOf(i)` over every beam, skipping the beams that provably cannot beat the best. NaN values are never taken (as `d < best`). */
  nearest(x: number, y: number, z: number, radius: number, distanceOf: (index: number) => number): number;
}

/** Below this many beams the plain loop is as fast. */
export const BVH_MIN_SEGMENTS = 32;
const LEAF_SIZE = 4;
const STACK_SIZE = 128;
/** Relative slack on the bound. The brute `rho = sqrt(|p|^2 - s^2)` cancels to an error of about sqrt(8 eps) |p| = 3e-8 |p| near an axis; 1e-6 covers it with a margin. */
const SLACK = 1e-6;
const OVERFLOW = 1e300;

/** Beams the bound proof does not cover (non finite data, a length so small that s = dot / length loses its precision): never skipped. */
function isUnbounded(seg: BvhSegment): boolean {
  const { ax, ay, az, dx, dy, dz, length } = seg;
  return ![ax, ay, az, dx, dy, dz, length].every(Number.isFinite) || (length > 0 && length < 1e-100);
}

export function buildStrutBvh(segments: readonly BvhSegment[]): StrutBvh {
  const lo: number[] = [];
  const hi: number[] = [];
  const reach: number[] = [];
  const unbounded: number[] = [];
  const first: number[] = [];
  const count: number[] = [];
  const right: number[] = [];
  const centroid = segments.map((seg): readonly [number, number, number] => [
    seg.ax + seg.dx / 2,
    seg.ay + seg.dy / 2,
    seg.az + seg.dz / 2,
  ]);
  const order = segments.map((_, index) => index);
  let scale = 0;

  const build = (start: number, end: number): number => {
    const node = first.length;
    first.push(start);
    count.push(0);
    right.push(0);
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let radius = 0;
    let loose = 0;
    for (let k = start; k < end; k += 1) {
      const seg = segments[order[k] as number] as BvhSegment;
      const ends = [seg.ax, seg.ay, seg.az, seg.ax + seg.dx, seg.ay + seg.dy, seg.az + seg.dz];
      for (let axis = 0; axis < 3; axis += 1) {
        box[axis] = Math.min(box[axis] as number, ends[axis] as number, ends[axis + 3] as number);
        box[axis + 3] = Math.max(box[axis + 3] as number, ends[axis] as number, ends[axis + 3] as number);
      }
      radius = Math.max(radius, Math.abs(seg.ra), Math.abs(seg.rb));
      if (isUnbounded(seg)) loose = 1;
    }
    lo.push(box[0] as number, box[1] as number, box[2] as number);
    hi.push(box[3] as number, box[4] as number, box[5] as number);
    reach.push(radius);
    unbounded.push(loose);
    if (end - start <= LEAF_SIZE) {
      count[node] = end - start;
      return node;
    }
    let axis = 0;
    let widest = -1;
    for (let candidate = 0; candidate < 3; candidate += 1) {
      let [low, high] = [Infinity, -Infinity];
      for (let k = start; k < end; k += 1) {
        const c = (centroid[order[k] as number] as readonly number[])[candidate] as number;
        low = Math.min(low, c);
        high = Math.max(high, c);
      }
      if (high - low > widest) [widest, axis] = [high - low, candidate];
    }
    const part = order
      .slice(start, end)
      .sort((p, q) => ((centroid[p] as readonly number[])[axis] as number) - ((centroid[q] as readonly number[])[axis] as number) || p - q);
    part.forEach((value, k) => (order[start + k] = value));
    const middle = (start + end) >> 1;
    build(start, middle);
    right[node] = build(middle, end);
    return node;
  };

  if (segments.length > 0) build(0, segments.length);
  for (const seg of segments)
    scale = Math.max(
      scale,
      Math.abs(seg.ax),
      Math.abs(seg.ay),
      Math.abs(seg.az),
      Math.abs(seg.ax + seg.dx),
      Math.abs(seg.ay + seg.dy),
      Math.abs(seg.az + seg.dz),
    );
  const loA = Float64Array.from(lo);
  const hiA = Float64Array.from(hi);
  const stack = new Int32Array(STACK_SIZE);

  /** Lower bound of the signed distance (computed arithmetic included) of every beam under `node`; -Infinity or NaN means "cannot skip". */
  const bound = (node: number, x: number, y: number, z: number, radius: number, slack: number): number => {
    if (unbounded[node] === 1) return -Infinity;
    const base = node * 3;
    const gx = Math.max((loA[base] as number) - x, x - (hiA[base] as number), 0);
    const gy = Math.max((loA[base + 1] as number) - y, y - (hiA[base + 1] as number), 0);
    const gz = Math.max((loA[base + 2] as number) - z, z - (hiA[base + 2] as number), 0);
    const sum = gx * gx + gy * gy + gz * gz;
    if (!(sum < OVERFLOW)) return -Infinity;
    return Math.sqrt(sum) - (radius >= 0 ? radius : (reach[node] as number)) - slack;
  };

  const slackAt = (x: number, y: number, z: number): number => SLACK * (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) + scale);

  return {
    rootBound: (x, y, z, radius) => (segments.length === 0 ? Infinity : bound(0, x, y, z, radius, slackAt(x, y, z))),
    nearest(x, y, z, radius, distanceOf) {
      let best = Infinity;
      let bestIndex = -1;
      if (segments.length === 0) return best;
      const slack = slackAt(x, y, z);
      let top = 0;
      stack[top++] = 0;
      while (top > 0) {
        const node = stack[--top] as number;
        if (bound(node, x, y, z, radius, slack) > best) continue;
        const n = count[node] as number;
        if (n > 0) {
          const start = first[node] as number;
          for (let k = start; k < start + n; k += 1) {
            const index = order[k] as number;
            const d = distanceOf(index);
            if (d < best || (d === best && index < bestIndex)) [best, bestIndex] = [d, index];
          }
          continue;
        }
        const [left, far] = [node + 1, right[node] as number];
        const [bl, bf] = [bound(left, x, y, z, radius, slack), bound(far, x, y, z, radius, slack)];
        if (bl <= bf) {
          stack[top++] = far;
          stack[top++] = left;
        } else {
          stack[top++] = left;
          stack[top++] = far;
        }
      }
      return best;
    },
  };
}
