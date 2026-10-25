/** Shared types of the field compiler and its lattice module (kept apart so the two files do not import each other). */

import type { FieldQuality } from '@core/geometry/field/program';
import type { CadDocument } from '@core/model/types';
import type { Box, Frame } from './frame';
import type { FieldNode } from './model';
import type { ScalarHost } from './scalar';

export interface CompileWarning {
  readonly code: 'IMP_OFFSET_NOT_EXACT' | 'IMP_BLEND_EXCEEDS_FEATURE' | 'IMP_BLEND_LAW_STEEP' | 'IMP_MAP_POLE' | 'IMP_LAW_OUT_OF_RANGE';
  readonly ids: readonly string[];
  readonly message: string;
}

export interface CompileFailure {
  readonly ok: false;
  readonly code:
    | 'IMP_FIELD_NOT_FOUND'
    | 'IMP_ENTITY_NOT_FOUND'
    | 'IMP_SOLID_NOT_CLOSED'
    | 'IMP_PARAM_RANGE'
    | 'IMP_GRAPH_EMPTY'
    | 'IMP_GRAPH_TOO_LARGE';
  readonly message: string;
  readonly ids: readonly string[];
}

export interface Part {
  readonly reg: number;
  readonly quality: FieldQuality;
  readonly lipschitz: number;
  readonly box: Box | null;
}

export class Failure extends Error {
  constructor(readonly failure: CompileFailure) {
    super(failure.message);
  }
}

const RANK: Readonly<Record<FieldQuality, number>> = { exact: 0, bound: 1, approximate: 2 };
export const worst = (a: FieldQuality, b: FieldQuality): FieldQuality => (RANK[a] >= RANK[b] ? a : b);
export const degrade = (quality: FieldQuality): FieldQuality => (quality === 'exact' ? 'bound' : quality);

/** What the lattice module reads from the compiler. */
export interface CompileHost extends ScalarHost {
  readonly doc: CadDocument;
  readonly warnings: CompileWarning[];
  readonly features: number[];
  field(id: string, frame: Frame): Part;
  node(id: string, ids: readonly string[]): FieldNode;
}
