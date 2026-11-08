/** bolted_joint_check: NASA-STD-5020 (2012) preload range, separation, slip and ultimate margins of a preloaded joint (PHY-06 FR-CNT-05/06). */

import { defineCommand } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { significantNumber } from '@lib/compactNumber';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { NOT_APPROVED, cntRemediation, refuseCnt } from './codes';
import { boltedJointParams, type BoltedJointParams } from './boltedJointSchema';
import { STANDARD, defaultGamma, evaluateJoint, frictionCap, type JointInput, type Named } from './nasa5020';

interface Item {
  readonly code: string;
  readonly severity: 'warning' | 'fail';
  readonly message: string;
  readonly path: string;
  readonly remediation: string;
}

const item = (code: string, severity: Item['severity'], message: string, path: string): Item => ({
  code,
  severity,
  message,
  path,
  remediation: cntRemediation(code),
});

class InputError {
  constructor(
    readonly code: string,
    readonly message: string,
    readonly path: string,
  ) {}
}

/** `quantity` in `unit`; throws InputError (caught in `run`) for a wrong unit or a non-finite value. */
function inUnit(quantity: { readonly value: number; readonly unit: string }, unit: string, path: string): number {
  const converted = convertValue(quantity.value, quantity.unit, unit);
  if (isUnitFailure(converted)) throw new InputError('CNT_INPUT_INVALID', `${path}: ${converted.message}`, path);
  if (!Number.isFinite(converted.value)) throw new InputError('CNT_INPUT_INVALID', `${path} must be finite`, path);
  return converted.value;
}

const optionalForce = (quantity: BoltedJointParams['creepLoss'], path: string): number | undefined =>
  quantity === undefined ? undefined : inUnit(quantity, 'N', path);

function ensure(ok: boolean, code: string, message: string, path: string): asserts ok {
  if (!ok) throw new InputError(code, message, path);
}

/** Preload basis of the control method (torque: effective torques A.2-4..7). */
function preloadBasis(params: BoltedJointParams): JointInput['preloadBasis'] {
  const diameterMm = inUnit(params.nominalDiameter, 'mm', 'nominalDiameter');
  ensure(diameterMm > 0, 'CNT_INPUT_INVALID', 'nominalDiameter must be > 0', 'nominalDiameter');
  if (params.control !== 'torque') {
    ensure(params.preloadNominal !== undefined, 'CNT_INPUT_INVALID', `${params.control} control needs preloadNominal`, 'preloadNominal');
    const nominal = inUnit(params.preloadNominal, 'N', 'preloadNominal');
    ensure(nominal > 0, 'CNT_INPUT_INVALID', 'preloadNominal must be > 0', 'preloadNominal');
    return { kind: 'preload', nominal };
  }
  const { torque, nutFactor } = params;
  ensure(torque !== undefined, 'CNT_INPUT_INVALID', 'torque control needs torque { nominal, tolerance, aboveRunning }', 'torque');
  ensure(
    nutFactor !== undefined && nutFactor.value > 0,
    'CNT_NUT_FACTOR_MISSING',
    'torque control needs nutFactor { value > 0, source, tested }',
    'nutFactor',
  );
  const nominal = inUnit(torque.nominal, 'N*m', 'torque.nominal');
  const tolerance = inUnit(torque.tolerance, 'N*m', 'torque.tolerance');
  let max = nominal + tolerance;
  let min = nominal - tolerance;
  if (!torque.aboveRunning) {
    ensure(
      torque.breakawayMin !== undefined && torque.runningTorqueMax !== undefined,
      'CNT_INPUT_INVALID',
      'aboveRunning false needs breakawayMin and runningTorqueMax',
      'torque.runningTorqueMax',
    );
    max -= torque.breakawayMin === undefined ? 0 : inUnit(torque.breakawayMin, 'N*m', 'torque.breakawayMin');
    min -= torque.runningTorqueMax === undefined ? 0 : inUnit(torque.runningTorqueMax, 'N*m', 'torque.runningTorqueMax');
  }
  ensure(nominal > 0 && tolerance >= 0 && min > 0, 'CNT_INPUT_INVALID', `effective torques must be > 0 (min ${min} N*m)`, 'torque');
  return { kind: 'torque', nominal, max, min, nutFactor: nutFactor.value, diameterMm };
}

