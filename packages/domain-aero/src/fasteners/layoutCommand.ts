/** check_fastener_layout (08 MAT FR-MAT-18, M7): re-measures placed stacks and checks grip, pitch and part geometry after upstream edits. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { FastenerStack } from '@core/model/fasteners';
import { add3, cross3, distance3, normalize3, scale3 } from '@lib/vec3';
import { fastenerError, remediationFor } from './codes';
import { familyOf, fastenerModel } from './fastenerDoc';
import { componentIdOf } from './partGeometry';
import { measureStack } from './stackMeasure';
import { CONTACT_TOLERANCE_IN, docToInches, inchesToDoc, toTicks } from './units';

interface LayoutItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly stackIds: readonly string[];
  readonly message: string;
  readonly remediation: string;
  readonly values?: Readonly<Record<string, number>>;
}

const item = (
  code: string,
  severity: LayoutItem['severity'],
  stackIds: readonly string[],
  message: string,
  values?: Record<string, number>,
): LayoutItem => ({ code, severity, stackIds, message, remediation: remediationFor(code), ...(values === undefined ? {} : { values }) });

/** Ray origins to try: the axis itself, or (after a hole was cut there) points just outside the hole. */
function probes(stack: FastenerStack, tolerance: number): Vec3[] {
  const direction = normalize3(stack.axis.direction);
  if (stack.holeDiameter === 0) return [stack.axis.origin];
  const first = normalize3(cross3(direction, Math.abs(direction[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const second = cross3(direction, first);
  const offset = (stack.holeDiameter / 2) * 1.1 + 10 * tolerance;
  return [first, scale3(first, -1), second, scale3(second, -1)].map((unit) => add3(stack.axis.origin, scale3(unit, offset)));
}

function checkStack(doc: CadDocument, stack: FastenerStack): LayoutItem[] {
  const items: LayoutItem[] = [];
  const tolerance = inchesToDoc(doc, CONTACT_TOLERANCE_IN);
  const instanceIds = [
    stack.fastener.instanceId,
    ...stack.washers.map((washer) => washer.instanceId),
    ...(stack.nut ? [stack.nut.instanceId] : []),
  ];
  const lostInstances = instanceIds.filter((id) => doc.entities[id] === undefined);
  if (lostInstances.length > 0)
    items.push(
      item('FAST_INSTANCE_MISSING', 'error', [stack.id], `instance(s) [${lostInstances.join(', ')}] of stack ${stack.id} no longer exist`),
    );
  const ids = stack.layers.map((layer) => layer.entityId);
  const direction = normalize3(stack.axis.direction);
  let failure = 'no probe point';
  let measured: ReturnType<typeof measureStack> | null = null;
  for (const origin of probes(stack, tolerance)) {
    measured = measureStack(doc, ids, origin, direction, tolerance);
    if (measured.ok) break;
    failure = `${measured.code}: ${measured.message}`;
    if (measured.code === 'FAST_LAYER_MISSING') break;
  }
  if (measured === null || !measured.ok) {
    const code = measured !== null && !measured.ok ? measured.code : 'FAST_AXIS_MISS';
    items.push(item(code, 'error', [stack.id], `stack ${stack.id} cannot be re-measured (${failure})`));
    return items;
  }
  const recordedIn = docToInches(doc, stack.stackThickness);
  const measuredIn = docToInches(doc, measured.thickness);
  if (Math.abs(recordedIn - measuredIn) > CONTACT_TOLERANCE_IN)
    items.push(
      item(
        'FAST_REGRIP_NEEDED',
        'warning',
        [stack.id],
        `stack ${stack.id} is now ${measuredIn} in thick, was ${recordedIn} in when inserted`,
        { recordedIn, measuredIn },
      ),
    );
  const parts = [
    stack.fastener.partNumber,
    ...stack.washers.map((washer) => washer.partNumber),
    ...(stack.nut ? [stack.nut.partNumber] : []),
  ];
  for (const partNumber of new Set(parts))
    if (doc.components[componentIdOf(partNumber)]?.partRef?.representative === true)
      items.push(
        item('FAST_GEOMETRY_REPRESENTATIVE', 'warning', [stack.id], `${partNumber} uses placeholder proportions; excluded from mass`),
      );
  return items;
}

function pitchItems(doc: CadDocument, stacks: readonly FastenerStack[]): LayoutItem[] {
  const items: LayoutItem[] = [];
  const all = Object.values(fastenerModel(doc).stacks);
  for (const stack of stacks) {
    const family = familyOf(doc, stack.fastener.family);
    const size = family?.sizes.find((candidate) => candidate.dash === stack.fastener.diameterDash);
    if (family?.lengthRule?.kind !== 'stack_plus_k_d' || size === undefined) continue;
    const minimum = 3 * inchesToDoc(doc, (toTicks(size.nominalDiameter.value, size.nominalDiameter.unit, 'in') ?? 0) / 1e6);
    const layerKey = stack.layers.map((layer) => layer.entityId).join(',');
    for (const other of all) {
      if (other.id <= stack.id || other.layers.map((layer) => layer.entityId).join(',') !== layerKey) continue;
      const spacing = distance3(stack.axis.origin, other.axis.origin);
      if (spacing < minimum - 1e-9)
        items.push(
          item(
            'FAST_PITCH',
            'warning',
            [stack.id, other.id],
            `stacks ${stack.id} and ${other.id} are ${docToInches(doc, spacing)} in apart, below 3 D`,
            { pitchIn: docToInches(doc, spacing), minPitchIn: docToInches(doc, minimum) },
          ),
        );
    }
  }
  return items;
}

/**
 * @affects nothing (query)
 * @failure unknown stack id -> FAST_STACK_NOT_FOUND; a changed stack -> FAST_REGRIP_NEEDED (warning); a deleted or replaced layer -> FAST_LAYER_MISSING (error)
 */
export const checkFastenerLayout = defineCommand({
  name: 'check_fastener_layout',
  annotations: { readOnly: true },
  description:
    'Check the placed fastener stacks (read-only; end every fastener job with it). Re-measures each stack along its axis and reports FAST_REGRIP_NEEDED when the ' +
    'thickness changed since insertion (re-run select_fastener and re-insert), FAST_LAYER_MISSING / FAST_LAYER_GAP / FAST_AXIS_MISS when the plates changed, ' +
    'FAST_PITCH for rivets closer than 3 D, and FAST_GEOMETRY_REPRESENTATIVE for parts built from placeholder proportions. data.items lists code, severity, stackIds, ' +
    'message and remediation; data.status is pass / warn / fail. No stackIds = every stack.',
  params: z.object({
    stackIds: z.array(z.string()).describe('Stack ids (fst-…) to check. Default: all stacks in the document.').optional(),
  }),
  run: (doc, { stackIds }): CommandResult => {
    const known = fastenerModel(doc).stacks;
    const missing = (stackIds ?? []).filter((id) => !Object.hasOwn(known, id));
    if (missing.length > 0)
      return {
        ...report(doc, `check_fastener_layout: stack(s) [${missing.join(', ')}] not found.`, {
          status: 'fail',
          stacksChecked: 0,
          items: [item('FAST_STACK_NOT_FOUND', 'error', missing, `stack(s) [${missing.join(', ')}] not found`)],
        }),
        error: fastenerError('FAST_STACK_NOT_FOUND', missing),
      };
    const stacks = stackIds === undefined ? Object.values(known) : stackIds.flatMap((id) => (known[id] === undefined ? [] : [known[id]]));
    const items = [...stacks.flatMap((stack) => checkStack(doc, stack)), ...pitchItems(doc, stacks)];
    const status = items.some((entry) => entry.severity === 'error') ? 'fail' : items.length > 0 ? 'warn' : 'pass';
    const summary = `check_fastener_layout: ${status} — ${stacks.length} stack(s), ${items.length} finding(s)${items.length > 0 ? ` (${[...new Set(items.map((entry) => entry.code))].join(', ')})` : ''}.`;
    const first = items.find((entry) => entry.severity === 'error');
    return {
      ...report(doc, summary, { status, stacksChecked: stacks.length, items }),
      ...(first === undefined ? {} : { error: fastenerError(first.code, first.stackIds) }),
    };
  },
});
