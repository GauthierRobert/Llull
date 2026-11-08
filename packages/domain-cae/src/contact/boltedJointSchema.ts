/** zod input of bolted_joint_check (PHY-06 §3 BoltedJointInput): every quantity `{ value, unit }`, every factor explicit. */

import { z } from '@core/commands/schema';

const q = (what: string): z.ZodObject<{ value: z.ZodNumber; unit: z.ZodString }> =>
  z.object({ value: z.number().describe('Numeric value.'), unit: z.string().describe(`Unit text, ${what}.`) });

const FORCE = "a force unit ('N', 'kN', 'lbf')";
const force = (what: string): ReturnType<typeof q> => q(FORCE).describe(what);
const optionalForce = (what: string): z.ZodOptional<ReturnType<typeof q>> => q(FORCE).optional().describe(what);

export const boltedJointParams = z.object({
  standard: z
    .literal('NASA-STD-5020 (2012)')
    .describe('Rule edition; only "NASA-STD-5020 (2012)" is implemented (a later edition is a new rule table).'),
  control: z
    .enum(['torque', 'turn', 'stretch'])
    .describe('Preload control method: torque (needs torque + nutFactor), turn or stretch (need preloadNominal).'),
  separationCritical: z
    .boolean()
    .describe('Joint whose separation is a failure (seals, stiffness-critical): needs a test-derived gamma (90/95), never the default.'),
  torque: z
    .object({
      nominal: q("a torque unit ('N*m', 'lbf*in')").describe('Specified installation torque (nominal).'),
      tolerance: q("a torque unit ('N*m', 'lbf*in')").describe(
        'Torque tolerance (+/-): Tmax = nominal + tolerance, Tmin = nominal - tolerance.',
      ),
      runningTorqueMax: q('a torque unit').optional().describe('Maximum running (prevailing) torque; required unless aboveRunning.'),
      breakawayMin: q('a torque unit').optional().describe('Minimum breakaway (prevailing) torque; required unless aboveRunning.'),
      aboveRunning: z
        .boolean()
        .describe(
          'true: the torque spec is above running torque (effective = spec); false: Tmax - breakawayMin, Tmin - runningTorqueMax (A.2-4..7).',
        ),
    })
    .optional()
    .describe('Torque specification (torque control).'),
  nutFactor: z
    .object({
      value: z.number().describe('Nut factor K (> 0), e.g. from torque-tension tests.'),
      source: z.string().min(1).describe('Where K comes from (test report, handbook).'),
      tested: z.boolean().describe('true when K comes from tests on this hardware; false flags every margin unverified.'),
    })
    .optional()
    .describe('Nut factor K for P = T / (K D); required for torque control, never defaulted.'),
  nominalDiameter: q("a length unit ('mm', 'in')").describe('Nominal bolt diameter D.'),
  preloadNominal: optionalForce('Nominal initial preload (turn / stretch control; replaces T / (K D)).'),
  gamma: z
    .object({
      value: z.number().describe('Preload variation, fraction (0 <= value < 1), e.g. 0.25.'),
      source: z.string().min(1).describe('Where it comes from (test report).'),
      statisticalBasis: z
        .literal('90/95')
        .optional()
        .describe('"90/95" when derived from tests at 90 % probability / 95 % confidence (§6.1.c).'),
    })
    .optional()
    .describe(
      'Preload variation Gamma; absent = the standard default by control (25 % / 35 % torque, 25 % turn, 10 % stretch), refused for separation-critical joints.',
    ),
  lubricated: z.boolean().describe('Lubricated threads (selects the 25 % torque-control default; false = 35 %).'),
  fastenerCount: z.number().int().describe('Number of fasteners n_f in the joint (>= 1).'),
  metallicJoint: z
    .boolean()
    .describe('All clamped parts metallic: short-term relaxation defaults to 5 % of the minimum initial preload (Table 1).'),
  relaxation: optionalForce('Short-term relaxation loss Ppr; required when metallicJoint is false (test value).'),
  creepLoss: optionalForce('Creep loss Ppc; absent = 0 (stated in assumptions).'),
  thermalIncrease: optionalForce('Preload increase from temperature PDt-max; absent = 0.'),
  thermalDecrease: optionalForce('Preload decrease from temperature PDt-min; absent = 0.'),
  stiffness: z
    .union([
      z.object({
        phi: z.number().describe('Joint stiffness factor phi = kb / (kb + kc), in (0, 1).'),
        source: z.string().min(1).describe('Where phi comes from.'),
      }),
      z.object({
        boltStiffness: q("a stiffness unit ('N/mm', 'lbf/in')").describe('Bolt stiffness kb.'),
        clampedStiffness: q("a stiffness unit ('N/mm', 'lbf/in')").describe('Clamped-parts stiffness kc.'),
      }),
    ])
    .describe('phi directly, or kb and kc (phi = kb / (kb + kc), eq. 6-8).'),
  loadingPlaneFactor: z
    .object({ value: z.number().describe('Loading-plane factor n, in (0, 1].'), source: z.string().min(1).describe('Where n comes from.') })
    .describe('Loading-plane factor n (no default).'),
  allowableTensile: force('Allowable ultimate tensile load of the fastener Ptu-allow.'),
  limitLoads: z
    .object({
      tensionPerFastener: force('Limit tensile load per fastener PtL (separation, ultimate).'),
      shearJoint: optionalForce('Limit shear load on the joint PsL-joint (slip, A.10-4 / A.10-5).'),
      tensionJoint: optionalForce('Limit tensile load on the joint PtL-joint (slip A.10-4; absent = A.10-5).'),
      shearPerFastener: optionalForce('Limit shear per fastener (slip A.10-6, used when shearJoint is absent).'),
    })
    .describe('Limit loads.'),
  factors: z
    .object({
      separation: z.number().describe('Separation factor of safety FS_sep (>= 1).'),
      ultimate: z.number().describe('Ultimate factor of safety FS_u (>= 1).'),
      slip: z.number().describe('Slip factor of safety FS_slip (>= 1).'),
      fitting: z.number().describe('Fitting factor FF (>= 1).'),
      source: z.string().min(1).describe('Programme document the factors come from.'),
    })
    .optional()
    .describe('Factors of safety and fitting factor: no defaults (CNT_FACTORS_UNSET when absent).'),
  friction: z
    .object({
      mu: z.number().describe('Friction coefficient of the faying surfaces (> 0).'),
      surface: z.enum(['uncoated_clean_metal', 'other']).describe('Surface class of the §6.4 cap: 0.2 clean uncoated metal, 0.1 other.'),
      testRecord: z
        .string()
        .min(1)
        .optional()
        .describe('Test substantiation of mu; without it mu above the cap fails and mu is unverified.'),
    })
    .optional()
    .describe('Friction of the shear path; absent = no slip check.'),
});

export type BoltedJointParams = z.output<typeof boltedJointParams>;
