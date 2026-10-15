#!/usr/bin/env python3
"""Analytic + seeded Monte Carlo reference values for tolerance stack-up (gap GDT, VC-GDT-30..36).

Standard library only, deterministic: `python3 -I generate_stackup_reference.py` rewrites
stackup_reference.json next to this file. Nothing here is quoted from a standard; every value is
derived from the formulas below (derivation class (b) of docs/aerospace/TEMPLATE.md).

Model. A stack (gap, clearance, height ...) is y = f(x1..xn). Each contributor xi has nominal mi and
bilateral limits [mi + lo_i, mi + hi_i]. It is first re-centred: ci = mi + (lo_i + hi_i)/2 (mean),
ti = (hi_i - lo_i)/2 (symmetric half tolerance). For a linear stack y = sum(ai * xi):

  worst case (WC):  y_nom = sum(ai ci),  T_wc = sum(|ai| ti)              (exact, no distribution)
  RSS:              T_rss = sqrt(sum((ai ti)^2))                           (= k * sigma_y when each ti = k sigma_i)
  sigma model:      sigma_i = ti / 3   for 'normal'  (ti = 3 sigma, the classic +-3 sigma assumption)
                    sigma_i = ti / sqrt(3) for 'uniform' (variance of U(-t, t) is t^2 / 3)
                    sigma_y = sqrt(sum((ai sigma_i)^2))                     (variance of a sum of independent RVs)
  P(y < L) for a normal y:  Phi((L - y_mean) / sigma_y)                     (Phi = standard normal CDF via math.erf)
  P(y < L) all-uniform:     exact generalised Irwin-Hall CDF (inclusion-exclusion over the 2^n width subsets);
                            the normal approximation is also reported to show its tail error.

Every case carries its exact coefficients ai ('sensitivities'; analytic partials at the means for the
non-linear SU-05); the central difference below is only a fallback. For a non-linear stack these
first-order (linearised) sensitivities ai = df/dxi at the means are used
for WC/RSS, and the exact corner-search WC (all 2^n limit combinations) is reported alongside, which
shows why a Monte Carlo is needed.

Monte Carlo. Python's `random.Random(seed).random()` is reproducible across Python versions (Mersenne
Twister, documented); normal deviates are drawn with an explicit Box-Muller transform on it (not
random.gauss, whose algorithm is not guaranteed stable). An implementation in llull uses its own seeded
PRNG, so expected MC values carry a statistical tolerance: mean +- 5 * sigma_y / sqrt(N), std +- 5 *
sigma_y / sqrt(2N), probabilities +- 5 * sqrt(p (1-p) / N) (plus an absolute floor of 1e-5).
"""

from __future__ import annotations

import itertools
import json
import math
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = 20261015
N = 200_000


