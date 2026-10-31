/** Second pass: InformationFlow -> `PidSignal` (plant 04 PID §6.1). Ends come from the Connection, else from the logical start / end associations. */

import { xmlAttr, xmlChildren } from '@lib/xmlRead';
import type { Vec2 } from '@core/model/vectors';
import type { PidSignal } from '../model';
import { endpointOf, pointOfEndpoint } from './proteusConnect';
import {
  addItem,
  associations,
  baseOf,
  centerLinePoints,
  toNumber,
  readAttributes,
  type ImportContext,
  type Pending,
} from './proteusContext';

function signalKind(dexpiClass: string): PidSignal['signalKind'] {
  const name = dexpiClass.toLowerCase();
  if (name.includes('measuring')) return 'measuring';
  if (name.includes('pneumatic')) return 'pneumatic';
  if (name.includes('software') || name.includes('data')) return 'software';
  if (name.includes('capillary')) return 'capillary';
  return 'electric';
}

export function buildFlows(ctx: ImportContext, pending: Pending): void {
  for (const el of pending.flows) {
    const connection = xmlChildren(el, 'Connection')[0];
    const points = centerLinePoints(ctx, el);
    const fromId = (connection && xmlAttr(connection, 'FromID')) ?? associations(el, 'has logical start')[0];
    const toId = (connection && xmlAttr(connection, 'ToID')) ?? associations(el, 'has logical end')[0];
    const node = (name: string): number | undefined => (connection === undefined ? undefined : toNumber(xmlAttr(connection, name)));
    const anchor: Vec2 = points[0] ?? [0, 0];
    const from = endpointOf(ctx, fromId, node('FromNode'), anchor, connection ?? el);
    const to = endpointOf(ctx, toId, node('ToNode'), points[points.length - 1] ?? anchor, connection ?? el);
    const route = points.length >= 2 ? points : [pointOfEndpoint(ctx, from), pointOfEndpoint(ctx, to)];
    const dexpiClass = xmlAttr(el, 'ComponentClass') || 'InformationFlow';
    const base = baseOf(ctx, el, dexpiClass, readAttributes(ctx, el), { at: route[0] });
    addItem(ctx, { ...base, kind: 'signal', signalKind: signalKind(dexpiClass), from, to, route });
  }
}
