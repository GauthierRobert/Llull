/** Field measures shared by implicit_properties and check_implicit: volume by two quadratures, regions, components, voids (05 IMP 5.8). */

import type { FieldEngine, FieldComponent } from '@core/geometry/field/engineTypes';
import type { FieldProgram } from '@core/geometry/field/program';
import type { CadDocument, Vec3 } from '@core/model/types';
import { compileField } from './compile';
import { type ImplicitBody, bodyOf, fieldOf } from './model';

const MEASURE_CELLS = 2 ** 19;
const MIN_COMPONENT_VOXELS = 8;

/** The field (and body, when `id` names one) a query addresses. */
export function resolveTarget(doc: CadDocument, id: string): { fieldId: string; body: ImplicitBody | undefined } | undefined {
  const body = bodyOf(doc, id);
  if (body !== undefined) return { fieldId: body.field, body };
  return fieldOf(doc, id) === undefined ? undefined : { fieldId: id, body: undefined };
}

export interface Box {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Voxel for a measure over `box` with about 2^19 cells (not finer than `finest`). */
export function measureVoxel(box: Box, requested: number | undefined, finest = 0): number {
  if (requested !== undefined) return requested;
  const volume = (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]);
  return Math.max(finest, Math.cbrt(volume / MEASURE_CELLS));
}

export interface VolumeAnswer {
  readonly volume: number;
  readonly regionVolume: number;
  /** |coarse - fine| of the two quadratures. */
  readonly quadratureError: number;
  readonly samples: number;
  readonly voxel: number;
  readonly sampling: 'midpoint' | 'lowdiscrepancy';
  readonly nonFiniteSamples: number;
  readonly engine: string;
  readonly deterministic: boolean;
}

/** Volume of {f <= 0} (inside `region` when given) over `box` by two quadratures at `voxel` and 1.25 voxel; or the refusal message. */
export function quadratureVolume(
  engine: FieldEngine,
  program: FieldProgram,
  region: FieldProgram | null,
  box: Box,
  voxel: number,
): VolumeAnswer | { readonly code: string; readonly message: string } {
  const sampling = program.strutSets.length > 0 ? 'lowdiscrepancy' : 'midpoint';
  const ask = (h: number): ReturnType<FieldEngine['measure']> =>
    engine.measure(program, { ...box, voxel: h }, region, { kind: 'volume', sampling });
  const fine = ask(voxel);
  if (!fine.ok) return { code: fine.code, message: fine.message };
  const coarse = ask(voxel * 1.25);
  if (fine.kind !== 'volume') return { code: 'IMP_ENGINE_FAILED', message: 'unexpected measure answer' };
  const coarseVolume = coarse.ok && coarse.kind === 'volume' ? coarse.volume : fine.volume;
  return {
    volume: fine.volume,
    regionVolume: fine.regionVolume,
    quadratureError: Math.abs(coarseVolume - fine.volume),
    samples: fine.samples,
    voxel,
    sampling,
    nonFiniteSamples: fine.nonFiniteSamples,
    engine: fine.provenance.engine,
    deterministic: fine.provenance.deterministic,
  };
}

export interface ComponentAnswer {
  readonly solids: readonly FieldComponent[];
  readonly voids: readonly FieldComponent[];
  readonly belowResolution: number;
  readonly voxel: number;
}

/** Solid components and enclosed voids of {f < 0} on a sign grid of `voxel` over `box` (padded by 2 voxels), or the refusal. */
export function signComponentsOf(
  engine: FieldEngine,
  program: FieldProgram,
  box: Box,
  voxel: number,
): ComponentAnswer | { readonly code: string; readonly message: string } {
  const pad = 2 * voxel;
  const grid = {
    min: [box.min[0] - pad, box.min[1] - pad, box.min[2] - pad] as Vec3,
    max: [box.max[0] + pad, box.max[1] + pad, box.max[2] + pad] as Vec3,
    voxel,
  };
  const answer = engine.measure(program, grid, null, { kind: 'components' });
  if (!answer.ok) return { code: answer.code, message: answer.message };
  if (answer.kind !== 'components') return { code: 'IMP_ENGINE_FAILED', message: 'unexpected measure answer' };
  const big = (parts: readonly FieldComponent[]): FieldComponent[] => parts.filter((part) => part.voxels >= MIN_COMPONENT_VOXELS);
  const below = answer.solids.length + answer.voids.length - big(answer.solids).length - big(answer.voids).length;
  return { solids: big(answer.solids), voids: big(answer.voids).filter((part) => part.enclosed), belowResolution: below, voxel };
}

/** Program of `region` (a field id), or null when no region was requested; a failure message when it does not compile. */
export function regionProgram(
  doc: CadDocument,
  region: string | undefined,
): FieldProgram | null | { readonly message: string; readonly code: string } {
  if (region === undefined) return null;
  const compiled = compileField(doc, region);
  return compiled.ok ? compiled.program : { code: compiled.code, message: compiled.message };
}
