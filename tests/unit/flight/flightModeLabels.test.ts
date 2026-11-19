/**
 * Mode labels of a linearised flight (13 FLT M5b): participation-factor labels against the textbook Navion (Nelson, Flight Stability and
 * Automatic Control, 2nd ed., the Navion examples of ch. 4 and 5), the label branches on hand-built state matrices, and the hover block heuristic.
 */
import { describe, expect, it } from 'vitest';
import { analyseModes } from '@dynamics/flight/flightModes';

const G_FT = 32.2;
const U0_FT = 176;

/** An 8 x 8 state matrix (u, v, w, p, q, r, roll, pitch) from a longitudinal (u, w, q, pitch) and a lateral (v, p, r, roll) 4 x 4 block. */
function stateMatrix(longitudinal: number[][], lateral: number[][]): number[][] {
  const lon = [0, 2, 4, 7];
  const lat = [1, 3, 5, 6];
  const a = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 0));
  lon.forEach((i, r) => lon.forEach((j, c) => ((a[i] as number[])[j] = longitudinal[r]?.[c] ?? 0)));
  lat.forEach((i, r) => lat.forEach((j, c) => ((a[i] as number[])[j] = lateral[r]?.[c] ?? 0)));
  return a;
}

/** T A T⁻¹ for the diagonal T (a change of state units / signs: the eigenvalues and participations are invariant). */
const similar = (a: number[][], t: number[]): number[][] => a.map((row, i) => row.map((value, j) => ((t[i] ?? 1) * value) / (t[j] ?? 1)));

/** Navion longitudinal, standard body axes (z down) [u, w, q, θ], ft/s and rad, with Mα̇ folded in; to document axes (z up, q about +y). */
function navionLongitudinal(mq = -2.05): number[][] {
  const [xu, xw, zu, zw, mw, mwDot] = [-0.045, 0.036, -0.369, -2.02, -0.05, -0.0051];
  const standard = [
    [xu, xw, 0, -G_FT],
    [zu, zw, U0_FT, 0],
    [mwDot * zu, mw + mwDot * zw, mq + mwDot * U0_FT, 0],
    [0, 0, 1, 0],
  ];
  return similar(standard, [1, -1, -1, 1]);
}

/** Navion lateral, standard axes [β, p, r, φ] (1/s), to document axes [v = −U0 β (y left), p, r (about +z up), roll]. */
function navionLateral(lr = 2.19, nBeta = 4.49): number[][] {
  const [yBeta, lBeta, lp, nP, nR] = [-45.72, -15.98, -8.4, -0.35, -0.76];
  const standard = [
    [yBeta / U0_FT, 0, -1, G_FT / U0_FT],
    [lBeta, lp, lr, 0],
    [nBeta, nP, nR, 0],
    [0, 1, 0, 0],
  ];
  return similar(standard, [-U0_FT, 1, -1, 1]);
}

type Modes = NonNullable<ReturnType<typeof analyseModes>>['modes'];
const byLabel = (modes: Modes): Record<string, Modes[number]> => Object.fromEntries(modes.map((mode) => [mode.label, mode]));

