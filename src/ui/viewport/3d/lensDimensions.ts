// Dimension lens: the editable dimensions of an entity, read from the feature step that created it. Editing one
// re-dispatches that step through edit_step_params (the parametric path), so the UI never edits geometry itself.

import type { FeatureStep } from '@core/model/types';

/** Scalar dimension params and their short on-model label. */
const SCALAR_LABELS: Readonly<Record<string, string>> = {
  radius: 'r',
  height: 'h',
  depth: 'd',
  width: 'w',
  length: 'l',
  thickness: 't',
  ringRadius: 'R',
  tubeRadius: 'r',
  baseWidth: 'w',
  baseDepth: 'd',
};

/** Vector dimension params: one pill per component. */
const VECTOR_LABELS: Readonly<Record<string, readonly string[]>> = { size: ['x', 'y', 'z'] };

export interface LensDimension {
  /** Unique within the target: `key` or `key.index`. */
  id: string;
  key: string;
  /** Component of a vector param (`size`). */
  index?: number;
  label: string;
  /** null when the param is an `=expression` (driven by a parameter). */
  value: number | null;
  expression: string | null;
}

export interface LensTarget {
  stepId: string;
  stepName: string;
  params: Readonly<Record<string, unknown>>;
  dimensions: LensDimension[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toDimension(key: string, label: string, raw: unknown, index?: number): LensDimension | null {
  const id = index === undefined ? key : `${key}.${index}`;
  const base = index === undefined ? { id, key, label } : { id, key, index, label };
  if (typeof raw === 'number' && Number.isFinite(raw)) return { ...base, value: raw, expression: null };
  if (typeof raw === 'string' && raw.startsWith('=')) return { ...base, value: null, expression: raw };
  return null;
}

function dimensionsOf(params: Readonly<Record<string, unknown>>): LensDimension[] {
  const dimensions: LensDimension[] = [];
  for (const [key, raw] of Object.entries(params)) {
    const scalarLabel = SCALAR_LABELS[key];
    if (scalarLabel !== undefined) {
      const dimension = toDimension(key, scalarLabel, raw);
      if (dimension !== null) dimensions.push(dimension);
      continue;
    }
    const vectorLabels = VECTOR_LABELS[key];
    if (vectorLabels !== undefined && Array.isArray(raw)) {
      vectorLabels.forEach((label, index) => {
        const dimension = toDimension(key, label, raw[index], index);
        if (dimension !== null) dimensions.push(dimension);
      });
    }
  }
  return dimensions;
}

/** Recorded `affected` ids, else (steps inserted by hand carry none) the step-scoped id `<prefix>-<step>.<k>` naming the step. */
function stepProduced(step: FeatureStep, entityId: string): boolean {
  if (step.affected !== undefined && step.affected.length > 0) return step.affected.includes(entityId);
  const stepNumber = /^step-(\d+)$/.exec(step.id)?.[1];
  return stepNumber !== undefined && new RegExp(`-${stepNumber}\\.\\d+$`).test(entityId);
}

/** The first non-suppressed step that produced `entityId` and carries dimension params, or null. */
export function lensTarget(history: readonly FeatureStep[], entityId: string): LensTarget | null {
  for (const step of history) {
    if (step.suppressed === true || !stepProduced(step, entityId) || !isRecord(step.params)) continue;
    const dimensions = dimensionsOf(step.params);
    if (dimensions.length > 0) return { stepId: step.id, stepName: step.name, params: step.params, dimensions };
  }
  return null;
}

/** The step's params with one dimension replaced by `value`. */
export function withDimension(target: LensTarget, dimension: LensDimension, value: number): Record<string, unknown> {
  const current = target.params[dimension.key];
  if (dimension.index !== undefined && Array.isArray(current)) {
    const next: unknown[] = [...current];
    next[dimension.index] = value;
    return { ...target.params, [dimension.key]: next };
  }
  return { ...target.params, [dimension.key]: value };
}