/** Γ by the §6.1 policy: test data required for separation-critical joints, the named default otherwise. */
function gammaOf(params: BoltedJointParams): Named {
  const { gamma } = params;
  if (params.separationCritical)
    ensure(
      gamma !== undefined && gamma.statisticalBasis === '90/95',
      'CNT_GAMMA_TEST_DATA_REQUIRED',
      'a separation-critical joint needs gamma derived from torque-tension tests (statisticalBasis "90/95"); the standard default is not allowed',
      'gamma',
    );
  if (gamma === undefined) return defaultGamma(params.control, params.lubricated);
  ensure(gamma.value >= 0 && gamma.value < 1, 'CNT_INPUT_INVALID', 'gamma.value must lie in [0, 1)', 'gamma.value');
  return { value: gamma.value, source: gamma.source, defaulted: false };
}

/** Normalised joint input plus the named assumptions. */
function jointInput(params: BoltedJointParams): { readonly input: JointInput; readonly assumptions: string[] } {
  const preload = preloadBasis(params);
  const gamma = gammaOf(params);
  const { factors } = params;
  ensure(factors !== undefined, 'CNT_FACTORS_UNSET', 'factors of safety and fitting factor are not given (no defaults)', 'factors');
  const all = [factors.separation, factors.ultimate, factors.slip, factors.fitting];
  ensure(
    all.every((value) => Number.isFinite(value) && value >= 1),
    'CNT_INPUT_INVALID',
    'every factor must be >= 1',
    'factors',
  );
  ensure(
    Number.isInteger(params.fastenerCount) && params.fastenerCount >= 1,
    'CNT_INPUT_INVALID',
    'fastenerCount must be >= 1',
    'fastenerCount',
  );
  const relaxationForce = optionalForce(params.relaxation, 'relaxation');
  ensure(
    relaxationForce !== undefined || params.metallicJoint,
    'CNT_INPUT_INVALID',
    'non-metallic joints need the tested relaxation (Table 1)',
    'relaxation',
  );
  const relaxation: JointInput['relaxation'] =
    relaxationForce === undefined
      ? { kind: 'fraction', value: 0.05, source: 'NASA-STD-5020 Table 1 (all-metallic)', defaulted: true }
      : { kind: 'force', value: relaxationForce, source: 'input', defaulted: false };
  const stiffness = params.stiffness;
  const phi =
    'phi' in stiffness
      ? stiffness.phi
      : inUnit(stiffness.boltStiffness, 'N/mm', 'stiffness.boltStiffness') /
        (inUnit(stiffness.boltStiffness, 'N/mm', 'stiffness.boltStiffness') +
          inUnit(stiffness.clampedStiffness, 'N/mm', 'stiffness.clampedStiffness'));
  ensure(phi > 0 && phi < 1, 'CNT_INPUT_INVALID', 'phi must lie in (0, 1) (positive stiffnesses)', 'stiffness');
  const n = params.loadingPlaneFactor.value;
  ensure(n > 0 && n <= 1, 'CNT_INPUT_INVALID', 'loadingPlaneFactor.value must lie in (0, 1]', 'loadingPlaneFactor');
  const limits = params.limitLoads;
  const tensionPerFastener = inUnit(limits.tensionPerFastener, 'N', 'limitLoads.tensionPerFastener');
  ensure(tensionPerFastener > 0, 'CNT_INPUT_INVALID', 'limitLoads.tensionPerFastener must be > 0', 'limitLoads.tensionPerFastener');
  const mu = params.friction?.mu;
  ensure(mu === undefined || mu > 0, 'CNT_INPUT_INVALID', 'friction.mu must be > 0', 'friction.mu');
  const shearJoint = optionalForce(limits.shearJoint, 'limitLoads.shearJoint');
  const tensionJoint = optionalForce(limits.tensionJoint, 'limitLoads.tensionJoint');
  const shearPerFastener = optionalForce(limits.shearPerFastener, 'limitLoads.shearPerFastener');
  const creepLoss = optionalForce(params.creepLoss, 'creepLoss');
  const thermalIncrease = optionalForce(params.thermalIncrease, 'thermalIncrease');
  const thermalDecrease = optionalForce(params.thermalDecrease, 'thermalDecrease');
  const assumptions = [
    ...(creepLoss === undefined ? ['creep loss not given: 0'] : []),
    ...(thermalIncrease === undefined ? ['thermal preload increase not given: 0'] : []),
    ...(thermalDecrease === undefined ? ['thermal preload decrease not given: 0'] : []),
    ...(mu === undefined ? ['no friction given: no slip margin'] : []),
    'minimum preload for separation uses (1 - Gamma) Tmin / (K D) (eq. A.2-3a) for every joint (conservative)',
  ];
  return {
    assumptions,
    input: {
      preloadBasis: preload,
      gamma,
      fastenerCount: params.fastenerCount,
      relaxation,
      creepLoss: creepLoss ?? 0,
      thermalIncrease: thermalIncrease ?? 0,
      thermalDecrease: thermalDecrease ?? 0,
      phi,
      loadingPlaneFactor: n,
      allowableTensile: inUnit(params.allowableTensile, 'N', 'allowableTensile'),
      limitLoads: {
        tensionPerFastener,
        ...(shearJoint !== undefined ? { shearJoint } : {}),
        ...(tensionJoint !== undefined ? { tensionJoint } : {}),
        ...(shearPerFastener !== undefined ? { shearPerFastener } : {}),
      },
      factors,
      ...(mu !== undefined ? { mu } : {}),
    },
  };
}

