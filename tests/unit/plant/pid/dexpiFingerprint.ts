/** Model fingerprint of the DEXPI tests: what two models must agree on to be "the same P&ID", without item ids and without what an encoding cannot carry. */

import type { CadDocument } from '@core/model/types';
import type { PidEndpoint, PidItem, PidModel } from '@aec/plant/pid/model';
import { getPid } from '@aec/plant/pid/state';

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const point = (p: readonly [number, number]): [number, number] => [round(p[0]), round(p[1])];

/** Name of an item in the file it came from: its source id with `-` dropped (1.3 ids are `Class-n`, the 2.0 reference writes `Classn`). */
const nameOf = (pid: PidModel, id: string): string => {
  const item = pid.items[id];
  if (item === undefined) return '?';
  return (item.kind === 'loop' ? (item.tag ?? item.kind) : (item.sourceId ?? item.tag ?? item.kind)).replace(/-/g, '');
};

function endpoint(pid: PidModel, end: PidEndpoint): unknown {
  switch (end.type) {
    case 'free':
      return ['free', point(end.at)];
    case 'branch':
      return ['branch', nameOf(pid, end.segmentId)];
    case 'inline':
      return ['inline', nameOf(pid, end.itemId), end.node];
    default:
      return [end.type, nameOf(pid, end.itemId)];
  }
}

const IGNORED_PASSTHROUGH = /^(dexpi:association)$/;

export function fingerprint(doc: CadDocument, options: { geometry: boolean }): string[] {
  const pid = getPid(doc);
  const lines: string[] = [];
  for (const id of pid.itemOrder) {
    const item = pid.items[id] as PidItem;
    const base: Record<string, unknown> = {
      kind: item.kind,
      class: item.passthrough?.['dexpi:ComponentClass'] ?? item.dexpiClass.replace(/^(Process|Access|Instrument)?Nozzle$/, 'Nozzle'),
      name: item.kind === 'segment' || item.dexpiClass === 'PipeFlowArrow' ? undefined : nameOf(pid, id),
      tag: item.tag,
      attributes: Object.fromEntries(
        Object.entries(item.attributes)
          .map(([key, value]) => [key, value.kind === 'quantity' ? `${value.value} ${value.unit}` : value.value] as const)
          .sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
      passthrough: Object.fromEntries(
        Object.entries(item.passthrough ?? {})
          .filter(([key]) => !IGNORED_PASSTHROUGH.test(key))
          .sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    };
    if (options.geometry) {
      base['at'] = item.kind === 'segment' ? undefined : point(item.at);
      base['rot'] = round(item.rotationDeg);
    }
    switch (item.kind) {
      case 'equipment':
        base['parent'] = item.parentId === undefined ? undefined : nameOf(pid, item.parentId);
        break;
      case 'nozzle':
        Object.assign(base, {
          equipment: nameOf(pid, item.equipmentId),
          subTag: item.subTag,
          dn: item.dn,
          access: item.access,
          port: options.geometry ? point(item.port) : undefined,
        });
        break;
      case 'line':
        Object.assign(base, {
          lineNumber: item.lineNumber,
          dn: item.dn,
          pipingClass: item.pipingClass,
          fluidCode: item.fluidCode,
          segments: item.segmentIds.length,
        });
        break;
      case 'segment':
        Object.assign(base, {
          line: nameOf(pid, item.lineId),
          from: endpoint(pid, item.from),
          to: endpoint(pid, item.to),
          route: options.geometry ? item.route.map(point) : undefined,
          flow: item.flow,
          dn: item.dn,
          pipingClass: item.pipingClass,
          primary: item.primary,
        });
        break;
      case 'inline':
        Object.assign(base, {
          dn: item.dn,
          pipingClass: item.pipingClass,
          reversed: item.reversed,
          operated: item.operated,
          ports: options.geometry ? item.ports.map(point) : undefined,
        });
        break;
      case 'instrument':
        Object.assign(base, {
          category: item.category,
          functions: item.functions,
          loopNumber: item.loopNumber,
          location: item.location,
          display: item.display,
          loop: item.loopId === undefined ? undefined : nameOf(pid, item.loopId),
        });
        break;
      case 'signal':
        Object.assign(base, {
          signalKind: item.signalKind,
          from: endpoint(pid, item.from),
          to: endpoint(pid, item.to),
          route: options.geometry ? item.route.map(point) : undefined,
        });
        break;
      case 'actuating':
        Object.assign(base, {
          valve: nameOf(pid, item.valveId),
          actuator: item.actuator,
          failAction: item.failAction,
          controller: item.controllerId === undefined ? undefined : nameOf(pid, item.controllerId),
        });
        break;
      case 'opc':
        Object.assign(base, { direction: item.direction, pairKey: item.pairKey });
        break;
      default:
        break;
    }
    lines.push(JSON.stringify(base));
  }
  return lines.sort();
}
