// Pure builders of the model highlight for the Fasteners panel: a placed stack (its layers, fastener, washers and nut + a beacon on the axis
// with size / part number) and a layout finding (the offending stacks with the message).

import type { FastenerStack } from '@core/model/fasteners';
import type { CadDocument } from '@core/model/types';
import type { PanelFocus } from '@ui/store/focusStore';

export const FASTENER_COLOR = '#ffd54f';
const FINDING_COLORS = { error: '#ff4d4f', warning: '#ffb300' } as const;

const stackEntityIds = (stack: FastenerStack): string[] => [
  ...new Set([
    ...stack.layers.map((layer) => layer.entityId),
    stack.fastener.instanceId,
    ...stack.washers.map((washer) => washer.instanceId),
    ...(stack.nut === undefined ? [] : [stack.nut.instanceId]),
  ]),
];

export function stackFocus(stack: FastenerStack): PanelFocus {
  const label = `${stack.fastener.partNumber} · -${stack.fastener.diameterDash}`;
  return {
    key: `fasteners:stack:${stack.id}`,
    label,
    color: FASTENER_COLOR,
    entityIds: stackEntityIds(stack),
    markers: [{ position: stack.axis.origin, label }],
  };
}

export function layoutFindingFocus(
  doc: CadDocument,
  finding: { code: string; severity: string; stackIds: readonly string[]; message: string },
): PanelFocus {
  const stacks = finding.stackIds.flatMap((id) => {
    const stack = doc.fasteners?.stacks[id];
    return stack === undefined ? [] : [stack];
  });
  return {
    key: `fasteners:finding:${finding.code}:${finding.stackIds.join(',')}`,
    label: `${finding.code} · ${finding.message}`,
    color: finding.severity === 'error' ? FINDING_COLORS.error : FINDING_COLORS.warning,
    entityIds: [...new Set(stacks.flatMap(stackEntityIds))],
    markers: stacks.map((stack) => ({ position: stack.axis.origin, label: finding.message || finding.code })),
  };
}
