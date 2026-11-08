/** hertz_contact: Hertz contact half-width / radius, peak pressure and approach of sphere and cylinder pairs (PHY-06 FR-CNT-08). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { NOT_APPROVED, cntRemediation, refuseCnt } from './codes';
import { effectiveModulus, effectiveRadius, hertzLine, hertzPointApproach, hertzPointForce, subsurfaceShear } from './hertz';

const PAIRS = ['sphere_sphere', 'sphere_plane', 'cylinder_cylinder', 'cylinder_plane'] as const;
type Pair = (typeof PAIRS)[number];

const SOURCE = 'Hertz (1882) as stated in PHY-06 TECHNICAL_SPEC §5.2; generator validation/generate_cnt_reference.py';
const SUBSURFACE_SOURCE = 'Johnson, Contact Mechanics (1985) eq. 3.45 / plane-strain axis stresses — not fetched (grade B)';

const inputsSchema = z.object({
  pair: z
    .enum(PAIRS)
    .describe('Geometry: sphere_sphere, sphere_plane (ball on flat), cylinder_cylinder (parallel axes), cylinder_plane (roller on flat).'),
  R1_mm: z.number().describe('Radius of body 1, mm (> 0).'),
  R2_mm: z
    .number()
    .optional()
    .describe('Radius of body 2, mm (> 0); required for sphere_sphere / cylinder_cylinder, omitted for the plane pairs.'),
  E1_MPa: z.number().describe("Young's modulus of body 1, MPa (> 0)."),
  nu1: z.number().describe("Poisson's ratio of body 1, in (-1, 0.5]."),
  E2_MPa: z.number().describe("Young's modulus of body 2 (the plane for the plane pairs), MPa (> 0)."),
  nu2: z.number().describe("Poisson's ratio of body 2, in (-1, 0.5]."),
  load_N: z.number().optional().describe('Sphere pairs: normal force, N (> 0). Exactly one of load_N / approach_mm for spheres.'),
  loadPerLength_N_per_mm: z
    .number()
    .optional()
    .describe('Cylinder pairs (plane strain): normal force per unit length of contact, N/mm (> 0); required for cylinders.'),
  approach_mm: z.number().optional().describe('Sphere pairs: total approach of the two bodies (sum of both deformations), mm (> 0).'),
});

type Inputs = z.output<typeof inputsSchema>;

const positive = (value: number | undefined): boolean => value !== undefined && Number.isFinite(value) && value > 0;
const poisson = (nu: number): boolean => Number.isFinite(nu) && nu > -1 && nu <= 0.5;

/** First input problem of `inputs` as [message, path], or null. */
function inputProblem(inputs: Inputs): readonly [string, string] | null {
  const pair: Pair = inputs.pair;
  const twoBody = pair === 'sphere_sphere' || pair === 'cylinder_cylinder';
  const sphere = pair.startsWith('sphere');
  if (!positive(inputs.R1_mm)) return ['R1_mm must be > 0', 'inputs.R1_mm'];
  if (twoBody && !positive(inputs.R2_mm)) return [`${pair} needs R2_mm > 0`, 'inputs.R2_mm'];
  if (!twoBody && inputs.R2_mm !== undefined) return [`${pair} has a plane as body 2: omit R2_mm`, 'inputs.R2_mm'];
  if (!positive(inputs.E1_MPa) || !positive(inputs.E2_MPa)) return ['E1_MPa and E2_MPa must be > 0', 'inputs.E1_MPa'];
  if (!poisson(inputs.nu1) || !poisson(inputs.nu2)) return ['nu1 and nu2 must lie in (-1, 0.5]', 'inputs.nu1'];
  const given = (['load_N', 'loadPerLength_N_per_mm', 'approach_mm'] as const).filter((key) => inputs[key] !== undefined);
  const allowed = sphere ? ['load_N', 'approach_mm'] : ['loadPerLength_N_per_mm'];
  const wrong = given.find((key) => !allowed.includes(key));
  if (wrong !== undefined)
    return [`${pair} takes ${allowed.join(' or ')}, not ${wrong} (line contact under approach has no closed form here)`, `inputs.${wrong}`];
  if (given.length !== 1) return [`give exactly one of ${allowed.join(' / ')}`, `inputs.${allowed[0] ?? 'load_N'}`];
  const key = given[0] ?? 'load_N';
  if (!positive(inputs[key])) return [`${key} must be > 0`, `inputs.${key}`];
  return null;
}

const n = (value: number): string => significantNumber(value, 6);

