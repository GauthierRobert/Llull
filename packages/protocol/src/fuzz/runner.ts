/**
 * Runs a fuzz case step by step through `build_project` (one plan per step, `$body` bound to the previous step's solid) and checks after
 * each step: the step succeeded; every body is a valid closed solid with a positive finite volume; a removal step never adds volume and an
 * addition step never removes it.
 */

import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { outcomeIsFailure, runCommandOutcome } from '../commandOutcome';
import { measureBodies, type BodyMeasure } from './measure';
import type { FuzzAction, FuzzCase, FuzzFailure, FuzzStep } from './types';

/** Relative slack of the volume monotonicity checks (float noise of a kernel boolean). */
const MONOTONE_REL_TOLERANCE = 1e-5;

interface FuzzStepReport {
  readonly step: number;
  readonly kind: FuzzStep['kind'];
  readonly label: string;
  readonly ok: boolean;
  readonly volume?: number;
  readonly bodies?: number;
  readonly notes?: readonly string[];
}

export interface FuzzCaseReport {
  readonly seed: number;
  readonly ok: boolean;
  readonly steps: readonly FuzzStepReport[];
  readonly failure?: FuzzFailure;
}

const ALIAS_REF = /^\$([A-Za-z_][\w]*)(?:\[(\d+)\])?$/;

/** Replace refs to aliases bound by EARLIER steps (`outer`) until the step rebinds that alias itself. */
function withOuterAliases(actions: readonly FuzzAction[], outer: Readonly<Record<string, readonly string[]>>): FuzzAction[] {
  const rebound = new Set<string>();
  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const match = ALIAS_REF.exec(value);
      const name = match?.[1];
      if (match === null || name === undefined || rebound.has(name)) return value;
      const ids = outer[name];
      return ids?.[Number(match[2] ?? 0)] ?? value;
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolve(inner)]));
    return value;
  };
  return actions.map((action) => {
    const params = resolve(action.params) as Record<string, unknown>;
    if (action.as !== undefined) rebound.add(action.as);
    return { ...action, params };
  });
}

function stepAliases(data: unknown): Record<string, string[]> {
  const aliases = isRecord(data) ? data['aliases'] : undefined;
  if (!isRecord(aliases)) return {};
  return Object.fromEntries(
    Object.entries(aliases)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([name, ids]) => [name, ids.filter((id): id is string => typeof id === 'string')]),
  );
}

const total = (bodies: readonly BodyMeasure[]): number => bodies.reduce((sum, body) => sum + body.volume, 0);

function volumeFailure(step: FuzzStep, index: number, before: number, after: number): FuzzFailure | undefined {
  const slack = MONOTONE_REL_TOLERANCE * Math.max(before, after, 1);
  if (step.effect === 'remove' && after > before + slack)
    return {
      step: index,
      kind: step.kind,
      check: 'volume_added_by_removal',
      message: `${step.kind} grew the volume ${before} -> ${after}`,
    };
  if (step.effect === 'add' && after < before - slack)
    return {
      step: index,
      kind: step.kind,
      check: 'volume_removed_by_addition',
      message: `${step.kind} shrank the volume ${before} -> ${after}`,
    };
  return undefined;
}

function bodyFailure(step: FuzzStep, index: number, bodies: readonly BodyMeasure[]): FuzzFailure | undefined {
  if (bodies.length === 0) return { step: index, kind: step.kind, check: 'not_solid', message: 'no 3D solid left in the document' };
  for (const body of bodies) {
    if (body.invalid !== undefined) return { step: index, kind: step.kind, check: 'not_solid', message: `${body.id}: ${body.invalid}` };
    const volumes = [body.volume, ...(body.massVolume !== undefined ? [body.massVolume] : [])];
    if (volumes.some((v) => !Number.isFinite(v) || v <= 0))
      return {
        step: index,
        kind: step.kind,
        check: 'bad_volume',
        message: `${body.id}: volume ${volumes.join(' / ')} is not positive and finite`,
      };
  }
  return undefined;
}

/** Run `steps` from an empty document; stops at the first failed check. */
export function runFuzzSteps(seed: number, steps: readonly FuzzStep[]): FuzzCaseReport {
  let doc: CadDocument = createEmptyDocument();
  let aliases: Record<string, readonly string[]> = {};
  let before = 0;
  const reports: FuzzStepReport[] = [];
  for (const [index, step] of steps.entries()) {
    const { document, outcome } = runCommandOutcome(doc, 'build_project', { actions: withOuterAliases(step.actions, aliases) });
    if (outcomeIsFailure('build_project', outcome)) {
      reports.push({ step: index, kind: step.kind, label: step.label, ok: false });
      const failure: FuzzFailure = { step: index, kind: step.kind, check: 'command_failed', message: outcome.summary };
      return { seed, ok: false, steps: reports, failure };
    }
    doc = document;
    aliases = { ...aliases, ...stepAliases(outcome.data) };
    const bodies = measureBodies(doc);
    const after = total(bodies);
    const failure = bodyFailure(step, index, bodies) ?? volumeFailure(step, index, before, after);
    const notes = [...new Set(bodies.flatMap((body) => body.notes))];
    reports.push({
      step: index,
      kind: step.kind,
      label: step.label,
      ok: failure === undefined,
      volume: after,
      bodies: bodies.length,
      ...(notes.length > 0 ? { notes } : {}),
    });
    if (failure !== undefined) return { seed, ok: false, steps: reports, failure };
    before = after;
  }
  return { seed, ok: true, steps: reports };
}

export const runFuzzCase = (fuzzCase: FuzzCase): FuzzCaseReport => runFuzzSteps(fuzzCase.seed, fuzzCase.steps);
