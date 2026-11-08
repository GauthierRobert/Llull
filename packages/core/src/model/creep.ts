/** PHY-11 creep set-up of a `creep` case (plugin `cae`, CalculiX `*VISCO` + `*CREEP, LAW=NORTON`) and its bounded results summary. */

import type { Vec3 } from './vectors';

/** Output times of the hold step, in seconds from the start of the hold (CalculiX `*TIME POINTS` in step time). */
export type CreepOutputTimes = { readonly kind: 'log'; readonly count: number } | { readonly kind: 'linear'; readonly everyS: number };

/**
 * One hold at constant loads and constraints, optionally after an elastic preload step. Every time is in seconds, every strain dimensionless,
 * the temperature in K (the creep law is read at it). Written by `set_creep_step`; named defaults are stored resolved.
 */
export interface CreepStepSpec {
  /** A short `*STATIC` step applies loads and held displacements before the hold (CalculiX switches creep off in `*STATIC`). */
  readonly preloadStep: boolean;
  /** Length of the preload step; it counts in the CalculiX total time, so the hold clock starts at this value. 0 without a preload step. */
  readonly preloadPeriodS: number;
  readonly durationS: number;
  readonly initialIncrementS: number;
  readonly minIncrementS?: number;
  readonly maxIncrementS?: number;
  /** `*STEP, INC=`. */
  readonly maxIncrements: number;
  /** `*VISCO, CETOL=`: allowed creep strain error per increment (required by CalculiX). */
  readonly cetol: number;
  readonly nlgeom: boolean;
  readonly temperature: { readonly kind: 'uniform'; readonly valueK: number };
  readonly outputTimes: CreepOutputTimes;
}

/** Value and place of an extreme (analysis length unit). */
interface CreepPeak {
  readonly value: number;
  readonly at: Vec3;
  readonly entityId: string;
}

/** History of one probe over the hold: `tS` are seconds from the hold start, at most 200 points (log-spaced selection, last point kept). */
export interface CreepProbeHistory {
  readonly quantity: string;
  readonly unit: string;
  readonly tS: readonly number[];
  readonly values: readonly number[];
}

/** Bounded summary recorded with the results of a `creep` case (`ResultsSummary.creep`); the full fields stay in the artifact store. */
export interface CreepResultsSummary {
  /** The last stored result set reaches `durationS`. */
  readonly holdComplete: boolean;
  /** Hold time of the last stored result set (s). */
  readonly finalTimeS: number;
  /** Stored result sets of the hold step. */
  readonly outputSets: number;
  /** Largest equivalent creep strain (frd block `PE`) of the last stored set; absent when the file has no `PE` block. */
  readonly maxCeeq?: CreepPeak;
  /** MPa (N-mm-t-s decks only). */
  readonly maxVonMisesEndMPa?: CreepPeak;
  /** Largest von Mises over every stored set of the hold (MPa). */
  readonly maxVonMisesOverHoldMPa?: number;
  readonly probeHistories: Readonly<Record<string, CreepProbeHistory>>;
  /** Probes beyond the 32 kept (their histories stay readable through probe_history); absent when none. */
  readonly probesOmitted?: number;
}
