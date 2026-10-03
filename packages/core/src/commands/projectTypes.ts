import { SceneSnapshot } from './sceneTypes';

export interface PlanAction {
  command: string;
  params?: Record<string, unknown>;
  as?: string;
}

/**
 * A `repeat` step runs an inner step `count` times.
 * `count` may be a number literal or an expression string (prefix `=`).
 * Each iteration exposes `$i` (0-indexed) in params expressions.
 * `as` (if provided) is bound to the last iteration's affected ids.
 */
export interface RepeatStep {
  repeat: {
    count: number | string;
    as?: string;
  };
  step: { command: string; params?: Record<string, unknown> };
}

/**
 * A `for_each` step iterates over an array of values.
 * `values` may be an array literal or an expression string resolving to an array.
 * Each iteration exposes `$as` (current element) and `$i` (0-indexed index).
 */
export interface ForEachStep {
  for_each: {
    values: unknown[] | string;
    as: string;
  };
  step: { command: string; params?: Record<string, unknown> };
}

/** A top-level action item — either a plain action or a control-flow step. */
export type ActionItem = PlanAction | RepeatStep | ForEachStep;

export interface BuildProjectParams {
  actions: ActionItem[];
  onError?: 'abort' | 'continue';
  validate?: boolean;
}

export interface StepReport {
  index: number;
  command: string;
  ok: boolean;
  summary: string;
  affected: string[];
}

export interface BuildProjectData {
  ok: boolean;
  validated: boolean;
  stepCount: number;
  steps: StepReport[];
  /** Index of the step that aborted the run, or null (completed / continue mode). */
  failedAt: number | null;
  /** Validation issues (validate mode only). */
  issues?: string[];
  /** Final document snapshot (omitted in validate mode — nothing changed). */
  scene?: SceneSnapshot;
}
