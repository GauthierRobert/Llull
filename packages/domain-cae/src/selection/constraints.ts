/** Property constraints of a comparison (PHY-12 FR-SEL-04): min / max on any catalogue property, a missing value is `missing`, never pass or fail. */

import { convertValue, isUnitFailure } from '@lib/quantity';
import { catalogEntry } from '@core/model/propertyCatalog';
import type { PropertyDirection } from '@core/model/propertyModel';
import type { CadDocument } from '@core/model/types';
import { quantityProblem } from './inputs';
import { resolveCandidateProperty, type Layup } from './layups';
import type { ResolveOptions } from './properties';
import type { Excluded, PropertyUse, Quantity } from './types';

export interface ConstraintParam {
  readonly property: string;
  readonly min?: Quantity | undefined;
  readonly max?: Quantity | undefined;
  readonly direction?: PropertyDirection | undefined;
}

export interface ConstraintFailure {
  readonly material: string;
  readonly constraint: string;
  readonly value: number;
  readonly unit: string;
}

export type ConstraintOutcome =
  | { readonly kind: 'pass'; readonly use: PropertyUse }
  | { readonly kind: 'fail'; readonly failure: ConstraintFailure; readonly use: PropertyUse }
  | { readonly kind: 'missing'; readonly excluded: Excluded };

/** The unit a constraint is evaluated in: its lower bound's, else its upper bound's. */
const unitOf = (constraint: ConstraintParam): string | undefined => constraint.min?.unit ?? constraint.max?.unit;

const constraintText = (constraint: ConstraintParam): string =>
  [
    constraint.min === undefined ? null : `${constraint.property} >= ${constraint.min.value} ${constraint.min.unit}`,
    constraint.max === undefined ? null : `${constraint.property} <= ${constraint.max.value} ${constraint.max.unit}`,
  ]
    .filter((part) => part !== null)
    .join(' and ');

/** First problem of a constraint (no bound, unknown property, a unit of the wrong dimension), or null. */
export function constraintProblem(constraint: ConstraintParam, index: number): string | null {
  const path = `constraints.${index}`;
  const entry = catalogEntry(constraint.property);
  const unit = unitOf(constraint);
  if (entry === undefined) return `${path}.property: '${constraint.property}' is not a catalogue property`;
  if (unit === undefined) return `${path}: give min and / or max`;
  return (
    (constraint.min === undefined ? null : quantityProblem(`${path}.min`, constraint.min, entry.canonicalUnit)) ??
    (constraint.max === undefined ? null : quantityProblem(`${path}.max`, constraint.max, entry.canonicalUnit))
  );
}

/** One material against one constraint (the bounds are compared in the unit of the lower bound, else the upper one). */
export function evaluateConstraint(
  doc: CadDocument,
  material: string,
  constraint: ConstraintParam,
  options: ResolveOptions,
  layup?: Layup,
): ConstraintOutcome {
  const unit = unitOf(constraint) ?? '1';
  const resolved = resolveCandidateProperty(
    doc,
    material,
    constraint.property,
    unit,
    { ...options, direction: constraint.direction ?? options.direction },
    layup,
  );
  if (!resolved.ok)
    return {
      kind: 'missing',
      excluded: {
        material,
        code: resolved.code,
        reason: `constraint ${constraintText(constraint)}: ${resolved.reason}`,
        missing: [constraint.property],
      },
    };
  const value = resolved.use.value;
  const upper = constraint.max === undefined ? undefined : convertValue(constraint.max.value, constraint.max.unit, unit);
  const failed =
    (constraint.min !== undefined && value < constraint.min.value) || (upper !== undefined && !isUnitFailure(upper) && value > upper.value);
  return failed
    ? { kind: 'fail', use: resolved.use, failure: { material, constraint: constraintText(constraint), value, unit } }
    : { kind: 'pass', use: resolved.use };
}
