/**
 * PHY-09 structural dynamics beyond modal (plugin `cae`, docs/physics/09-structural-dynamics): the dynamic set-up of a
 * `frequency_response` / `random_response` case (`AnalysisCase.dynamics`), the spectrum / time-history library shared by cases
 * (`AnalysisModel.vibration`) and the dynamic part of a results summary (`ResultsSummary.dynamics`). Pure JSON data.
 * @invariant frequencies in Hz, times in s, ASD levels in the spectrum unit (g^2/Hz with g = 9.80665 m/s^2, or (m/s^2)^2/Hz)
 */

import type { Vec3 } from './vectors';

export type DynamicAnalysisType = 'frequency_response' | 'random_response';

export type SourceGrade = 'A' | 'B' | 'C';

export interface DynamicSource {
  readonly citation: string;
  readonly grade?: SourceGrade;
  readonly url?: string;
}

/** Exactly one damping model per case; there is no default damping (AF-31). */
export type DampingModel =
  | {
      readonly model: 'modal';
      readonly ratios: readonly { readonly fromMode: number; readonly toMode: number; readonly zeta: number }[];
      readonly source: DynamicSource;
    }
  | { readonly model: 'rayleigh'; readonly alpha: number; readonly beta: number; readonly source: DynamicSource }
  | {
      readonly model: 'rayleigh_from_ratios';
      readonly f1Hz: number;
      readonly f2Hz: number;
      readonly zeta1: number;
      readonly zeta2: number;
      /** Resolved at command time (1/s and s) and stored beside the inputs. */
      readonly alpha: number;
      readonly beta: number;
      readonly source: DynamicSource;
    }
  | { readonly model: 'structural_material'; readonly propertyName: 'structuralLossFactor' };

/** CalculiX `*STEADY STATE DYNAMICS` second line: fMin, fMax, data points n per interval, bias. */
export interface FrequencySweep {
  readonly fMinHz: number;
  readonly fMaxHz: number;
  readonly pointsPerInterval: number;
  readonly bias: number;
}

/** Fully correlated single-direction base acceleration (MVP): a harmonic amplitude in g, or a random ASD from the library. */
export interface BaseExcitation {
  readonly kind: 'acceleration';
  readonly direction: 'x' | 'y' | 'z';
  readonly amplitudeG?: number;
  readonly spectrum?: string;
}

export interface VibrationSpectrum {
  readonly name: string;
  readonly quantity: 'acceleration';
  readonly unit: 'g2/Hz' | '(m/s2)2/Hz';
  /** Breakpoints [Hz, level], strictly increasing frequency, positive levels; log-log interpolation between them. */
  readonly points: readonly (readonly [fHz: number, level: number])[];
  readonly source: DynamicSource;
  /** true unless the source is grade A. */
  readonly unverified: boolean;
  /** Library entry the points were copied from. */
  readonly library?: string;
}

export interface TimeHistory {
  readonly name: string;
  readonly unit: 'factor' | 'N' | 'N*mm' | 'mm' | 'g';
  readonly timeS: readonly number[];
  readonly values: readonly number[];
  readonly source: DynamicSource;
  readonly unverified: boolean;
}

export interface PeakFactor {
  readonly value: number;
  readonly source: string;
  readonly defaulted: boolean;
  readonly rationale: string;
}

/** `AnalysisCase.dynamics` of a frequency_response / random_response case. */
export interface CaseDynamics {
  /** Upper frequency of interest; modes above it are not kept for the post-processing. */
  readonly basis: { readonly fMaxHz?: number };
  readonly damping?: DampingModel;
  readonly sweep?: FrequencySweep;
  readonly base?: BaseExcitation;
  /** Required cumulative effective-mass fraction per direction (company rule; no default, AF-31). */
  readonly modalTruncationThreshold?: number;
}

/** `AnalysisModel.vibration`: absent until the first spectrum / history command. Keys are user names `[a-z0-9_]+`. */
export interface DynamicsLibrary {
  readonly spectra: Readonly<Record<string, VibrationSpectrum>>;
  readonly spectrumOrder: readonly string[];
  readonly histories: Readonly<Record<string, TimeHistory>>;
  readonly historyOrder: readonly string[];
  /** Loads created by equivalent_static_load_case, by load id. */
  readonly equivalentLoads?: Readonly<Record<string, EquivalentLoadProvenance>>;
}

export type ProbeDynamicResult =
  | {
      readonly kind: 'frf';
      readonly probe: string;
      readonly quantity: string;
      readonly unit: string;
      readonly peaks: readonly { readonly fHz: number; readonly magnitude: number; readonly phaseDeg: number; readonly mode: number }[];
      readonly qHalfPower?: number;
    }
  | {
      readonly kind: 'random';
      readonly probe: string;
      readonly quantity: string;
      readonly unit: string;
      readonly rms: number;
      readonly peak: number;
      readonly peakFactor: PeakFactor;
      readonly zeroUpcrossingHz: number;
      readonly spectrumGrms: number;
    };

export interface NodalRmsMax {
  readonly quantity: string;
  readonly rms: number;
  readonly unit: string;
  readonly node: number;
  readonly at: Vec3;
}

/** Nodal rms field of a random_response post-processing, stored in the results artifact (RS1 RS-7: `llull-compute post random`). */
export interface NodalRmsField {
  readonly engine: 'native-cpu' | 'ts';
  readonly solver: string;
  readonly solverVersion: string;
  readonly gridPoints: number;
  /** e.g. u_x_rel, a_z, s_xx: one rms value per component and node. */
  readonly components: readonly string[];
  readonly units: readonly string[];
  readonly values: Readonly<Record<string, readonly number[]>>;
}

/** Provenance of a load written by `equivalent_static_load_case` (AF-35), keyed by load id in `DynamicsLibrary.equivalentLoads`. */
export interface EquivalentLoadProvenance {
  readonly sourceAnalysisId: string;
  readonly sourceResultsHash: string;
  readonly from: { readonly probe: string } | { readonly nodalMax: string };
  readonly rms: number;
  readonly unit: 'g';
  readonly peakFactor: PeakFactor;
  readonly spectrum: string;
  readonly damping: string;
  readonly targetAnalysisId: string;
}

/** `ResultsSummary.dynamics`: recomputed from the results artifact (+ the case set-up) by the pure summariser (05 TR-FEA-33). */
export interface DynamicSummary {
  readonly type: DynamicAnalysisType;
  readonly modesKept: number;
  readonly highestModeHz: number;
  /** Cumulative effective-mass fraction of the kept modes per translation (`.dat` effective modal mass / total effective mass). */
  readonly massParticipation: Readonly<Record<'x' | 'y' | 'z', number>>;
  readonly dampingPerMode: readonly { readonly mode: number; readonly fHz: number; readonly zeta: number }[];
  readonly probes: readonly ProbeDynamicResult[];
  /** random_response: per nodal rms field component, the largest value over the nodes and where (`FeResultsArtifact.nodalRms`). */
  readonly nodalMax?: readonly NodalRmsMax[];
  /** Engine that computed the nodal rms field stored in the results artifact. */
  readonly nodalField?: { readonly engine: 'native-cpu' | 'ts'; readonly nodes: number; readonly gridPoints: number };
  /** CalculiX SSD output frequencies (cross-check of the solver's own point placement). */
  readonly frequencyPointsHz?: readonly number[];
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: true;
  readonly reviewReason: string;
}