def phi(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


class Sampler:
    def __init__(self, seed: int) -> None:
        self.rng = random.Random(seed)
        self.spare: float | None = None

    def normal(self) -> float:
        if self.spare is not None:
            value, self.spare = self.spare, None
            return value
        u1 = self.rng.random()
        while u1 <= 0.0:
            u1 = self.rng.random()
        u2 = self.rng.random()
        radius = math.sqrt(-2.0 * math.log(u1))
        self.spare = radius * math.sin(2.0 * math.pi * u2)
        return radius * math.cos(2.0 * math.pi * u2)

    def draw(self, centre: float, half: float, dist: str) -> float:
        if dist == 'normal':
            return centre + (half / 3.0) * self.normal()
        if dist == 'uniform':
            return centre + half * (2.0 * self.rng.random() - 1.0)
        raise ValueError(dist)


def uniform_sum_cdf(x: float, terms: list[tuple[float, float]]) -> float:
    """P(sum Ui <= x), Ui ~ U(lo_i, lo_i + w_i) independent: (1 / (n! prod w)) sum_S (-1)^|S| (x - sum lo - sum_S w)_+^n."""
    n = len(terms)
    base = x - sum(lo for lo, _ in terms)
    widths = [w for _, w in terms]
    total = 0.0
    for mask in range(1 << n):
        shift = sum(widths[i] for i in range(n) if mask >> i & 1)
        sign = -1.0 if bin(mask).count('1') % 2 else 1.0
        total += sign * max(base - shift, 0.0) ** n
    return total / (math.factorial(n) * math.prod(widths))


def r(x: float, digits: int = 9) -> float:
    return float(round(x, digits))


def recentre(contrib: dict) -> tuple[float, float]:
    lo, hi = contrib['lower'], contrib['upper']
    return contrib['nominal'] + (lo + hi) / 2.0, (hi - lo) / 2.0


def sigma_of(half: float, dist: str) -> float:
    return half / 3.0 if dist == 'normal' else half / math.sqrt(3.0)


def evaluate(case: dict) -> dict:
    contribs = case['contributors']
    centres, halves = zip(*(recentre(c) for c in contribs))
    dists = [c.get('distribution', 'normal') for c in contribs]
    f = case['function']
    nominal_values = [c['nominal'] for c in contribs]
    y_nominal = f(nominal_values)
    y_mean_lin = f(list(centres))
    eps = 1e-6
    sens = list(case['sensitivities']) if 'sensitivities' in case else []
    # exact coefficients: a central difference at |c| = 100 carries ~3e-9 relative error, which moves the
    # probabilities by > 1e-12 and the SU-05 RSS by > 1e-9 (the stated tolerances)
    for i in range(len(sens), len(contribs)):
        up = list(centres)
        dn = list(centres)
        up[i] += eps
        dn[i] -= eps
        sens.append((f(up) - f(dn)) / (2 * eps))
    t_wc = sum(abs(a) * t for a, t in zip(sens, halves))
    t_rss = math.sqrt(sum((a * t) ** 2 for a, t in zip(sens, halves)))
    sigma_y = math.sqrt(sum((a * sigma_of(t, d)) ** 2 for a, t, d in zip(sens, halves, dists)))
    corners = [f([c + s * t for c, s, t in zip(centres, signs, halves)]) for signs in itertools.product((-1, 1), repeat=len(contribs))]
    out = {
        'id': case['id'],
        'title': case['title'],
        'expression': case['expression'],
        'contributors': [
            {**{k: v for k, v in c.items()}, 'mean': r(m), 'halfTolerance': r(t), 'sensitivity': r(a, 6)}
            for c, m, t, a in zip(contribs, centres, halves, sens)
        ],
        'analytic': {
            'yNominal': r(y_nominal),
            'yMean': r(y_mean_lin),
            'worstCase': {'halfTolerance': r(t_wc), 'min': r(y_mean_lin - t_wc), 'max': r(y_mean_lin + t_wc)},
            'worstCaseExactCorners': {'min': r(min(corners)), 'max': r(max(corners))},
            'rss': {'halfTolerance': r(t_rss), 'min': r(y_mean_lin - t_rss), 'max': r(y_mean_lin + t_rss)},
            'sigma': r(sigma_y),
        },
        'unit': case.get('unit', 'mm'),
    }
    limit = case.get('lowerSpecLimit')
    if limit is not None:
        out['analytic']['lowerSpecLimit'] = limit
        if all(d == 'normal' for d in dists):
            # exact for a linear stack of independent normals
            p_exact, method = phi((limit - y_mean_lin) / sigma_y), 'normal CDF (exact: linear sum of independent normals)'
        elif all(d == 'uniform' for d in dists):
            p_exact = uniform_sum_cdf(limit, [(a * c - abs(a) * t, 2 * abs(a) * t) for a, c, t in zip(sens, centres, halves)])
            method = 'exact CDF of a sum of independent uniforms (inclusion-exclusion, generalised Irwin-Hall)'
        else:
            raise ValueError('mixed distributions: no exact reference')
        out['analytic']['pBelowLowerLimit'] = r(p_exact, 12)
        out['analytic']['pMethod'] = method
        out['analytic']['pBelowLowerLimitNormalApprox'] = r(phi((limit - y_mean_lin) / sigma_y), 12)
    sampler = Sampler(SEED)
    total = 0.0
    total_sq = 0.0
    below = 0
    lo_seen, hi_seen = math.inf, -math.inf
    for _ in range(N):
        y = f([sampler.draw(c, t, d) for c, t, d in zip(centres, halves, dists)])
        total += y
        total_sq += y * y
        lo_seen = min(lo_seen, y)
        hi_seen = max(hi_seen, y)
        if limit is not None and y < limit:
            below += 1
    mean = total / N
    std = math.sqrt(max(total_sq / N - mean * mean, 0.0) * N / (N - 1))
    mc = {
        'seed': SEED,
        'samples': N,
        'prng': 'Python random.Random(seed).random() + Box-Muller (normal); uniform = c + t(2u-1)',
        'mean': r(mean),
        'std': r(std),
        'min': r(lo_seen),
        'max': r(hi_seen),
        'acceptance': {
            'meanTolerance': r(5 * sigma_y / math.sqrt(N)),
            'stdTolerance': r(5 * sigma_y / math.sqrt(2 * N)),
        },
    }
    if limit is not None:
        p = below / N
        p_ref = out['analytic']['pBelowLowerLimit']
        mc['pBelowLowerLimit'] = r(p, 9)
        mc['acceptance']['pTolerance'] = r(max(5 * math.sqrt(max(p_ref, 1e-12) * (1 - p_ref) / N), 1e-5), 9)
    out['monteCarlo'] = mc
    return out


CASES = [
    {
        'id': 'SU-01',
        'title': 'Linear 1D gap: housing bore depth minus four stacked spacers (all symmetric, normal)',
        'expression': 'gap = H - (A + B + C + D)',
        'function': lambda x: x[0] - (x[1] + x[2] + x[3] + x[4]),
        'sensitivities': [1.0, -1.0, -1.0, -1.0, -1.0],
        'contributors': [
            {'name': 'H', 'nominal': 100.00, 'lower': -0.10, 'upper': 0.10},
            {'name': 'A', 'nominal': 24.95, 'lower': -0.05, 'upper': 0.05},
            {'name': 'B', 'nominal': 25.00, 'lower': -0.03, 'upper': 0.03},
            {'name': 'C', 'nominal': 24.90, 'lower': -0.04, 'upper': 0.04},
            {'name': 'D', 'nominal': 25.00, 'lower': -0.02, 'upper': 0.02},
        ],
        'lowerSpecLimit': 0.0,
    },
    {
        'id': 'SU-02',
        'title': 'Same stack, all contributors uniform (sigma = t / sqrt(3)) - RSS-normal is optimistic',
        'expression': 'gap = H - (A + B + C + D)',
        'function': lambda x: x[0] - (x[1] + x[2] + x[3] + x[4]),
        'sensitivities': [1.0, -1.0, -1.0, -1.0, -1.0],
        'contributors': [
            {'name': 'H', 'nominal': 100.00, 'lower': -0.10, 'upper': 0.10, 'distribution': 'uniform'},
            {'name': 'A', 'nominal': 24.95, 'lower': -0.05, 'upper': 0.05, 'distribution': 'uniform'},
            {'name': 'B', 'nominal': 25.00, 'lower': -0.03, 'upper': 0.03, 'distribution': 'uniform'},
            {'name': 'C', 'nominal': 24.90, 'lower': -0.04, 'upper': 0.04, 'distribution': 'uniform'},
            {'name': 'D', 'nominal': 25.00, 'lower': -0.02, 'upper': 0.02, 'distribution': 'uniform'},
        ],
        'lowerSpecLimit': 0.0,
    },
    {
        'id': 'SU-03',
        'title': 'Unequal bilateral limits: pin in hole diametral clearance (re-centred to mean +- t)',
        'expression': 'clearance = Dhole - Dpin',
        'function': lambda x: x[0] - x[1],
        'sensitivities': [1.0, -1.0],
        'contributors': [
            {'name': 'Dhole', 'nominal': 20.000, 'lower': 0.000, 'upper': 0.021},
            {'name': 'Dpin', 'nominal': 20.000, 'lower': -0.020, 'upper': -0.007},
        ],
        'lowerSpecLimit': 0.0,
    },
    {
        'id': 'SU-04',
        'title': 'Non-unit sensitivities: radial clearance of a pin in a located hole (diameters enter with 1/2). TEST VECTOR: radial locating errors e1, e2 are modelled as symmetric normals about 0.025 for arithmetic coverage; a real radial position error is non-negative (Rayleigh-like) and needs a 2D/MC model',
        'expression': 'radialClearance = Dhole/2 - Dpin/2 - e1 - e2   (e = radial locating error of hole and pin axes)',
        'function': lambda x: x[0] / 2 - x[1] / 2 - x[2] - x[3],
        'sensitivities': [0.5, -0.5, -1.0, -1.0],
        'contributors': [
            {'name': 'Dhole', 'nominal': 10.20, 'lower': -0.05, 'upper': 0.05},
            {'name': 'Dpin', 'nominal': 10.00, 'lower': -0.02, 'upper': 0.02},
            {'name': 'e1', 'nominal': 0.025, 'lower': -0.025, 'upper': 0.025},
            {'name': 'e2', 'nominal': 0.025, 'lower': -0.025, 'upper': 0.025},
        ],
        'lowerSpecLimit': 0.0,
    },
    {
        'id': 'SU-05',
        'title': 'Non-linear: tip height of an arm h = L sin(theta), theta in degrees - linearised WC vs exact corners vs MC',
        'expression': 'h = L * sin(theta_deg * pi / 180)',
        'function': lambda x: x[0] * math.sin(math.radians(x[1])),
        # analytic partials at the means (L = 100, theta = 30 deg): dh/dL = sin(theta), dh/dtheta = L cos(theta) pi/180
        'sensitivities': [math.sin(math.radians(30.0)), 100.0 * math.cos(math.radians(30.0)) * math.pi / 180.0],
        'contributors': [
            {'name': 'L', 'nominal': 100.0, 'lower': -0.1, 'upper': 0.1},
            {'name': 'theta_deg', 'nominal': 30.0, 'lower': -0.5, 'upper': 0.5, 'unit': 'deg'},
        ],
    },
]


def fastener_cases() -> list[dict]:
    """Position tolerance for floating / fixed fasteners and MMC bonus, derived from clearance geometry.

    Floating fastener (both parts have clearance holes of MMC diameter H, fastener MMC diameter F): each
    hole axis may sit anywhere within a radial distance (H - F)/2 of the fastener axis, so the diametral
    position zone per part is T = H - F.
    Fixed fastener (fastener fixed by a threaded / press hole with position zone T2, clearance hole T1):
    worst-case relative axis offset T1/2 + T2/2 <= (H - F)/2, hence T1 + T2 = H - F (equal split: T = (H - F)/2).
    MMC bonus on an internal feature: allowed position = stated tolerance + (actual size - MMC size).
    Virtual condition of an internal feature at MMC = MMC size - position tolerance.
    """
    h, f = 6.6, 6.0
    stated, hole_mmc, hole_lmc = 0.3, 6.6, 6.9
    return [
        {'id': 'FF-01', 'title': 'Floating fastener: T = H - F', 'H': h, 'F': f, 'T_each': r(h - f), 'unit': 'mm'},
        {'id': 'FF-02', 'title': 'Fixed fastener, equal split: T1 = T2 = (H - F) / 2', 'H': h, 'F': f, 'T_each': r((h - f) / 2), 'unit': 'mm'},
        {
            'id': 'FF-03',
            'title': 'MMC bonus and virtual condition of a hole 6.6-6.9 with position dia 0.3 (M)',
            'statedPosition': stated,
            'sizeMMC': hole_mmc,
            'sizeLMC': hole_lmc,
            'allowedPositionAtMMC': r(stated),
            'allowedPositionAtLMC': r(stated + (hole_lmc - hole_mmc)),
            'allowedPositionAtSize6_75': r(stated + (6.75 - hole_mmc)),
            'virtualCondition': r(hole_mmc - stated),
            'unit': 'mm',
        },
    ]


def main() -> None:
    data = {
        '$comment': 'Generated by generate_stackup_reference.py (derivations in its docstring). Do not edit by hand. '
                    'Expected values: analytic fields are exact (compare with abs tolerance 1e-9 mm); monteCarlo fields compare '
                    'with the listed acceptance tolerances (any seeded PRNG) or exactly when the same PRNG + Box-Muller is reproduced.',
        'stackups': [evaluate(case) for case in CASES],
        'fasteners': fastener_cases(),
    }
    with open(os.path.join(HERE, 'stackup_reference.json'), 'w', encoding='utf-8') as handle:
        json.dump(data, handle, indent=1)
        handle.write('\n')
    for s in data['stackups']:
        a, m = s['analytic'], s['monteCarlo']
        print(s['id'], a['yMean'], a['worstCase'], a['worstCaseExactCorners'], a['rss'], a['sigma'], a.get('pBelowLowerLimitNormalApprox'), m['mean'], m['std'], m.get('pBelowLowerLimit'))
    print(data['fasteners'])


if __name__ == '__main__':
    main()
