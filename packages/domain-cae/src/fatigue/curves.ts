/** Reads fatigue material models (S-N, strain-life, cyclic) and strength allowables of a document material record. */

import type { FatigueMaterialModel } from '@core/model/materialDurability';
import type { MaterialModel } from '@core/model/materialModel';
import { modelUnverifiedReasonsOf } from '@core/model/materialLaws/references';
import type { CadDocument } from '@core/model/types';
import { isAllowableRefusal, materialAllowable } from '../margins/allowable';

export type FatigueKind = FatigueMaterialModel['kind'];
export type CurveOf<K extends FatigueKind> = Extract<FatigueMaterialModel, { kind: K }>;

export interface FoundCurve<K extends FatigueKind> {
  readonly law: CurveOf<K>;
  readonly entry: MaterialModel;
  readonly recordId: string;
  readonly unverifiedReasons: readonly string[];
}

export interface CurveRefusal {
  readonly code: string;
  readonly message: string;
}

export const isCurveRefusal = (value: unknown): value is CurveRefusal =>
  typeof value === 'object' && value !== null && 'code' in value && 'message' in value;

/**
 * The model `modelId` of material record `recordId` when its kind is one of `kinds`.
 * @failure unknown record / model -> FAT_CURVE_MISSING; another kind -> FAT_CURVE_UNSUPPORTED
 */
export function findCurve<K extends FatigueKind>(
  doc: CadDocument,
  recordId: string,
  modelId: string,
  kinds: readonly K[],
): FoundCurve<K> | CurveRefusal {
  const material = Object.hasOwn(doc.materials, recordId) ? doc.materials[recordId] : undefined;
  if (material === undefined) return { code: 'FAT_CURVE_MISSING', message: `no material record '${recordId}'` };
  const entry = (material.materialModels ?? []).find((candidate) => candidate.id === modelId);
  if (entry === undefined) return { code: 'FAT_CURVE_MISSING', message: `material '${recordId}' has no model '${modelId}'` };
  const law = entry.model as FatigueMaterialModel;
  if (!(kinds as readonly string[]).includes(law.kind))
    return { code: 'FAT_CURVE_UNSUPPORTED', message: `model '${modelId}' is a ${law.kind}; expected ${kinds.join(' | ')}` };
  const record = { name: recordId, ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) };
  return { law: law as CurveOf<K>, entry, recordId, unverifiedReasons: modelUnverifiedReasonsOf(entry, record) };
}

/** Ftu / Fty of a record in MPa at room temperature (293.15 K), or null when the record does not state it. */
export function strengthMpa(doc: CadDocument, recordId: string, property: 'Ftu' | 'Fty'): number | null {
  const material = Object.hasOwn(doc.materials, recordId) ? doc.materials[recordId] : undefined;
  if (material === undefined) return null;
  const found = materialAllowable(material, recordId, property, 293.15);
  return isAllowableRefusal(found) ? null : found.valueMpa;
}