function check(doc: CadDocument, params: BoltedJointParams): CommandResult {
  const { input, assumptions } = jointInput(params);
  const result = evaluateJoint(input);
  const items: Item[] = [];
  if (input.gamma.defaulted)
    items.push(item('CNT_DEFAULT_GAMMA_USED', 'warning', `Gamma ${input.gamma.value} defaulted from ${input.gamma.source}`, 'gamma'));
  const friction = params.friction;
  if (friction !== undefined && friction.testRecord === undefined && friction.mu > frictionCap(friction.surface))
    items.push(
      item(
        'CNT_FRICTION_ABOVE_CAP',
        'fail',
        `mu ${friction.mu} exceeds the ${frictionCap(friction.surface)} cap for ${friction.surface} without a test record (§6.4)`,
        'friction.mu',
      ),
    );
  if (result.linearTheory.separationBeforeRupture)
    items.push(
      item(
        'CNT_ULTIMATE_MARGIN_PENDING',
        'warning',
        'the joint separates before rupture: the ultimate margin needs eq. 6-6 (not transcribed)',
        'factors.ultimate',
      ),
    );
  for (const margin of result.margins)
    if (margin.ms < 0)
      items.push(
        item(
          'CNT_MS_NEGATIVE',
          'fail',
          `${margin.criterion} margin ${significantNumber(margin.ms, 4)} < 0 (eq. ${margin.equation})`,
          margin.criterion,
        ),
      );
  const unverifiedReasons = [
    ...(params.nutFactor !== undefined && params.control === 'torque' && !params.nutFactor.tested
      ? ['nut factor without test record']
      : []),
    ...(friction !== undefined && friction.testRecord === undefined ? ['friction coefficient without test record'] : []),
    ...(input.gamma.defaulted ? ['preload variation Gamma from the standard default, not from tests'] : []),
  ];
  const unverified = unverifiedReasons.length > 0;
  const status = items.some((entry) => entry.severity === 'fail') ? 'fail' : 'pass';
  const n = (value: number): string => significantNumber(value, 4);
  const margins = result.margins.map((margin) => ({ ...margin, unverified }));
  const text = margins.map((margin) => `${margin.criterion} MS ${n(margin.ms)}`).join(', ');
  const relaxation = input.relaxation;
  return report(
    doc,
    `bolted_joint_check (${STANDARD}): ${status}; preload ${n(result.preload.minSeparationN)}..${n(result.preload.maxN)} N (slip min ${n(result.preload.minSlipN)} N); ${text}; Gamma ${input.gamma.value}${input.gamma.defaulted ? ' (defaulted)' : ''}${unverified ? '; UNVERIFIED' : ''}${items.length > 0 ? `; ${items.map((entry) => entry.code).join(', ')}` : ''}. ${NOT_APPROVED}`,
    {
      standard: STANDARD,
      units: { force: 'N', torque: 'N*m', length: 'mm' },
      preload: {
        ...result.preload,
        gamma: input.gamma,
        relaxation: { kind: relaxation.kind, value: relaxation.value, source: relaxation.source, defaulted: relaxation.defaulted },
      },
      linearTheory: result.linearTheory,
      margins,
      status,
      items,
      assumptions,
      equations: {
        nominal: 'A.2-1',
        max: 'A.2-2, 6-2, 6-4',
        minSeparation: 'A.2-3a, 6-3, 6-5a',
        minSlip: 'A.2-3b, 6-3, 6-5b',
        phi: '6-8',
        PtuPrime: '6-9',
        PsepPrime: '6-10',
      },
      unverified,
      unverifiedReasons,
      reviewRequired: true,
    },
  );
}

