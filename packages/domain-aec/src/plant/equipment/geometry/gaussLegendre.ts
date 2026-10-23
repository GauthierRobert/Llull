/** Fixed-node Gauss-Legendre quadrature (deterministic: nodes by Newton iteration on P_n, no tolerance loop that depends on the input). */

interface Rule {
  readonly nodes: readonly number[];
  readonly weights: readonly number[];
}

const cache = new Map<number, Rule>();

function rule(n: number): Rule {
  const hit = cache.get(n);
  if (hit !== undefined) return hit;
  const nodes: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < n; i++) {
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let derivative = 1;
    for (let iteration = 0; iteration < 100; iteration++) {
      let p0 = 1;
      let p1 = x;
      for (let k = 2; k <= n; k++) {
        const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k;
        p0 = p1;
        p1 = p2;
      }
      derivative = (n * (x * p1 - p0)) / (x * x - 1);
      const step = p1 / derivative;
      x -= step;
      if (Math.abs(step) < 1e-16) break;
    }
    nodes.push(x);
    weights.push(2 / ((1 - x * x) * derivative * derivative));
  }
  const built = { nodes, weights };
  cache.set(n, built);
  return built;
}

/** Integral of `f` over [a, b] with the n-point rule. */
export function integrate(f: (x: number) => number, a: number, b: number, n = 64): number {
  const { nodes, weights } = rule(n);
  const half = (b - a) / 2;
  const mid = (a + b) / 2;
  let sum = 0;
  nodes.forEach((node, i) => {
    sum += (weights[i] ?? 0) * f(mid + half * node);
  });
  return sum * half;
}
