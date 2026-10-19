/**
 * Closed-form reference solutions for FE sanity checks (05 FR-FEA-21; mirrors validation/generate_fea_analytic.py): Euler-Bernoulli cantilever and
 * simply supported beam, cantilever natural frequencies, Euler column buckling, simply supported plate buckling, Kirsch stress concentration.
 * Units are in the key suffix and consistent with N-mm-t-s (MPa = N/mm^2, density in t/mm^3).
 */

export interface InputSpec {
  readonly key: string;
  readonly unit: string;
  readonly description: string;
  /** Allowed range [lo, hi], default > 0; `open` makes both ends exclusive. */
  readonly range?: readonly [number, number];
  readonly open?: true;
  readonly integer?: true;
}

interface AnalyticResult {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly formula: string;
}

interface Evaluation {
  readonly results: readonly AnalyticResult[];
  readonly assumptions: readonly string[];
  readonly sources: readonly string[];
}

export interface CheckSpec {
  readonly summary: string;
  readonly required: readonly InputSpec[];
  readonly optional: readonly InputSpec[];
  /** At least one of these optional keys must be given (the check is meaningless otherwise). */
  readonly oneOf?: readonly string[];
  readonly evaluate: (input: Readonly<Record<string, number>>) => Evaluation;
}

/** Roots beta_n L of cos(x) cosh(x) + 1 = 0 (clamped-free beam), n = 1..6. */
const CANTILEVER_ROOTS: readonly number[] = [1.8751040687, 4.694091133, 7.8547574382, 10.995540735, 14.137168391, 17.278759532];
const SHEAR_COEFFICIENT = 5 / 6;
const MAX_PLATE_HALF_WAVES = 60;

const result = (name: string, value: number, unit: string, formula: string): AnalyticResult => ({ name, value, unit, formula });

const need = (input: Readonly<Record<string, number>>, key: string): number => input[key] ?? Number.NaN;

const E: InputSpec = { key: 'E_MPa', unit: 'MPa', description: "Young's modulus." };
const SECTION_B: InputSpec = { key: 'b_mm', unit: 'mm', description: 'Section width (the side perpendicular to the load direction).' };
const SECTION_H: InputSpec = { key: 'h_mm', unit: 'mm', description: 'Section depth (the side along the load direction).' };
const LENGTH: InputSpec = { key: 'L_mm', unit: 'mm', description: 'Beam / column length.' };
const NU_OPTIONAL: InputSpec = {
  key: 'nu',
  unit: '1',
  description: "Poisson's ratio (-1 < nu < 0.5); adds the shear-corrected deflection.",
  range: [-1, 0.5],
  open: true,
};

/** Rectangular section properties: area and the second moments about the width axis (bending in the depth direction) and the depth axis. */
const rectangle = (b: number, h: number): { area: number; inertiaDepth: number; inertiaWidth: number } => ({
  area: b * h,
  inertiaDepth: (b * h ** 3) / 12,
  inertiaWidth: (h * b ** 3) / 12,
});

const cantilever: CheckSpec = {
  summary: 'End-loaded cantilever of rectangular section (Euler-Bernoulli, optional Timoshenko shear term).',
  required: [{ key: 'P_N', unit: 'N', description: 'Tip load perpendicular to the axis.' }, LENGTH, E, SECTION_B, SECTION_H],
  optional: [NU_OPTIONAL],
  evaluate: (input) => {
    const [load, length, young, b, h] = ['P_N', 'L_mm', 'E_MPa', 'b_mm', 'h_mm'].map((key) => need(input, key)) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const { area, inertiaDepth } = rectangle(b, h);
    const bending = (load * length ** 3) / (3 * young * inertiaDepth);
    const nu = input['nu'];
    const results: AnalyticResult[] = [
      result('tip_deflection_mm', bending, 'mm', 'delta = P L^3 / (3 E I), I = b h^3 / 12'),
      ...(nu === undefined
        ? []
        : [
            result(
              'tip_deflection_timoshenko_mm',
              bending + (load * length) / (SHEAR_COEFFICIENT * (young / (2 * (1 + nu))) * area),
              'mm',
              'delta = P L^3 / (3 E I) + P L / (k G A), k = 5/6, G = E / (2 (1 + nu))',
            ),
          ]),
      result('root_bending_moment_Nmm', load * length, 'N.mm', 'M = P L'),
      result(
        'root_bending_stress_MPa',
        (load * length * (h / 2)) / inertiaDepth,
        'MPa',
        'sigma = M c / I, c = h / 2 (outer fibre at the root)',
      ),
      result('tip_stiffness_N_per_mm', (3 * young * inertiaDepth) / length ** 3, 'N/mm', 'k = 3 E I / L^3'),
      result('second_moment_mm4', inertiaDepth, 'mm^4', 'I = b h^3 / 12'),
    ];
    return {
      results,
      assumptions: [
        'linear elastic, small deflection',
        'slender beam: Euler-Bernoulli ignores shear (add nu for the Timoshenko term)',
        'fully fixed root',
      ],
      sources: ['S20', 'S30'],
    };
  },
};

