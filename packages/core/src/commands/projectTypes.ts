import type { SceneSnapshot } from './sceneTypes';

export interface PlanAction {
  command: string;
  params?: Record<string, unknown>;
  as?: string;
}

/** Runs `step` `count` times (number or `=expr`); `$i` is the 0-based iteration; `as` binds the last iteration's ids. */
export interface RepeatStep {
  repeat: {
    count: number | string;
    as?: string;
  };
  step: { command: string; params?: Record<string, unknown> };
}

/** Runs `step` per element of `values` (array or `=expr`); exposes `$<as>` (element) and `$i`. */
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
