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
  readonly thermal?: {
    readonly rthWindingHousingKPerW: number;
    readonly rthHousingAmbientKPerW: number;
    readonly tauWindingS: number;
    readonly tauMotorS: number;
    readonly maxWindingC: number;
    readonly alphaPerK?: number;
  };
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

type DriveMode = 'voltage' | 'torque' | 'velocity' | 'position' | 'prescribed';

/** How a datasheet motor is commanded (key of `dynamics.drives` = the motor id). */
export interface MotorDrive {
  readonly id: string;
  readonly mode: DriveMode;
  /** voltage: constant terminal voltage, V. */
  readonly volts?: number;
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