const cantileverFrequency: CheckSpec = {
  summary: 'Natural frequency of the n-th bending mode of a clamped-free beam of rectangular section (both principal planes).',
  required: [
    E,
    { key: 'rho_t_per_mm3', unit: 't/mm^3', description: 'Mass density in tonne per cubic millimetre (steel 7.8e-9).' },
    SECTION_B,
    SECTION_H,
    LENGTH,
  ],
  optional: [{ key: 'mode', unit: '1', description: 'Bending mode number 1..6 (default 1).', range: [1, 6], integer: true }],
  evaluate: (input) => {
    const [young, density, b, h, length] = ['E_MPa', 'rho_t_per_mm3', 'b_mm', 'h_mm', 'L_mm'].map((key) => need(input, key)) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const mode = Math.round(input['mode'] ?? 1);
    const root = CANTILEVER_ROOTS[mode - 1] ?? Number.NaN;
    const { area, inertiaDepth, inertiaWidth } = rectangle(b, h);
    const frequency = (inertia: number): number =>
      (root ** 2 / (2 * Math.PI * length ** 2)) * Math.sqrt((young * inertia) / (density * area));
    const [weak, strong] = [Math.min(inertiaDepth, inertiaWidth), Math.max(inertiaDepth, inertiaWidth)];
    return {
      results: [
        result('mode_beta_L', root, '1', 'root of cos(x) cosh(x) + 1 = 0'),
        result(
          'frequency_weak_axis_Hz',
          frequency(weak),
          'Hz',
          'f_n = (beta_n L)^2 / (2 pi L^2) sqrt(E I / (rho A)), I = the smaller second moment',
        ),
        result('frequency_strong_axis_Hz', frequency(strong), 'Hz', 'as above with I = the larger second moment'),
      ],
      assumptions: [
        'Euler-Bernoulli: no shear deformation or rotary inertia, so it over-predicts for short, deep beams (L/h below about 10) and for higher modes',
        'distributed mass only, no tip mass; torsional and axial modes are not covered',
      ],
      sources: ['S20', 'S30'],
    };
  },
};

const simplySupportedBeam: CheckSpec = {
  summary: 'Simply supported beam of rectangular section under a central point load and / or a uniform load (maxima at mid-span).',
  required: [LENGTH, E, SECTION_B, SECTION_H],
  optional: [
    { key: 'P_N', unit: 'N', description: 'Central point load.' },
    { key: 'w_N_per_mm', unit: 'N/mm', description: 'Uniform load per unit length.' },
  ],
  oneOf: ['P_N', 'w_N_per_mm'],
  evaluate: (input) => {
    const [length, young, b, h] = ['L_mm', 'E_MPa', 'b_mm', 'h_mm'].map((key) => need(input, key)) as [number, number, number, number];
    const point = input['P_N'] ?? 0;
    const uniform = input['w_N_per_mm'] ?? 0;
    const { inertiaDepth } = rectangle(b, h);
    const moment = (point * length) / 4 + (uniform * length ** 2) / 8;
    return {
      results: [
        result(
          'midspan_deflection_mm',
          (point * length ** 3) / (48 * young * inertiaDepth) + (5 * uniform * length ** 4) / (384 * young * inertiaDepth),
          'mm',
          'delta = P L^3 / (48 E I) + 5 w L^4 / (384 E I)',
        ),
        result('midspan_bending_moment_Nmm', moment, 'N.mm', 'M = P L / 4 + w L^2 / 8'),
        result('midspan_bending_stress_MPa', (moment * (h / 2)) / inertiaDepth, 'MPa', 'sigma = M c / I, c = h / 2'),
        result('support_reaction_N', point / 2 + (uniform * length) / 2, 'N', 'R = P / 2 + w L / 2'),
      ],
      assumptions: ['linear elastic, small deflection, Euler-Bernoulli (no shear)', 'both loads act at mid-span maxima, so they superpose'],
      sources: ['S20'],
    };
  },
};

const eulerColumn: CheckSpec = {
  summary: 'Euler critical load of a prismatic column of rectangular section for a stated effective-length factor.',
  required: [
    LENGTH,
    E,
    SECTION_B,
    SECTION_H,
    {
      key: 'K',
      unit: '1',
      description: 'Effective-length factor: 2 fixed-free, 1 pinned-pinned, 0.699 fixed-pinned, 0.5 fixed-fixed.',
      range: [0.1, 4],
    },
  ],
  optional: [],
  evaluate: (input) => {
    const [length, young, b, h, factor] = ['L_mm', 'E_MPa', 'b_mm', 'h_mm', 'K'].map((key) => need(input, key)) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const { area, inertiaDepth, inertiaWidth } = rectangle(b, h);
    const inertia = Math.min(inertiaDepth, inertiaWidth);
    const critical = (Math.PI ** 2 * young * inertia) / (factor * length) ** 2;
    return {
      results: [
        result('critical_load_N', critical, 'N', 'P_cr = pi^2 E I_min / (K L)^2'),
        result('critical_stress_MPa', critical / area, 'MPa', 'sigma_cr = P_cr / A'),
        result('slenderness_ratio', (factor * length) / Math.sqrt(inertia / area), '1', 'KL / r, r = sqrt(I_min / A)'),
        result('second_moment_min_mm4', inertia, 'mm^4', 'I_min = min(b h^3, h b^3) / 12'),
      ],
      assumptions: [
        'linear elastic, perfectly straight and centrically loaded: real columns buckle lower (imperfections, eccentricity)',
        'valid for slender columns (KL / r above about 100); stocky columns yield before they buckle',
      ],
      sources: ['S20'],
    };
  },
};

