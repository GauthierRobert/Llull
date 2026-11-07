/**
 * Drive data of `CadDocument.dynamics` (PHY-23): where a parameter comes from, datasheet motors, motor drives and time profiles.
 * SI units (V, A, Ω, H, N·m, kg·m², s); profile values are stored in their stated `unit` and converted once when a run is built.
 */

type SourceGrade = 'A' | 'B' | 'C';

export interface ParameterSource {
  readonly name: string;
  readonly url?: string;
  /** A: exact derivation or a primary source read. B: one secondary source. C: assumed or unchecked. */
  readonly grade: SourceGrade;
}

/** Two-node thermal data of a datasheet motor (TR-DRV-09); the winding heats with the copper loss of its kind. */
export interface ThermalSheet {
  readonly rthWindingHousingKPerW: number;
  readonly rthHousingAmbientKPerW: number;
  readonly tauWindingS: number;
  readonly tauMotorS: number;
  readonly maxWindingC: number;
  readonly alphaPerK?: number;
}

/** A DC motor datasheet; the base fields drive the model, the optional ones only feed `check_motor_data`. */
export interface DcMotorDatasheet {
  readonly nominalVoltageV: number;
  readonly terminalResistanceOhm: number;
  readonly torqueConstantNmPerA: number;
  readonly rotorInertiaKgM2: number;
  readonly terminalInductanceH?: number;
  readonly noLoadCurrentA?: number;
  readonly nominalCurrentA?: number;
  readonly stallTorqueNm?: number;
  readonly stallCurrentA?: number;
  readonly noLoadSpeedRpm?: number;
  readonly speedConstantRpmPerV?: number;
  readonly speedTorqueGradientRpmPerMNm?: number;
  readonly mechanicalTimeConstantS?: number;
  readonly maxSpeedRpm?: number;
  readonly peakCurrentA?: number;
  readonly thermal?: ThermalSheet;
}

/** Gearhead between the motor shaft and the driven joint: joint speed = motor speed / ratio. */
export interface Gearhead {
  readonly ratio: number;
  /** Forward efficiency in (0, 1]: the share of the motor shaft power that reaches the joint. */
  readonly efficiency: number;
  /** Efficiency when the joint drives the motor; default = `efficiency`. */
  readonly efficiencyBack?: number;
  /** Gearhead inertia about its input shaft, kg·m². */
  readonly inertiaKgM2?: number;
}

export interface DcMotor {
  readonly id: string;
  readonly kind: 'dc';
  readonly joint: string;
  readonly datasheet: DcMotorDatasheet;
  readonly gearhead?: Gearhead;
  readonly source: ParameterSource;
  /** Why an inconsistent datasheet was accepted; the motor's results are then unverified. */
  readonly acceptInconsistent?: string;
}

/**
 * A permanent-magnet synchronous (PMSM / BLDC) motor with ideal field-oriented control (TR-DRV-07), surface magnets (L_d = L_q = L).
 * Phase quantities are amplitudes (amplitude-invariant dq transform): T = 1.5·p·λ·i_q. Give the flux linkage `fluxLinkageWb` or the torque constant
 * `torqueConstantNmPerA` = 1.5·p·λ (N·m per A of phase-current amplitude), or both (checked against each other).
 */
export interface PmsmDatasheet {
  readonly polePairs: number;
  readonly phaseResistanceOhm: number;
  readonly inductanceH: number;
  readonly fluxLinkageWb?: number;
  readonly torqueConstantNmPerA?: number;
  readonly rotorInertiaKgM2: number;
  /** DC bus voltage, V: the phase-voltage limit is V_bus/√3 (space-vector modulation). */
  readonly busVoltageV: number;
  /** Largest phase-current amplitude the drive commands, A. */
  readonly peakCurrentA: number;
  readonly nominalCurrentA?: number;
  readonly maxSpeedRpm?: number;
  /** Coulomb friction of the rotor, N·m at the motor shaft. */
  readonly frictionNm?: number;
  readonly peakTorqueNm?: number;
  readonly noLoadSpeedRpm?: number;
  readonly thermal?: ThermalSheet;
}