/**
 * @invariant read-only and pure; equations identical to the generator to 1e-9 (TR-CNT-20); the edition is in every result (TR-CNT-30);
 *   Γ / relaxation defaults are named with `defaulted: true`; status fail on a negative margin or a friction coefficient above the §6.4 cap
 *   without a test record; every result `reviewRequired: true`
 * @failure separation-critical without a 90/95 test Γ -> CNT_GAMMA_TEST_DATA_REQUIRED; torque control without nut factor ->
 *   CNT_NUT_FACTOR_MISSING; no factors -> CNT_FACTORS_UNSET; missing / invalid input or unit -> CNT_INPUT_INVALID (refusals, unchanged doc)
 */
export const boltedJointCheck = defineCommand({
  name: 'bolted_joint_check',
  description:
    'Preload range, separation, slip and ultimate margins of a preloaded threaded joint with the NASA-STD-5020 (2012) equations; pure, reads ' +
    'no document. Quantities are { value, unit } (forces N / kN / lbf, torque N*m / lbf*in, lengths mm / in, stiffness N/mm); results in N. ' +
    'Torque control needs torque { nominal, tolerance, aboveRunning } and nutFactor { value, source, tested } (no default); turn / stretch ' +
    'need preloadNominal. Needs stiffness (phi or kb + kc), loadingPlaneFactor n, allowableTensile, limitLoads.tensionPerFastener and factors ' +
    '{ separation, ultimate, slip, fitting, source } (no defaults). Gamma defaults to the standard 25 % (lubricated) / 35 % (torque), 25 % ' +
    '(turn), 10 % (stretch) only for non-separation-critical joints, reported defaulted with CNT_DEFAULT_GAMMA_USED; separation-critical ' +
    'joints without a 90/95 test Gamma are refused. Relaxation defaults to 5 % for all-metallic joints (Table 1). friction { mu, surface } ' +
    'adds the slip margin (A.10-4 with limitLoads.shearJoint + tensionJoint, A.10-5 without tension, A.10-6 per fastener); mu above 0.2 ' +
    '(clean uncoated metal) / 0.1 without testRecord fails. Returns data { standard, preload { nominalN, maxN, minSeparationN, minSlipN, ' +
    'gamma, relaxation }, linearTheory { nPhi, PsepPrimeN, PtuPrimeN, separationBeforeRupture }, margins [{ criterion, ms, equation, ' +
    'unverified }], status pass | fail, items, assumptions, unverified, reviewRequired }. Next: the FE route (add_contact_pair).',
  annotations: { readOnly: true },
  params: boltedJointParams,
  run: (doc, params): CommandResult => {
    try {
      return check(doc, params);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      return refuseCnt(doc, 'bolted_joint_check', error.code, error.message, [], [error.path]);
    }
  },
});