const plateBuckling: CheckSpec = {
  summary: 'Uniaxial compressive buckling stress of a simply supported rectangular plate.',
  required: [
    E,
    { key: 'nu', unit: '1', description: "Poisson's ratio (-1 < nu < 0.5).", range: [-1, 0.5], open: true },
    { key: 't_mm', unit: 'mm', description: 'Plate thickness.' },
    { key: 'a_mm', unit: 'mm', description: 'Plate length in the load direction.' },
    { key: 'b_mm', unit: 'mm', description: 'Loaded-edge width (the side the compression acts on).' },
  ],
  optional: [],
  evaluate: (input) => {
    const [young, nu, thickness, a, b] = ['E_MPa', 'nu', 't_mm', 'a_mm', 'b_mm'].map((key) => need(input, key)) as [
      number,
      number,
      number,
      number,
      number,
    ];
    let coefficient = Number.POSITIVE_INFINITY;
    let halfWaves = 1;
    for (let m = 1; m <= MAX_PLATE_HALF_WAVES; m++) {
      const k = ((m * b) / a + a / (m * b)) ** 2;
      if (k < coefficient) {
        coefficient = k;
        halfWaves = m;
      }
    }
    return {
      results: [
        result('buckling_coefficient_k', coefficient, '1', 'k = min over m of (m b / a + a / (m b))^2'),
        result('half_waves_m', halfWaves, '1', 'the m that minimises k'),
        result(
          'critical_stress_MPa',
          ((coefficient * Math.PI ** 2 * young) / (12 * (1 - nu ** 2))) * (thickness / b) ** 2,
          'MPa',
          'sigma_cr = k pi^2 E / (12 (1 - nu^2)) (t / b)^2',
        ),
      ],
      assumptions: [
        'all four edges simply supported, uniform compression on the edges of width b',
        'linear elastic, thin plate, no post-buckling reserve',
      ],
      sources: ['S22'],
    };
  },
};

const kirsch: CheckSpec = {
  summary: 'Kirsch solution: circular hole in an infinite plate under remote uniaxial tension (gross stress concentration Kt = 3).',
  required: [],
  optional: [
    { key: 'S_MPa', unit: 'MPa', description: 'Remote stress (default 1: results are then the stress factors).' },
    {
      key: 'y_over_a',
      unit: '1',
      description: 'Distance from the hole centre over the hole radius along the transverse axis, > 1.',
      range: [1, Infinity],
    },
    { key: 'theta_deg', unit: 'deg', description: 'Angle on the hole edge measured from the load axis, 0..360.', range: [0, 360] },
  ],
  evaluate: (input) => {
    const stress = input['S_MPa'] ?? 1;
    const profile = input['y_over_a'];
    const angle = input['theta_deg'];
    const transverse = (q: number): number => 1 + 0.5 * q ** 2 + 1.5 * q ** 4;
    return {
      results: [
        result('Kt_gross', 3, '1', 'sigma_tt(a, 90 deg) = S (1 - 2 cos 180 deg) = 3 S'),
        result('stress_at_hole_edge_MPa', 3 * stress, 'MPa', 'sigma = 3 S at the hole edge on the transverse axis'),
        ...(profile === undefined
          ? []
          : [
              result(
                'sigma_xx_at_y_MPa',
                stress * transverse(1 / profile),
                'MPa',
                'sigma_xx = S (1 + a^2 / (2 y^2) + 3 a^4 / (2 y^4)) on the transverse axis',
              ),
            ]),
        ...(angle === undefined
          ? []
          : [
              result(
                'hoop_stress_at_theta_MPa',
                stress * (1 - 2 * Math.cos((2 * angle * Math.PI) / 180)),
                'MPa',
                'sigma_tt = S (1 - 2 cos 2 theta) on the hole edge',
              ),
            ]),
      ],
      assumptions: [
        'infinite plate: a finite plate with W / d >= 10 stays within about 5 % (gross Kt)',
        'plane stress, linear elastic, remote tension S along the x axis',
      ],
      sources: ['S21'],
    };
  },
};

export const ANALYTIC_CHECKS: Readonly<Record<string, CheckSpec>> = {
  cantilever,
  cantilever_frequency: cantileverFrequency,
  ss_beam: simplySupportedBeam,
  euler_column: eulerColumn,
  ss_plate_buckling: plateBuckling,
  kirsch_kt: kirsch,
};