/** A two-phase hybrid stepper (TR-DRV-08): `stepsPerRev` full steps, rotor teeth N_r = stepsPerRev / 4. */
export interface StepperDatasheet {
  readonly stepsPerRev: number;
  readonly holdingTorqueNm: number;
  readonly ratedCurrentA: number;
  readonly phaseResistanceOhm: number;
  readonly phaseInductanceH: number;
  readonly rotorInertiaKgM2: number;
  /** Peak detent (cogging) torque, N·m. */
  readonly detentTorqueNm?: number;
  /** Pull-out torque [rpm, N·m] from the datasheet curve (rpm strictly increasing, torque >= 0); without it the L/R roll-off is used. */
  readonly pullOutCurve?: readonly (readonly [number, number])[];
  /** Viscous damping of the rotor, N·m·s/rad. */
  readonly dampingNmsPerRad?: number;
  readonly stepAngleDeg?: number;
  readonly ratedVoltageV?: number;
  readonly maxSpeedRpm?: number;
  readonly thermal?: ThermalSheet;
}

/** An induction motor as its per-phase equivalent circuit (TR-DRV-08): stator and rotor (referred) resistances and leakage reactances at the rated frequency. */
export interface InductionDatasheet {
  readonly polePairs: number;
  /** Rated phase voltage, V RMS. */
  readonly ratedVoltageV: number;
  readonly ratedFrequencyHz: number;
  readonly statorResistanceOhm: number;
  readonly rotorResistanceOhm: number;
  readonly statorLeakageReactanceOhm: number;
  readonly rotorLeakageReactanceOhm: number;
  /** Magnetising reactance, ohm: sets the magnetising current of the supply (not the torque: the branch sits at the terminals). */
  readonly magnetisingReactanceOhm: number;
  /** Iron-loss resistance in parallel with the magnetising branch, ohm: iron loss 3·V²/R_c. Absent = no iron loss. */
  readonly ironLossResistanceOhm?: number;
  readonly rotorInertiaKgM2: number;
  readonly frictionNm?: number;
  /** Rated load current of the circuit, A RMS. */
  readonly nominalCurrentA?: number;
  readonly peakCurrentA?: number;
  readonly maxSpeedRpm?: number;
  readonly breakdownTorqueNm?: number;
  readonly breakdownSlip?: number;
  readonly startingTorqueNm?: number;
  readonly thermal?: ThermalSheet;
}

interface DatasheetMotorBase {
  readonly id: string;
  readonly joint: string;
  readonly gearhead?: Gearhead;
  readonly source: ParameterSource;
  /** Why an inconsistent datasheet was accepted; the motor's results are then unverified. */
  readonly acceptInconsistent?: string;
}

export interface PmsmMotor extends DatasheetMotorBase {
  readonly kind: 'pmsm';
  readonly datasheet: PmsmDatasheet;
}

export interface StepperMotor extends DatasheetMotorBase {
  readonly kind: 'stepper';
  readonly datasheet: StepperDatasheet;
}

export interface InductionMotor extends DatasheetMotorBase {
  readonly kind: 'induction';
  readonly datasheet: InductionDatasheet;
}

/** Every motor kind that has a datasheet, a gearhead, a drive and a ledger (PHY-23). */
export type DatasheetMotor = DcMotor | PmsmMotor | StepperMotor | InductionMotor;

export const DATASHEET_KINDS = ['dc', 'pmsm', 'stepper', 'induction'] as const;

export type ProfileLaw = 'linear' | 'trapezoid' | 's_curve' | 'cycloidal' | 'poly345' | 'modified_sine' | 'modified_trapezoid' | 'harmonic';

export type ProfileSegment =
  | { readonly kind: 'dwell'; readonly duration: number }
  | {
      readonly kind: 'move';
      readonly law: ProfileLaw;
      readonly to: number;
      readonly duration?: number;
      readonly vmax?: number;
      readonly amax?: number;
      readonly jerk?: number;
      readonly accelFraction?: number;
    }
  | { readonly kind: 'sine'; readonly amplitude: number; readonly frequencyHz: number; readonly cycles: number; readonly phaseDeg?: number }
  | {
      readonly kind: 'table';
      /** [time s from the segment start, value]; first time 0, strictly increasing. */
      readonly points: readonly (readonly [number, number])[];
      readonly interpolation: 'linear' | 'monotone_cubic';
    };

export type ProfileQuantity = 'position' | 'velocity' | 'torque' | 'force' | 'voltage' | 'frequency';

