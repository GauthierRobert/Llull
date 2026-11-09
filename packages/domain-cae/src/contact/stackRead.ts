/**
 * The placed fastener stacks of the document (aerospace 08 MAT, plugin `fasteners`), read as PUBLIC DATA of `CadDocument.fasteners` (L10: no import of
 * the fasteners plugin): validated structurally, only the fields the joint set-up needs.
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { isRecord } from '@lib/isRecord';
import { fromMm } from '@core/model/units';

export interface StackView {
  readonly id: string;
  readonly axis: { readonly origin: Vec3; readonly direction: Vec3 };
  /** Plates in stack order, each with the entity id of the plate. */
  readonly layers: readonly { readonly entityId: string; readonly thickness: number }[];
  readonly familyId: string;
  readonly diameterDash: string;
  /** Hole diameter in document units (0 = no hole cut). */
  readonly holeDiameter: number;
  readonly washerCount: number;
  readonly hasNut: boolean;
  /** Nominal diameter of the fastener in document units, from the catalogue size; null when the catalogue does not hold it. */
  readonly nominalDiameter: number | null;
}

const isVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Nominal diameter of size `dash` of family `familyId`, document units. */
function nominalDiameterOf(doc: CadDocument, fasteners: Record<string, unknown>, familyId: string, dash: string): number | null {
  const catalogs = fasteners['catalogs'];
  const family = isRecord(catalogs) && Object.hasOwn(catalogs, familyId) ? catalogs[familyId] : undefined;
  const sizes = isRecord(family) && Array.isArray(family['sizes']) ? family['sizes'] : [];
  const size = sizes.find((entry) => isRecord(entry) && entry['dash'] === dash);
  const quantity = isRecord(size) ? size['nominalDiameter'] : undefined;
  if (!isRecord(quantity) || typeof quantity['value'] !== 'number' || typeof quantity['unit'] !== 'string') return null;
  const millimetres = convertValue(quantity['value'], quantity['unit'], 'mm');
  return isUnitFailure(millimetres) ? null : fromMm(doc, millimetres.value);
}

/**
 * Stack `stackId` of the document, or why it cannot be read.
 * @failure no fasteners slice / unknown stack / a field of the stack malformed -> { message }
 */
export function readStack(doc: CadDocument, stackId: string): StackView | { readonly message: string } {
  const fasteners = (doc as unknown as Record<string, unknown>)['fasteners'];
  if (!isRecord(fasteners) || !isRecord(fasteners['stacks']))
    return { message: 'the document has no fastener stacks (insert_fastener / insert_fastener_row first)' };
  const stacks = fasteners['stacks'];
  const raw = Object.hasOwn(stacks, stackId) ? stacks[stackId] : undefined;
  if (!isRecord(raw)) return { message: `no fastener stack '${stackId}' in the document` };
  const axis = raw['axis'];
  const layers = raw['layers'];
  const fastener = raw['fastener'];
  if (
    !isRecord(axis) ||
    !isVec3(axis['origin']) ||
    !isVec3(axis['direction']) ||
    !Array.isArray(layers) ||
    layers.length === 0 ||
    !isRecord(fastener) ||
    !isText(fastener['family']) ||
    !isText(fastener['diameterDash']) ||
    !isCount(raw['holeDiameter'])
  )
    return { message: `fastener stack '${stackId}' is malformed (axis, layers, fastener or holeDiameter)` };
  const plates = layers.flatMap((layer) =>
    isRecord(layer) && isText(layer['entityId']) && isCount(layer['thickness'])
      ? [{ entityId: layer['entityId'], thickness: layer['thickness'] }]
      : [],
  );
  if (plates.length !== layers.length) return { message: `fastener stack '${stackId}' has a layer without entityId / thickness` };
  const washers = raw['washers'];
  return {
    id: stackId,
    axis: { origin: axis['origin'], direction: axis['direction'] },
    layers: plates,
    familyId: fastener['family'],
    diameterDash: fastener['diameterDash'],
    holeDiameter: raw['holeDiameter'],
    washerCount: Array.isArray(washers) ? washers.length : 0,
    hasNut: raw['nut'] !== undefined,
    nominalDiameter: nominalDiameterOf(doc, fasteners, fastener['family'], fastener['diameterDash']),
  };
}
