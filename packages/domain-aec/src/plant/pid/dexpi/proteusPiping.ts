/** Proteus PipingNetworkSystem, PipingComponent, PipeOffPageConnector and PipeFlowArrow -> line, inline, opc and annotation items (first pass). */

import { xmlAttr, xmlChildren, type XmlElement } from '@lib/xmlRead';
import type { Vec2 } from '@core/model/vectors';
import { KNOWN_PIPING_CLASSES } from './proteusClasses';
import {
  addItem,
  baseOf,
  classify,
  diameterOf,
  dropGraphics,
  pointOf,
  portsOf,
  readAttributes,
  register,
  tagOf,
  type ImportContext,
  type Pending,
} from './proteusContext';

function mapComponent(ctx: ImportContext, el: XmlElement, pending: Pending): void {
  const read = readAttributes(ctx, el);
  const known = classify(ctx, el, KNOWN_PIPING_CLASSES);
  const { ports, nodePort } = portsOf(ctx, el);
  const base = baseOf(ctx, el, known.dexpiClass, read, { passthrough: known.passthrough, tag: tagOf(read) });
  const first = ports[0];
  const last = ports[ports.length - 1];
  const at: Vec2 =
    xmlChildren(el, 'Position').length === 0 && first !== undefined && last !== undefined
      ? [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2]
      : base.at;
  const padded: Vec2[] = [...ports];
  while (padded.length < 2) padded.push(at);
  const dn = diameterOf(read);
  const pipingClass = read.raw.get('PipingClassCodeAssignmentClass');
  addItem(ctx, {
    ...base,
    at,
    kind: 'inline',
    ports: padded,
    ...(dn === undefined ? {} : { dn }),
    ...(pipingClass === undefined ? {} : { pipingClass }),
    ...(read.passthrough['pid:reversed'] === 'true' ? { reversed: true } : {}),
    ...(read.passthrough['pid:operated'] === 'true' ? { operated: true } : {}),
  });
  const ref = { type: 'inline', id: base.id, ports: padded, nodePort } as const;
  register(ctx, el, ref);
  pending.components.set(el, ref);
  dropGraphics(ctx, el);
}

function mapOffPageConnector(ctx: ImportContext, el: XmlElement): void {
  const read = readAttributes(ctx, el);
  const reference = xmlChildren(el, 'PipeOffPageConnectorReference')[0];
  const referenced =
    reference === undefined ? undefined : readAttributes(ctx, reference).raw.get('ReferencedConnectorNumberAssignmentClass');
  const cls = xmlAttr(el, 'ComponentClass') || 'PipeOffPageConnector';
  const pairKey = read.raw.get('PipeConnectorNumberAssignmentClass') || referenced || xmlAttr(el, 'ID') || `OPC@line ${el.line}`;
  const base = baseOf(ctx, el, cls, read, { at: portsOf(ctx, el).ports[0] });
  addItem(ctx, { ...base, kind: 'opc', direction: cls.startsWith('FlowOut') ? 'out' : 'in', pairKey });
  register(ctx, el, { type: 'opc', id: base.id });
  dropGraphics(ctx, el);
}

function firstPoint(ctx: ImportContext, system: XmlElement): Vec2 {
  for (const segment of xmlChildren(system, 'PipingNetworkSegment'))
    for (const line of xmlChildren(segment, 'CenterLine')) {
      const point = pointOf(ctx, xmlChildren(line, 'Coordinate')[0]);
      if (point !== undefined) return point;
    }
  return [0, 0];
}

/** A line (PipingNetworkSystem) with the items of its segments; the segments themselves are built by the second pass. */
export function mapPipingSystem(ctx: ImportContext, el: XmlElement, pending: Pending): void {
  const read = readAttributes(ctx, el);
  const dn = diameterOf(read);
  const pipingClass = read.raw.get('PipingClassCodeAssignmentClass');
  const lineNumber = read.raw.get('LineNumberAssignmentClass');
  const fluidCode = read.raw.get('FluidCodeAssignmentClass');
  const base = baseOf(ctx, el, xmlAttr(el, 'ComponentClass') || 'PipingNetworkSystem', read, { at: firstPoint(ctx, el) });
  addItem(ctx, {
    ...base,
    kind: 'line',
    segmentIds: [],
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(dn === undefined ? {} : { dn }),
    ...(pipingClass === undefined ? {} : { pipingClass }),
    ...(fluidCode === undefined ? {} : { fluidCode }),
  });
  register(ctx, el, { type: 'other' });
  for (const segment of xmlChildren(el, 'PipingNetworkSegment')) {
    pending.segments.push({ el: segment, lineId: base.id, dn, pipingClass });
    for (const child of xmlChildren(segment)) {
      if (child.local === 'PipingComponent') mapComponent(ctx, child, pending);
      else if (child.local === 'PipeOffPageConnector') mapOffPageConnector(ctx, child);
      else if (child.local === 'PipeFlowArrow') {
        const arrow = readAttributes(ctx, child);
        addItem(ctx, { ...baseOf(ctx, child, 'PipeFlowArrow', arrow), kind: 'annotation' });
      }
    }
    dropGraphics(ctx, segment);
  }
  dropGraphics(ctx, el);
}
