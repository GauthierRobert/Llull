/**
 * Control of a TPMS (05 IMP 5.4): the valid range of thickness / level and the inversion of a target relative density. The inversion is the
 * sample quantile of F (network), |F| (raw sheet) or |F|/|grad F| (normalised sheet) over one cell - the exact inverse of the sampled fraction,
 * solved once at command time and stored next to the target.
 */

import { FieldBuilder } from '@core/geometry/field/build';
import { type FieldEngine } from '@core/geometry/field/engineTypes';
import type { Vec3 } from '@core/model/types';
import { worldFrame } from './frame';
import type { TpmsControl, TpmsKind } from './model';
import { TPMS_FACTS, rectangularCoordinates, tpmsRegisters } from './tpms';

const CELL_SAMPLES = 2 ** 18;

export interface ControlRequest {
  readonly kind: TpmsKind;
  readonly cellSize: Vec3;
  readonly form: 'sheet' | 'network';
  readonly normalize: 'gradient' | 'none';
}

/** Valid open interval of the control: thickness in (0, a_min / 2) (normalised) or (0, range) (raw); level in (-range, range). */
export function controlInterval(request: ControlRequest): {
  readonly low: number;
  readonly high: number;
  readonly name: 'thickness' | 'level';
} {
  const range = TPMS_FACTS[request.kind].range;
  if (request.form === 'network') return { low: -range, high: range, name: 'level' };
  return { low: 0, high: request.normalize === 'gradient' ? Math.min(...request.cellSize) / 2 : range, name: 'thickness' };
}

/** Resolved control of `target` (relative density of the solid in one cell), or the reason it is unreachable. */
export function solveRelativeDensity(request: ControlRequest, target: number, engine: FieldEngine): TpmsControl | string {
  const b = new FieldBuilder('mm');
  const { field, gradient } = tpmsRegisters(b, request.kind, rectangularCoordinates(b, request.cellSize, worldFrame(b)));
  const sampled = request.form === 'network' ? field : request.normalize === 'gradient' ? b.div(b.abs(field), gradient) : b.abs(field);
  const program = b.finish(sampled, { bounds: null, lipschitz: 1, quality: 'approximate' });
  const [ax, ay, az] = request.cellSize;
  const voxel = Math.max(Math.min(ax, ay, az) / 64, Math.cbrt((ax * ay * az) / CELL_SAMPLES));
  const answer = engine.measure(program, { min: [0, 0, 0], max: request.cellSize, voxel }, null, {
    kind: 'quantile',
    probabilities: [target],
    absolute: false,
  });
  if (!answer.ok) return answer.message;
  if (answer.kind !== 'quantile') return 'the field engine answered with an unexpected measure';
  const value = answer.values[0] as number;
  if (!Number.isFinite(value)) return 'the density could not be inverted (no finite samples)';
  if (request.form === 'network') return { kind: 'level', value };
  const thickness = request.normalize === 'gradient' ? 2 * value : value;
  const { high } = controlInterval(request);
  return thickness < high
    ? { kind: 'thickness', value: thickness }
    : `relative density ${target} needs thickness ${thickness} >= the limit ${high}`;
}
