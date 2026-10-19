/**
 * Euler-Bernoulli clamped-free strip of VC-DYN-21 (docs/physics/09-structural-dynamics/validation/generate_dynamics_reference.py §10):
 * 100 x 20 x 3 mm, E 210000 MPa, rho 7.8e-9 t/mm^3, modes normalised to integral phi^2 dx/L = 1, G_n = integral phi_n d(x/L).
 * Ported formula for formula (bisection roots, Simpson 4000) so the modal data are the generator's.
 */

export const EB = { E: 210000, rho: 7.8e-9, L: 100, b: 20, h: 3, zeta: 0.02 } as const;

function simpson(fun: (x: number) => number, a: number, b: number, n: number): number {
  const h = (b - a) / n;
  let s = fun(a) + fun(b);
  for (let i = 1; i < n; i += 1) s += (i % 2 === 1 ? 4 : 2) * fun(a + i * h);
  return (s * h) / 3;
}

function clampedFreeRoot(n: number): number {
  const f = (x: number): number => Math.cos(x) * Math.cosh(x) + 1;
  let lo = (n - 0.5) * Math.PI - 0.5;
  let hi = (n - 0.5) * Math.PI + 0.5;
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (f(lo) * f(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

function modeShape(betaL: number, u: number): number {
  const s = (Math.cosh(betaL) + Math.cos(betaL)) / (Math.sinh(betaL) + Math.sin(betaL));
  const bx = betaL * u;
  return Math.cosh(bx) - Math.cos(bx) - s * (Math.sinh(bx) - Math.sin(bx));
}

/** Unnormalised curvature d^2 phi / du^2 / betaL^2 at u = x / L. */
function modeCurvature(betaL: number, u: number): number {
  const s = (Math.cosh(betaL) + Math.cos(betaL)) / (Math.sinh(betaL) + Math.sin(betaL));
  const bx = betaL * u;
  return Math.cosh(bx) + Math.cos(bx) - s * (Math.sinh(bx) + Math.sin(bx));
}

export interface EbModeField {
  /** Normalised deflection at u = x / L. */
  readonly shape: (u: number) => number;
  /** Bending stress sigma_xx at u and height z above the bottom face (neutral axis at h / 2), per unit modal coordinate. */
  readonly stress: (u: number, z: number) => number;
}

/** Deflection and stress fields of mode `index` (0-based) with the generator normalisation. */
export function ebField(index: number): EbModeField {
  const betaL = clampedFreeRoot(index + 1);
  const scale = 1 / Math.sqrt(simpson((u) => modeShape(betaL, u) ** 2, 0, 1, 4000));
  const beta = betaL / EB.L;
  return {
    shape: (u) => modeShape(betaL, u) * scale,
    stress: (u, z) => EB.E * (z - EB.h / 2) * beta * beta * modeCurvature(betaL, u) * scale,
  };
}

export interface EbMode {
  readonly fHz: number;
  readonly omega: number;
  readonly gamma: number;
  readonly tip: number;
  /** Root bending stress per unit modal coordinate: E (h/2) phi''(0). */
  readonly rootStress: number;
}

/** The first `count` modes of the strip. */
export function ebModes(count = 6): EbMode[] {
  const inertia = (EB.b * EB.h ** 3) / 12;
  const c = Math.sqrt((EB.E * inertia) / (EB.rho * EB.b * EB.h));
  return Array.from({ length: count }, (_, index) => {
    const betaL = clampedFreeRoot(index + 1);
    const scale = 1 / Math.sqrt(simpson((u) => modeShape(betaL, u) ** 2, 0, 1, 4000));
    const gamma = simpson((u) => modeShape(betaL, u), 0, 1, 4000) * scale;
    const omega = (betaL / EB.L) ** 2 * c;
    const curvature = 2 * (betaL / EB.L) ** 2 * scale;
    return { fHz: omega / (2 * Math.PI), omega, gamma, tip: modeShape(betaL, 1) * scale, rootStress: EB.E * (EB.h / 2) * curvature };
  });
}
