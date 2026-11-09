/** PHY-06 §7.1 stable codes of the contact lane and their remediation texts. */

import { tableRejection } from '@core/commands/noop';
import { nlsRemediation } from '../nonlinear/codes';

const REMEDIATION: Readonly<Record<string, string>> = {
  CNT_FORMULATION_UNSET: 'the first pair of a case fixes the formulation: pass formulation node_to_surface, surface_to_surface or mortar',
  CNT_MIXED_CONTACT_TYPES: 'use one formulation per analysis (CalculiX rule): omit formulation or repeat the one of the first pair',
  CNT_BEHAVIOUR_FORMULATION_MISMATCH:
    'tied needs surface_to_surface; smallSliding needs node_to_surface: change the formulation or the behaviour',
  CNT_SELF_PAIR: 'pick distinct faces for slave and master',
  CNT_FRICTION_INVALID:
    'mu and every slope must be finite and > 0; tied pairs take no friction (their stick slope is behaviour.stickSlope)',
  CNT_BEHAVIOUR_INVALID: 'slopes, p0 and c0 must be finite and > 0 (tensionAtLargeClearance > 0 when given)',
  CNT_ADJUST_INVALID: 'adjust clearance must be finite and > 0 (document length units)',
  CNT_STEP_UNKNOWN: 'activeSteps may only name step ids of the case (add_analysis_step; list them with describe_analysis)',
  CNT_PRELOAD_INVALID: 'preload.value, torque and diameter must be finite and > 0',
  CNT_PRETENSION_SECTION_INVALID:
    'move the section plane to a plain shank region that the bolt crosses exactly once and that holds no constraint, load or probe node',
  CNT_PRETENSION_STEP_ORDER:
    'the preload belongs to the first step of the case (before it the section is an open cut): add the preload step first, or use that step',
  CNT_PRETENSION_NOT_FOUND: 'list the bolts with contact_report (bolts) or describe_analysis',
  CNT_SEPARATED: 'raise the preload or redesign the joint; a reviewer decides',
  CNT_PRELOAD_MISMATCH:
    'the section force after the preload step should equal the preload: check the plane (one clean cut), the mesh and that the deck was written by the current llull',
  CNT_STACK_NOT_FOUND:
    'place the stack first (insert_fastener / insert_fastener_row) and pass its fst-<step>.<k> id; its plates must still be entities of the document',
  CNT_PAIR_NOT_FOUND: 'list the pairs with contact_report (no pair) or describe_analysis',
  CNT_PAIR_NAME_TAKEN: 'give the pair a name no other pair of the case uses',
  CNT_NOTHING_TO_UPDATE: 'give at least one field to change',
  CNT_INITIAL_OVERCLOSURE: 'set adjust (a clearance) or fix the geometry so the slave faces do not start inside the master',
  CNT_RIGID_BODY_BY_CONTACT_ONLY: 'add a weak support or a displacement-controlled first step to the part held only by contact',
  CNT_CONTACT_NOT_CONVERGED: 'smaller increments, set adjust, check the pair orientation (slave = the finer / softer side)',
  CNT_PENETRATION_EXCESSIVE: 'raise the penalty slope or use mortar',
  CNT_PENETRATION_TOLERANCE_UNSET: 'pass penetrationTolerance { value, source } (document length units) to check_contact',
  CNT_SLIP: 'raise the preload or the friction path, or add shear pins; a reviewer decides',
  CNT_CONTACT_RESULTS_MISSING:
    'the results hold no CONTACT block: re-mesh and re-solve with the current llull (the deck requests *CONTACT FILE)',
  CNT_HERTZ_INPUT_INVALID:
    'see the hertz_contact description: positive radii and moduli, nu in (-1, 0.5], exactly one load input for the pair',
  CNT_LAME_INPUT_INVALID:
    'radii 0 <= inner.innerRadius < inner.outerRadius < outer.outerRadius, moduli > 0, nu in (-1, 0.5), interference > 0',
  CNT_INPUT_INVALID: 'see the bolted_joint_check description for the inputs each control method needs',
  CNT_NUT_FACTOR_MISSING:
    'give the tested nut factor with its source (bolted_joint_check: nutFactor { value, source, tested }; add_bolt_pretension: nutFactor and nutFactorSource)',
  CNT_GAMMA_TEST_DATA_REQUIRED:
    'separation-critical joints need a test-derived preload variation: gamma { value, source, statisticalBasis "90/95" } (§6.1.b/c)',
  CNT_DEFAULT_GAMMA_USED: 'supply torque-tension test data when available',
  CNT_FRICTION_ABOVE_CAP: 'use the cap (0.2 clean uncoated metal, 0.1 other surfaces) or a test-substantiated value (friction.testRecord)',
  CNT_FACTORS_UNSET:
    'ask the owner / programme for the factors of safety and the fitting factor (factors { separation, ultimate, slip, fitting, source })',
  CNT_MS_NEGATIVE: 'redesign; only a qualified reviewer can disposition a negative margin (05 dispose_margin)',
  CNT_ULTIMATE_MARGIN_PENDING:
    'the joint separates before rupture: eq. 6-6 is not transcribed yet (§11 q5); check the ultimate case by hand',
  CNT_SUBSURFACE_UNVERIFIED: 'the subsurface formula source (Johnson 1985) is not yet verified: treat tauMax and its depth as indicative',
};

/** Remediation of a contact code (falls back to the nonlinear / 05 table). */
export const cntRemediation = (code: string): string => REMEDIATION[code] ?? nlsRemediation(code);

/** Coded rejection with the remediation registered for `code`. */
export const refuseCnt = tableRejection(REMEDIATION, nlsRemediation);

/** AF-33 sentence every contact / joint result carries. */
export const NOT_APPROVED = 'Computed by llull, not approved — needs a qualified engineer.';
