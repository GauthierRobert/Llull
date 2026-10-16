/**
 * Method-of-manufactured-solutions fixture (PHY-00 VC-VNV-07): −u'' = π² sin πx on (0, 1), u(0) = u(1) = 0, linear (P1) elements on a
 * uniform mesh with the exact load vector; errors integrated with 5-point Gauss-Legendre per element.
 */

const GAUSS5: readonly (readonly [number, number])[] = (() => {
  const a = Math.sqrt(5 - 2 * Math.sqrt(10 / 7)) / 3;
  const b = Math.sqrt(5 + 2 * Math.sqrt(10 / 7)) / 3;
  const wa = (322 + 13 * Math.sqrt(70)) / 900;
  const wb = (322 - 13 * Math.sqrt(70)) / 900;
  return [
    [0, 128 / 225],
    [a, wa],
    [-a, wa],
    [b, wb],
    [-b, wb],
  ];
})();

function solve(n: number): number[] {
  const h = 1 / n;
  const m = n - 1;
  const diag = 2 / h;
  const off = -1 / h;
  const rhs = Array.from({ length: m }, (_, i) => (2 * Math.sin(Math.PI * (i + 1) * h) * (1 - Math.cos(Math.PI * h))) / h);
  const c = new Array<number>(m).fill(0);
  const d = new Array<number>(m).fill(0);
  c[0] = off / diag;
  d[0] = (rhs[0] ?? 0) / diag;
  for (let i = 1; i < m; i += 1) {
    const den = diag - off * (c[i - 1] ?? 0);
    c[i] = off / den;
    d[i] = ((rhs[i] ?? 0) - off * (d[i - 1] ?? 0)) / den;
  }
  const u = new Array<number>(m).fill(0);
  u[m - 1] = d[m - 1] ?? 0;
  for (let i = m - 2; i >= 0; i -= 1) u[i] = (d[i] ?? 0) - (c[i] ?? 0) * (u[i + 1] ?? 0);
  return [0, ...u, 0];
}

export function mmsErrors(n: number): { n: number; l2: number; h1: number; nodalMax: number } {
  const u = solve(n);
  const h = 1 / n;
  let l2 = 0;
  let h1 = 0;
  let nodalMax = 0;
  u.forEach((value, i) => (nodalMax = Math.max(nodalMax, Math.abs(value - Math.sin(Math.PI * i * h)))));
  for (let e = 0; e < n; e += 1) {
    const xa = e * h;
    const ua = u[e] ?? 0;
    const slope = ((u[e + 1] ?? 0) - ua) / h;
    for (const [xi, w] of GAUSS5) {
      const x = xa + 0.5 * h + 0.5 * h * xi;
      l2 += 0.5 * h * w * (Math.sin(Math.PI * x) - (ua + slope * (x - xa))) ** 2;
      h1 += 0.5 * h * w * (Math.PI * Math.cos(Math.PI * x) - slope) ** 2;
    }
  }
  return { n, l2: Math.sqrt(l2), h1: Math.sqrt(h1), nodalMax };
}