export interface MotionProfile {
  readonly id: string;
  readonly quantity: ProfileQuantity;
  /** Unit of the values (deg, rad, rev, m, mm for a position; rpm, rad/s, deg/s, m/s, mm/s for a velocity; N·m; N; V; Hz). */
  readonly unit: string;
  /** Value at t = 0; default 0 (the first value of a leading table). */
  readonly start?: number;
  readonly segments: readonly ProfileSegment[];
  /** Whole repeats of the segment list (default 1). */
  readonly repeat?: number;
  /** Accept a jump of the value or of a position profile's velocity between segments. */
  readonly allowStep?: boolean;
}

export type DriveMode = 'voltage' | 'torque' | 'velocity' | 'position' | 'prescribed' | 'frequency';

/**
 * Drive modes a motor kind accepts (D-DRV-M4-01). dc: every mode but frequency. pmsm: field-oriented torque command from a profile or a loop (no terminal voltage
 * to give). stepper: open-loop step command (velocity: step rate, position: step position). induction: a supply (voltage and frequency: line / DOL, or a
 * frequency profile with constant V/f).
 */
export const DRIVE_MODES_BY_KIND: Readonly<Record<(typeof DATASHEET_KINDS)[number], readonly DriveMode[]>> = {
  dc: ['voltage', 'torque', 'velocity', 'position', 'prescribed'],
  pmsm: ['torque', 'velocity', 'position', 'prescribed'],
  stepper: ['velocity', 'position'],
  induction: ['voltage', 'frequency'],
};

/** How a datasheet motor is commanded (key of `dynamics.drives` = the motor id). */
export interface MotorDrive {
  readonly id: string;
  readonly mode: DriveMode;
  /** voltage: constant terminal voltage, V. */
  readonly volts?: number;
  /** induction voltage mode: supply frequency, Hz (line frequency for a direct-on-line start). */
  readonly frequencyHz?: number;
  /** stepper: steps per full step (1 full, 2 half, n micro-stepping); default 1. */
  readonly stepDivision?: number;
  /** Profile id: voltage (V), torque (N·m at the motor shaft), velocity, position or the prescribed motion. */
  readonly profile?: string;
  /** Current limit, A; default the motor's peak current, else nominal voltage / R. */
  readonly currentLimitA?: number;
  /** Joint the controller measures; default the motor's joint. */
  readonly target?: string;
  readonly gains?: { readonly kp: number; readonly ki: number; readonly kpPosition: number };
  readonly tune?: { readonly bandwidthHz: number; readonly dampingRatio: number };
  readonly feedforward?: boolean;
  readonly busVoltageV?: number;
  /** Controller sample rate, Hz. */
  readonly sampleHz?: number;
  /** prescribed: largest torque, N·m at the joint; default the motor's peak. */
  readonly effortLimit?: number;
}

/** What a stored reference series measures; the target is a joint id, a motor id or (ledger_energy) a ledger element name. */
export const SERIES_QUANTITIES = [
  'joint_position',
  'joint_velocity',
  'motor_current',
  'motor_voltage',
  'motor_torque',
  'motor_speed',
  'ledger_energy',
] as const;
/** Most points over all the reference series of one document (5 series of the per-series maximum): a document is read whole, so the sum is bounded too. */
export const MAX_TOTAL_POINTS = 500_000;
export type SeriesQuantity = (typeof SERIES_QUANTITIES)[number];

/**
 * Measured or datasheet time series a run is compared with (`add_reference_data` with `series`, `compare_to_reference`, `check_motion_truth`).
 * SI units: rad, m, rad/s, m/s, A, V, N·m (joint torque), rad/s (motor shaft speed), J (cumulative energy of a ledger element at the end of the run).
 * @invariant times strictly increasing and >= 0, same length as values, 1..100000 points; a ledger_energy series has exactly one point
 */
export interface ReferenceSeries {
  readonly id: string;
  readonly quantity: SeriesQuantity;
  readonly target: string;
  readonly times: readonly number[];
  readonly values: readonly number[];
  readonly source: ParameterSource;
  /** 1 sigma of one reading, same unit as the values; absent = unknown (listed, never taken as 0). */
  readonly uncertainty?: number;
  /** Relative pass band of the RMS error against the largest |value|; default 0.05. */
  readonly bandRel?: number;
}
