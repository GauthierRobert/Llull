/**
 * The placed fastener stacks of the document (aerospace 08 MAT, plugin `fasteners`), obtained by composing the read-only command `list_fastener_stacks`
 * through `execute` (L10: no import of the fasteners plugin, no knowledge of its slice). The answer is validated structurally: only the fields the joint
 * set-up needs, a renamed field of the command output is a refusal, not a silent default.
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { execute } from '@core/commands/registry';
import { isRecord } from '@lib/isRecord';

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

/**
 * Stack `stackId` of the document, or why it cannot be read.
 * @failure fasteners plugin not installed / no such stack / a field of the answer malformed -> { message }
 */
export function stackOf(doc: CadDocument, stackId: string): StackView | { readonly message: string } {
  const answer = execute(doc, 'list_fastener_stacks', { stackId });
  if (answer.rejected === true) return { message: `the fasteners plugin cannot list stacks (${answer.summary})` };
  const list = isRecord(answer.data) ? answer.data['stacks'] : undefined;
  const raw: unknown = Array.isArray(list) ? list[0] : undefined;
  if (!isRecord(raw))
    return { message: `no fastener stack '${stackId}' in the document (insert_fastener_stack / insert_fastener_row first)` };
  const { axis, layers } = raw;
  if (
    raw['id'] !== stackId ||
    !isRecord(axis) ||
    !isVec3(axis['origin']) ||
    !isVec3(axis['direction']) ||
    !Array.isArray(layers) ||
    layers.length === 0 ||
    !isText(raw['familyId']) ||
    !isText(raw['diameterDash']) ||
    !isCount(raw['holeDiameter']) ||
    !isCount(raw['washerCount']) ||
    typeof raw['hasNut'] !== 'boolean' ||
    !(raw['nominalDiameter'] === null || isCount(raw['nominalDiameter']))
  )
    return {
      message: `fastener stack '${stackId}' is malformed in the list_fastener_stacks answer (id, axis, layers, familyId, diameterDash, holeDiameter, washerCount, hasNut, nominalDiameter)`,
    };
  const plates = layers.flatMap((layer) =>
    isRecord(layer) && isText(layer['entityId']) && isCount(layer['thickness'])
      ? [{ entityId: layer['entityId'], thickness: layer['thickness'] }]
      : [],
  );
  if (plates.length !== layers.length) return { message: `fastener stack '${stackId}' has a layer without entityId / thickness` };
  return {
    id: stackId,
    axis: { origin: axis['origin'], direction: axis['direction'] },
    layers: plates,
    familyId: raw['familyId'],
    diameterDash: raw['diameterDash'],
    holeDiameter: raw['holeDiameter'],
    washerCount: raw['washerCount'],
    hasNut: raw['hasNut'],
    nominalDiameter: raw['nominalDiameter'],
  };
}
