/** NASA-STD-5020 (2012) preload, separation, slip and ultimate equations (PHY-06 §5.3), as validation/generate_cnt_reference.py. N, N*m, mm. */

export const STANDARD = 'NASA-STD-5020 (2012)';

/** A value with where it came from; `defaulted` = a named default of the standard (AF-31). */
export interface Named {
  readonly value: number;
  readonly source: string;
  readonly defaulted: boolean;
}

/** Inputs normalised to N, N*m, mm, N/mm (the command converts units and applies the policy). */
export interface JointInput {
  /** Torque control: effective torques and K D in metres; otherwise the nominal preload. */
  readonly preloadBasis:
    | {
        readonly kind: 'torque';
        readonly nominal: number;
        readonly max: number;
        readonly min: number;
        readonly nutFactor: number;
        readonly diameterMm: number;
      }
    | { readonly kind: 'preload'; readonly nominal: number };
  readonly gamma: Named;
  readonly fastenerCount: number;
  /** Short-term relaxation: a fraction of each minimum initial preload (Table 1) or a force. */
  readonly relaxation: (Named & { readonly kind: 'fraction' }) | (Named & { readonly kind: 'force' });
  readonly creepLoss: number;
  readonly thermalIncrease: number;
  readonly thermalDecrease: number;
  readonly phi: number;
  readonly loadingPlaneFactor: number;
  readonly allowableTensile: number;
  readonly limitLoads: {
    readonly tensionPerFastener: number;
    readonly shearJoint?: number;
    readonly tensionJoint?: number;
    readonly shearPerFastener?: number;
  };
  readonly factors: { readonly separation: number; readonly ultimate: number; readonly slip: number; readonly fitting: number };
  readonly mu?: number;
}

interface JointMargin {
  readonly criterion: 'joint_separation' | 'joint_slip' | 'fastener_ultimate';
  readonly ms: number;
  readonly equation: string;
}

export interface JointResult {
  readonly preload: {
    readonly nominalN: number;
    readonly initialMaxN: number;
    readonly initialMinSeparationN: number;
    readonly initialMinSlipN: number;
    readonly maxN: number;
    readonly minSeparationN: number;
    readonly minSlipN: number;
  };
  readonly linearTheory: {
    readonly phi: number;
    readonly nPhi: number;
    readonly PsepPrimeN: number;
    readonly PtuPrimeN: number;
    readonly separationBeforeRupture: boolean;
  };
  readonly margins: readonly JointMargin[];
}

/** Preload, linear-theory and margin values of one joint. */
export function evaluateJoint(input: JointInput): JointResult {
  const basis = input.preloadBasis;
  const G = input.gamma.value;
  const nf = input.fastenerCount;
  const KD = basis.kind === 'torque' ? (basis.nutFactor * basis.diameterMm) / 1000 : 1;
  const nominal = basis.kind === 'torque' ? basis.nominal / KD : basis.nominal;
  const top = basis.kind === 'torque' ? basis.max : basis.nominal;
  const bottom = basis.kind === 'torque' ? basis.min : basis.nominal;
  const initialMax = ((1 + G) * top) / KD;
  const initialMinSeparation = ((1 - G) * bottom) / KD;
  const initialMinSlip = ((1 - G / nf) * bottom) / KD;
  const relaxation = (ppi: number): number =>
    input.relaxation.kind === 'fraction' ? input.relaxation.value * ppi : input.relaxation.value;
  const minimum = (ppi: number): number => ppi - relaxation(ppi) - input.creepLoss - input.thermalDecrease;
  const max = initialMax + input.thermalIncrease;
  const minSeparation = minimum(initialMinSeparation);
  const minSlip = minimum(initialMinSlip);
  const nPhi = input.loadingPlaneFactor * input.phi;
  const PtuPrime = (input.allowableTensile - max) / nPhi;
  const PsepPrime = max / (1 - nPhi);
  const { factors, limitLoads } = input;
  const margins: JointMargin[] = [
    {
      criterion: 'joint_separation',
      ms: minSeparation / (factors.fitting * factors.separation * limitLoads.tensionPerFastener) - 1,
      equation: '6-23',
    },
  ];
  if (PsepPrime >= PtuPrime)
    margins.push({
      criterion: 'fastener_ultimate',
      ms: PtuPrime / (factors.fitting * factors.ultimate * limitLoads.tensionPerFastener) - 1,
      equation: '6-11',
    });
  const mu = input.mu;
  if (mu !== undefined && limitLoads.shearJoint !== undefined) {
    const tension = limitLoads.tensionJoint;
    margins.push({
      criterion: 'joint_slip',
      ms: (nf * mu * minSlip) / (factors.slip * (tension === undefined ? limitLoads.shearJoint : limitLoads.shearJoint + mu * tension)) - 1,
      equation: tension === undefined ? 'A.10-5' : 'A.10-4',
    });
  } else if (mu !== undefined && limitLoads.shearPerFastener !== undefined)
    margins.push({
      criterion: 'joint_slip',
      ms: (mu * minSlip) / (factors.slip * (limitLoads.shearPerFastener + mu * limitLoads.tensionPerFastener)) - 1,
      equation: 'A.10-6',
    });
  return {
    preload: {
      nominalN: nominal,
      initialMaxN: initialMax,
      initialMinSeparationN: initialMinSeparation,
      initialMinSlipN: initialMinSlip,
      maxN: max,
      minSeparationN: minSeparation,
      minSlipN: minSlip,
    },
    linearTheory: { phi: input.phi, nPhi, PsepPrimeN: PsepPrime, PtuPrimeN: PtuPrime, separationBeforeRupture: PsepPrime < PtuPrime },
    margins,
  };
}

/** Γ the standard applies when no test data is given (§6.1.d), by control method. */
export function defaultGamma(control: 'torque' | 'turn' | 'stretch', lubricated: boolean): Named {
  if (control === 'torque')
    return lubricated
      ? { value: 0.25, source: 'NASA-STD-5020 6.1.d(1)A', defaulted: true }
      : { value: 0.35, source: 'NASA-STD-5020 6.1.d(1)A (non-lubricated / as received)', defaulted: true };
  if (control === 'turn') return { value: 0.25, source: 'NASA-STD-5020 6.1.d(2)A', defaulted: true };
  return { value: 0.1, source: 'NASA-STD-5020 6.1.d(3)A', defaulted: true };
}

/** Highest friction coefficient allowed without test substantiation (§6.4). */
export const frictionCap = (surface: 'uncoated_clean_metal' | 'other'): number => (surface === 'uncoated_clean_metal' ? 0.2 : 0.1);