describe('fixed-wing labels from participation factors (FLT-M5b)', () => {
  it("the Navion: Nelson's five modes, each named from the states that participate in it", () => {
    const analysed = analyseModes(stateMatrix(navionLongitudinal(), navionLateral()), 'fixed_wing');
    const modes = analysed?.modes ?? [];
    expect(modes.map((mode) => mode.label).sort()).toEqual(['dutch_roll', 'phugoid', 'roll_subsidence', 'short_period', 'spiral']);
    const named = byLabel(modes);
    // Nelson's roots: short period about -2.5 ± 2.6i, phugoid -0.017 ± 0.21i, roll -8.4, Dutch roll -0.49 ± 2.3i, spiral -0.009
    expect(named['short_period']?.re).toBeCloseTo(-2.49, 2);
    expect(named['short_period']?.im).toBeCloseTo(2.6, 2);
    expect(named['phugoid']?.re).toBeCloseTo(-0.017, 3);
    expect(named['phugoid']?.im).toBeCloseTo(0.2134, 3);
    expect(named['roll_subsidence']?.re).toBeCloseTo(-8.433, 2);
    expect(named['dutch_roll']?.re).toBeCloseTo(-0.489, 2);
    expect(named['dutch_roll']?.im).toBeCloseTo(2.334, 2);
    expect(named['spiral']?.re).toBeCloseTo(-0.0088, 3);
    // the participations: phugoid = speed + attitude, short period = incidence + rate, Dutch roll = sideslip + yaw rate, roll = p, spiral = roll angle
    const share = (label: string, states: readonly string[]): number =>
      states.reduce((sum, state) => sum + (named[label]?.participation?.[state as 'u'] ?? 0), 0);
    expect(share('phugoid', ['u', 'pitch'])).toBeGreaterThan(0.95);
    expect(share('short_period', ['w', 'q'])).toBeGreaterThan(0.95);
    expect(share('dutch_roll', ['v', 'r'])).toBeGreaterThan(0.9);
    expect(share('roll_subsidence', ['p'])).toBeGreaterThan(0.95);
    expect(share('spiral', ['roll'])).toBeGreaterThan(0.9);
    for (const mode of modes) {
      expect(mode.labelBasis).toBe('participation');
      const total = Object.values(mode.participation ?? {}).reduce((sum, value) => sum + value, 0);
      expect(total).toBeCloseTo(1, 12);
      expect(mode.longitudinalShare).toBeCloseTo(['phugoid', 'short_period'].includes(mode.label) ? 1 : 0, 9);
    }
    expect(modes.every((mode) => mode.stability === 'stable')).toBe(true);
  });

  it('the labels do not depend on the state units: the same Navion in standard-axis units keeps every label and participation', () => {
    const documentAxes = analyseModes(stateMatrix(navionLongitudinal(), navionLateral()), 'fixed_wing')?.modes ?? [];
    const rescaled =
      analyseModes(similar(stateMatrix(navionLongitudinal(), navionLateral()), [1, 1e-3, -1, 57.3, 1e2, -1, 1e4, 1]), 'fixed_wing')
        ?.modes ?? [];
    expect(rescaled.map((mode) => mode.label)).toEqual(documentAxes.map((mode) => mode.label));
    rescaled.forEach((mode, i) =>
      Object.entries(mode.participation ?? {}).forEach(([state, value]) =>
        expect(value).toBeCloseTo(documentAxes[i]?.participation?.[state as 'u'] ?? Number.NaN, 6),
      ),
    );
  });

  it('a spiral made divergent (Lr up: Lβ Nr < Lr Nβ) keeps its label and is flagged with its time to double', () => {
    const modes = analyseModes(stateMatrix(navionLongitudinal(), navionLateral(3.5)), 'fixed_wing')?.modes ?? [];
    const spiral = byLabel(modes)['spiral'];
    expect(spiral?.stability).toBe('unstable');
    expect(spiral?.timeToDoubleS).toBeCloseTo(Math.LN2 / (spiral?.re ?? Number.NaN), 9);
    expect(byLabel(modes)['roll_subsidence']).toBeDefined();
    expect(byLabel(modes)['dutch_roll']).toBeDefined();
  });

  it('an overdamped short period (Navion with Mq x 20) splits into two short_period_real roots led by w + q; the phugoid stays', () => {
    const modes = analyseModes(stateMatrix(navionLongitudinal(-41), navionLateral()), 'fixed_wing')?.modes ?? [];
    const split = modes.filter((mode) => mode.label === 'short_period_real');
    expect(split).toHaveLength(2);
    for (const mode of split) {
      expect(mode.kind).toBe('real');
      expect((mode.participation?.w ?? 0) + (mode.participation?.q ?? 0)).toBeGreaterThan(0.8);
    }
    expect(modes.filter((mode) => mode.label === 'phugoid')).toHaveLength(1);
    expect(modes.some((mode) => mode.label === 'short_period')).toBe(false);
  });

  it('lateral_neutral: no sideslip or rate derivatives leaves the lateral block nilpotent (v-dot = g roll, roll-dot = p), its defective zeros are not a spiral', () => {
    const glider = [
      [0, 0, 0, -9.80665],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 1, 0, 0],
    ];
    const modes = analyseModes(stateMatrix(navionLongitudinal(), glider), 'fixed_wing')?.modes ?? [];
    const lateral = modes.filter((mode) => (mode.longitudinalShare ?? 1) < 0.5);
    expect(lateral.length).toBeGreaterThan(0);
    for (const mode of lateral) {
      expect(mode.label).toBe('lateral_neutral');
      expect(mode.stability).toBe('neutral');
    }
    expect(lateral.some((mode) => mode.participation === null && mode.labelBasis === 'eigenvector')).toBe(true);
    expect(modes.map((mode) => mode.label)).toEqual(expect.arrayContaining(['phugoid', 'short_period']));
  });

  it('the other branches: overdamped longitudinal roots, lateral roots led by v or r, and a lateral pair led by roll', () => {
    const longitudinal = [
      [-0.05, 0, 0, 0],
      [0, -0.2, 0, 0],
      [0, 0, -12, 0],
      [0, 0, -1, -0.5],
    ];
    const lateral = [
      [-1, 0, 0, 0],
      [0, -0.4, 0, -4],
      [0, 0, -2, 0],
      [0, 1, 0, 0],
    ];
    const modes = analyseModes(stateMatrix(longitudinal, lateral), 'fixed_wing')?.modes ?? [];
    // u and pitch lead two of the real longitudinal roots, w and q the other two
    expect(modes.filter((mode) => mode.label === 'phugoid_real')).toHaveLength(2);
    expect(modes.filter((mode) => mode.label === 'short_period_real')).toHaveLength(2);
    expect(modes.filter((mode) => mode.label === 'lateral_real')).toHaveLength(2);
    const oscillation = modes.find((mode) => mode.label === 'lateral_oscillatory');
    expect(oscillation?.im).toBeCloseTo(Math.sqrt(4 - 0.04), 9);
    expect(oscillation?.dampingRatio).toBeCloseTo(0.1, 9);
  });

  it('strong longitudinal-lateral coupling shares a mode between the groups: labelled coupled, couplingRatio > 0', () => {
    const a = stateMatrix(
      [
        [-1, 0, 0, 0],
        [0, -2, 0, 0],
        [0, 0, -3, 0],
        [0, 0, 0, -4],
      ],
      [
        [-5, 0, 0, 0],
        [0, -6, 0, 0],
        [0, 0, -7, 0],
        [0, 0, 0, -8],
      ],
    );
    (a[0] as number[])[5] = 30;
    (a[5] as number[])[0] = -30;
    const coupled = analyseModes(a, 'fixed_wing');
    expect(coupled?.couplingRatio).toBeGreaterThan(0.1);
    const mode = coupled?.modes.find((entry) => entry.label === 'coupled');
    expect(mode?.longitudinalShare).toBeGreaterThan(0.2);
    expect(mode?.longitudinalShare).toBeLessThan(0.8);
  });
});