/** Values, formulas and summary text of the load case the validated inputs give (exactly one load input is present). */
function evaluate(inputs: Inputs, R: number, Es: number): { values: Record<string, number>; formulas: string[]; text: string } {
  const { loadPerLength_N_per_mm: perLength, load_N: load, approach_mm: approach } = inputs;
  if (perLength !== undefined) {
    const line = hertzLine(perLength, R, Es);
    return {
      values: { halfWidth_mm: line.b, p0_MPa: line.p0 },
      formulas: ["b = sqrt(4 P' R / (pi E*))", "p0 = 2 P' / (pi b)"],
      text: `b ${n(line.b)} mm, p0 ${n(line.p0)} MPa`,
    };
  }
  const pointCase = (a: number, p0: number, delta: number, force: number, formulas: string[]): ReturnType<typeof evaluate> => ({
    values: { contactRadius_mm: a, p0_MPa: p0, approach_mm: delta, load_N: force },
    formulas,
    text: `a ${n(a)} mm, p0 ${n(p0)} MPa, approach ${n(delta)} mm, load ${n(force)} N`,
  });
  if (load !== undefined) {
    const found = hertzPointForce(load, R, Es);
    return pointCase(found.a, found.p0, found.approach, load, ['a = (3 P R / (4 E*))^(1/3)', 'p0 = 3 P / (2 pi a^2)', 'delta = a^2 / R']);
  }
  const delta = approach ?? Number.NaN;
  const found = hertzPointApproach(delta, R, Es);
  return pointCase(found.a, found.p0, delta, found.force, [
    'a = sqrt(R delta)',
    'p0 = (2 E* / pi) sqrt(delta / R)',
    'P = (4/3) E* sqrt(R) delta^1.5',
  ]);
}

/**
 * @invariant read-only and pure (reads no document); formulas and generator identical to 1e-9 (TR-CNT-20); subsurface values always
 *   `unverified: true` with CNT_SUBSURFACE_UNVERIFIED; every result `reviewRequired: true`
 * @failure non-positive radius / modulus, nu outside (-1, 0.5], R2_mm missing for a two-body pair or given for a plane pair, zero or two
 *   load inputs, or a load input the pair does not take -> CNT_HERTZ_INPUT_INVALID (refusal, unchanged doc)
 */
export const hertzContact = defineCommand({
  name: 'hertz_contact',
  description:
    'Hertz contact hand check (frictionless, elastic, small contact) for a sphere or cylinder on a sphere / cylinder / plane; pure, reads no ' +
    'document. Units are in the keys: mm, N, MPa. Spheres take load_N (force) or approach_mm (total approach); cylinders take ' +
    'loadPerLength_N_per_mm (plane strain, parallel axes). Returns data { pair, contact: point | line, Estar_MPa, R_mm, halfWidth_mm (line, ' +
    'b) or contactRadius_mm (point, a), p0_MPa (peak pressure), approach_mm and load_N (point), formulas, subsurface { tauMaxOverP0, ' +
    'depthOverHalfWidth, unverified: true } (on the axis in body 1; source not yet verified), items, reviewRequired }. Example SSNP154: ' +
    'cylinder_plane R1 50, E1 210000, E2 70000, nu 0.3, 35000 N/mm -> b 6.2146 mm, p0 3585.36 MPa. Compare with contact_report of an FE ' +
    'contact model (closedBox width / 2 and maxPressure).',
  annotations: { readOnly: true },
  params: z.object({ inputs: inputsSchema.describe('Geometry, materials and the load input (unit-suffixed keys).') }),
  run: (doc, { inputs }): CommandResult => {
    const bad = inputProblem(inputs);
    if (bad !== null) return refuseCnt(doc, 'hertz_contact', 'CNT_HERTZ_INPUT_INVALID', bad[0], [], [bad[1]]);
    const Es = effectiveModulus(inputs.E1_MPa, inputs.nu1, inputs.E2_MPa, inputs.nu2);
    const R = effectiveRadius(inputs.R1_mm, inputs.R2_mm);
    const point = inputs.pair.startsWith('sphere');
    const base = { pair: inputs.pair, contact: point ? 'point' : 'line', inputs, Estar_MPa: Es, R_mm: R };
    const { values, formulas, text } = evaluate(inputs, R, Es);
    const subsurface = { ...subsurfaceShear(point ? 'point' : 'line', inputs.nu1), unverified: true, source: SUBSURFACE_SOURCE };
    const item = {
      code: 'CNT_SUBSURFACE_UNVERIFIED',
      severity: 'warning',
      message: 'subsurface max shear and depth come from formulas whose source is not yet verified',
      remediation: cntRemediation('CNT_SUBSURFACE_UNVERIFIED'),
    };
    return report(
      doc,
      `hertz_contact: ${inputs.pair} E* ${n(Es)} MPa, R ${n(R)} mm: ${text}; subsurface tauMax/p0 ${n(subsurface.tauMaxOverP0)} (unverified). ${NOT_APPROVED}`,
      { ...base, ...values, formulas, source: SOURCE, subsurface, items: [item], reviewRequired: true },
    );
  },
});
