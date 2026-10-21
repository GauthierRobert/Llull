// One-line descriptions of the recorded FE set-up items (presentation only; the data is the command output).

import type { AnalysisCase, FeaConstraint, FeaLoad, FeaTarget, ThermalBc, ThermalBcRecord } from '@core/model/analysis';
import { DEFAULT_FACTORS } from '@cae/index';
import { formatSignificant } from './quantityFormat';

export type NameOf = (entityId: string) => string;

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

function targetText(target: FeaTarget, nameOf: NameOf): string {
  const parts = [
    target.facesNear !== undefined && target.facesNear.length > 0 ? count(target.facesNear.length, 'face') : '',
    target.edgesNear !== undefined && target.edgesNear.length > 0 ? count(target.edgesNear.length, 'edge') : '',
    target.pointsNear !== undefined && target.pointsNear.length > 0 ? count(target.pointsNear.length, 'point') : '',
    target.intersectPlane !== undefined ? 'plane cut' : '',
  ].filter((part) => part !== '');
  return `${nameOf(target.entityId)}${parts.length > 0 ? ` · ${parts.join(', ')}` : ''}`;
}

const vectorText = (v: readonly number[]): string => `[${v.join(', ')}]`;

export function constraintText(constraint: FeaConstraint, nameOf: NameOf): string {
  const dofs = Object.entries(constraint.dofs ?? {})
    .map(([dof, value]) => `${dof}=${value}`)
    .join(' ');
  return `${constraint.kind}${dofs !== '' ? ` (${dofs})` : ''} on ${targetText(constraint.target, nameOf)}`;
}

export function loadText(load: FeaLoad, nameOf: NameOf): string {
  const size = load.vector !== undefined ? vectorText(load.vector) : load.magnitude !== undefined ? String(load.magnitude) : '';
  const where = load.target !== undefined ? ` on ${targetText(load.target, nameOf)}` : '';
  return `${load.kind} ${size}${where}`.trim();
}

const quantityText = (q: { readonly value: number; readonly unit: string }): string => `${q.value} ${q.unit}`;

function bcValueText(bc: ThermalBc): string {
  switch (bc.kind) {
    case 'film':
      return 'table' in bc.filmCoefficient
        ? `h(T) table, sink ${quantityText(bc.sinkTemperature)}`
        : `h ${quantityText(bc.filmCoefficient)}, sink ${quantityText(bc.sinkTemperature)}`;
    case 'radiation':
      return `sink ${quantityText(bc.sinkTemperature)}`;
    default:
      return quantityText(bc.value);
  }
}

export function thermalBcText(record: ThermalBcRecord, nameOf: NameOf): string {
  const { bc } = record;
  const where = bc.kind === 'heat_generation' ? nameOf(bc.entityId) : targetText(bc.target, nameOf);
  return `${bc.kind} ${bcValueText(bc)} on ${where}`;
}

/** Shown as "default" while the case still has the factors create_analysis starts from. */
export function factorsText(factors: AnalysisCase['factors']): string {
  const isDefault = factors.ultimate === DEFAULT_FACTORS.ultimate && factors.yield === DEFAULT_FACTORS.yield && factors.extra.length === 0;
  const extra = factors.extra.map((factor) => `${factor.name} ${factor.value}`);
  return [`ultimate ${factors.ultimate}`, `yield ${factors.yield}`, ...extra].join(' · ') + (isDefault ? ' (default)' : ' (set)');
}

const seconds = (value: number): string => `${formatSignificant(value)} s`;

/** Time stepping of a transient thermal case: duration, increments and output schedule. */
export function stepText(step: NonNullable<AnalysisCase['thermal']>['step']): string {
  const parts = [
    step.endTimeS !== undefined ? `duration ${seconds(step.endTimeS)}` : 'duration not set',
    step.initialIncrementS !== undefined ? `first step ${seconds(step.initialIncrementS)}` : '',
    step.maxIncrementS !== undefined ? `max step ${seconds(step.maxIncrementS)}` : '',
    step.minIncrementS !== undefined ? `min step ${seconds(step.minIncrementS)}` : '',
    step.fixedIncrements === true ? 'fixed steps' : '',
    step.outputEveryS !== undefined ? `output every ${seconds(step.outputEveryS)}` : '',
    step.outputTimesS !== undefined && step.outputTimesS.length > 0
      ? `output at ${step.outputTimesS.map(formatSignificant).join(', ')} s`
      : '',
  ];
  return parts.filter((part) => part !== '').join(' · ');
}