describe('hover labels (block heuristic) and failures', () => {
  it('hover: heave is the real longitudinal root nearest A[w][w], yaw the real lateral root nearest A[r][r], the chains are translations', () => {
    const a = stateMatrix(
      [
        [0, 0, 0, -9.8],
        [0, -0.4, 0, 0],
        [0, 0, 0, -1],
        [0, 0, 0, 0],
      ],
      [
        [0, 0, 0, -9.8],
        [0, 0, 0, 1],
        [0, 0, -0.3, 0],
        [0, 1, 0, 0],
      ],
    );
    const modes = analyseModes(a, 'hover')?.modes ?? [];
    expect(modes.filter((mode) => mode.label === 'heave')).toHaveLength(1);
    expect(modes.find((mode) => mode.label === 'heave')?.re).toBeCloseTo(-0.4, 6);
    expect(modes.find((mode) => mode.label === 'yaw')?.re).toBeCloseTo(-0.3, 6);
    expect(modes.filter((mode) => mode.label === 'pitch_translation').length).toBeGreaterThan(0);
    expect(modes.filter((mode) => mode.label === 'roll_translation').length).toBeGreaterThan(0);
    expect(modes.every((mode) => mode.labelBasis === 'block')).toBe(true);
    // the heave root is simple: its participation is defined and all in w
    expect(modes.find((mode) => mode.label === 'heave')?.participation?.w).toBeCloseTo(1, 6);
  });

  it('a hover root with no block root within 10 % (strong coupling) is coupled', () => {
    const a = stateMatrix(
      [
        [-1, 0, 0, 0],
        [0, -2, 0, 0],
        [0, 0, -3, 0],
        [0, 0, 0, -4],
      ],
      [
        [-5, 0, 0, 0],
        [0, -6, 0, 0],
        [0, 0, -7, 0],
        [0, 0, 0, -8],
      ],
    );
    (a[0] as number[])[5] = 30;
    (a[5] as number[])[0] = -30;
    expect(analyseModes(a, 'hover')?.modes.some((mode) => mode.label === 'coupled')).toBe(true);
  });

  it('a non-finite state matrix has no analysis', () => {
    const a = stateMatrix([], []);
    (a[0] as number[])[0] = Number.NaN;
    expect(analyseModes(a, 'hover')).toBeNull();
    expect(analyseModes(a, 'fixed_wing')).toBeNull();
  });
});
