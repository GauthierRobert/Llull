import type { SceneSnapshot } from '../inspect/sceneTypes';
import type { CommandError } from '../types';

export interface PlanAction {
  command: string;
  params?: Record<string, unknown>;
  as?: string;
}

/** Runs `step` `count` times (number or `=expr`); `$i` is the 0-based iteration; `as` binds the last iteration's ids. */
export interface RepeatStep {
  repeat: { count: number | string; as?: string };
  step: { command: string; params?: Record<string, unknown> };
}

/** Runs `step` per element of `values` (array or `=expr`); exposes `$<as>` (element) and `$i`. */
export interface ForEachStep {
  for_each: { values: unknown[] | string; as: string };
  step: { command: string; params?: Record<string, unknown> };
}

/**
 * Nestable loop with a body of actions. `repeat`: `count` iterations of variable `as` (default `i`, 0-based). `for`: `var` from `from` to
 * `to` inclusive, stepping by `step` (default 1). Numbers or `=expr` strings; loop variables are usable as `i` or `$i` in expressions.
 */
export interface LoopNode {
  repeat?: { count: number | string; as?: string };
  for?: { var: string; from: number | string; to: number | string; step?: number | string };
  actions: ActionItem[];
}

/** A plan item — a plain action, a legacy single-step loop, or a nestable loop. */
export type ActionItem = PlanAction | RepeatStep | ForEachStep | LoopNode;

export interface BuildProjectParams {
  actions: ActionItem[];
  onError?: 'abort' | 'continue';
  validate?: boolean;
}

export interface StepReport {
  index: number;
  /** Loop-aware location, e.g. `step 4 › iter 2 › step 1` (present for steps inside loops). */
  path?: string;
  command: string;
  ok: boolean;
  summary: string;
  affected: string[];
  /** Why a failed step failed (`ok: false` only): the command's own `CommandError`, else a `PLAN_*` / `CMD_NO_EFFECT` code. */
  error?: CommandError;
  /** A read-only step's answer (its `CommandResult.data`), so a script reads query results without re-running them. */
  data?: unknown;
}

export interface BuildProjectData {
  ok: boolean;
  validated: boolean;
  stepCount: number;
  steps: StepReport[];
  /** Index of the step that aborted the run, or null (completed / continue mode). */
  failedAt: number | null;
  /**
   * Every `as` alias the run bound (loop-interpolated ones included, e.g. `piston0`) → the ids bound at that moment (later steps may have
   * consumed them). Present when the run completed; absent in validate mode and on an aborted (rolled-back) run.
   */
  aliases?: Record<string, string[]>;
  /** Validation issues (validate mode only). */
  issues?: string[];
  /** Final document snapshot (omitted in validate mode — nothing changed). */
  scene?: SceneSnapshot;
}
