/**
 * Numeric oracle for the material a rolling-ball fillet adds where a thin cylinder passes through a thick one at right angles (axis z, radius `big`; axis y, radius
 * `small`), by quadrature in tube coordinates around the curve of ball centres c(t) = (small + r) (cos t, ., sin t), y = sqrt((big + r)^2 - x^2): in the plane normal
 * to c the material is {c + rho d(phi) : r <= rho <= hit(phi)} for the directions d between the ones that touch the two cylinders, hit(phi) the first
 * wall along the ray, and dV = (|c'| - w . T') dt dA(w) (T the unit tangent). Independent of any kernel: the tube formula is exact, only the quadrature is numeric.
 */

type Vec = readonly [number, number, number];

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec): Vec => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

/** Smallest positive root of a rho^2 + b rho + c = 0, or Infinity. */
function firstRoot(a: number, b: number, c: number): number {
  const discriminant = b * b - 4 * a * c;
  if (!(a > 0) || discriminant < 0) return Infinity;
  const root = Math.sqrt(discriminant);
  const [low, high] = [(-b - root) / (2 * a), (-b + root) / (2 * a)];
  return low > 0 ? low : high > 0 ? high : Infinity;
}

/** Composite Simpson on [0, 1] with n (even) intervals. */
function simpson(f: (u: number) => number, n: number): number {
  let sum = f(0) + f(1);
  for (let k = 1; k < n; k++) sum += f(k / n) * (k % 2 === 1 ? 4 : 2);
  return sum / (3 * n);
}

export function crossedCylindersFilletVolume(big: number, small: number, r: number): number {
  const [pa, pb] = [big + r, small + r];
  const centre = (t: number): Vec => [pb * Math.cos(t), Math.sqrt(pa * pa - pb * pb * Math.cos(t) ** 2), pb * Math.sin(t)];
  const velocity = (t: number): Vec => {
    const y = centre(t)[1];
    return [-pb * Math.sin(t), (pb * pb * Math.cos(t) * Math.sin(t)) / y, pb * Math.cos(t)];
  };
  const tangent = (t: number): Vec => unit(velocity(t));
  const slice = (t: number): number => {
    const [x, y, z] = centre(t);
    const speed = Math.hypot(...velocity(t));
    const h = 1e-5;
    const rate = scale(sub(tangent(t + h), tangent(t - h)), 1 / (2 * h));
    const [towardA, towardB] = [unit([-x, -y, 0]), unit([-x, 0, -z])];
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(towardA, towardB))));
    const turn = (u: number): Vec => {
      const [wa, wb] = [Math.sin((1 - u) * angle) / Math.sin(angle), Math.sin(u * angle) / Math.sin(angle)];
      return [wa * towardA[0] + wb * towardB[0], wa * towardA[1] + wb * towardB[1], wa * towardA[2] + wb * towardB[2]];
    };
    const wedge = (u: number): number => {
      const d = turn(u);
      const hit = Math.min(
        firstRoot(d[0] * d[0] + d[1] * d[1], 2 * (x * d[0] + y * d[1]), x * x + y * y - big * big),
        firstRoot(d[0] * d[0] + d[2] * d[2], 2 * (x * d[0] + z * d[2]), x * x + z * z - small * small),
      );
      return (speed * (hit * hit - r * r)) / 2 - (dot(d, rate) * (hit ** 3 - r ** 3)) / 3;
    };
    return angle * simpson(wedge, 600);
  };
  // the curve is closed and smooth: the trapezoid rule on a period converges geometrically
  const n = 1600;
  let sum = 0;
  for (let k = 0; k < n; k++) sum += slice((2 * Math.PI * k) / n);
  return 2 * ((2 * Math.PI) / n) * sum;
}
