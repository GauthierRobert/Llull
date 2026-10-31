/** Equipment, nozzles, lines, segments, components, off-page connectors and flow arrows as Proteus elements (plant 04 PID §6.3). */

import type { PidEquipment, PidInline, PidItem, PidLine, PidNozzle, PidOffPage } from '../model';
import { attributeNodes, equipmentTag } from './exportAttributes';
import type { Chain } from './exportChains';
import { centerLine, connectionPoints, endpointRef, identity, position, type ExportContext, warn } from './exportContext';
import { el, type XNode } from './xmlWrite';

function nozzleNode(ctx: ExportContext, nozzle: PidNozzle): XNode {
  const id = ctx.ids.get(nozzle.id) ?? '';
  return el('Nozzle', identity(ctx, nozzle, [['ComponentName', nozzle.access === true ? 'MANHOLE' : undefined]]), [
    position(nozzle.at, nozzle.rotationDeg),
    connectionPoints(id, [nozzle.port], ctx.claim),
    ...attributeNodes(nozzle, { set: { SubTagNameAssignmentClass: nozzle.subTag }, dn: nozzle.dn }),
  ]);
}

/** Equipment with its nozzles and sub-equipment (children in model order). */
export function equipmentNode(ctx: ExportContext, equipment: PidEquipment, children: ReadonlyMap<string, readonly PidItem[]>): XNode {
  const nested = (children.get(equipment.id) ?? []).map((child) =>
    child.kind === 'nozzle' ? nozzleNode(ctx, child) : child.kind === 'equipment' ? equipmentNode(ctx, child, children) : undefined,
  );
  return el('Equipment', identity(ctx, equipment), [
    position(equipment.at, equipment.rotationDeg),
    ...attributeNodes(equipment, { tag: equipmentTag }),
    ...nested.flatMap((node) => (node === undefined ? [] : [node])),
  ]);
}

function inlineNode(ctx: ExportContext, inline: PidInline): XNode {
  const id = ctx.ids.get(inline.id) ?? '';
  return el('PipingComponent', identity(ctx, inline), [
    position(inline.at, inline.rotationDeg),
    connectionPoints(id, inline.ports, ctx.claim),
    ...attributeNodes(inline, {
      tag: equipmentTag,
      dn: inline.dn,
      set: { PipingClassCodeAssignmentClass: inline.pipingClass },
      pass: {
        'pid:reversed': inline.reversed === true ? 'true' : null,
        'pid:operated': inline.operated === true && !ctx.actuated.has(inline.id) ? 'true' : null,
      },
    }),
  ]);
}

function connectorNode(ctx: ExportContext, opc: PidOffPage): XNode {
  const id = ctx.ids.get(opc.id) ?? '';
  const outgoing = opc.dexpiClass.startsWith('FlowOut');
  const dexpiClass =
    opc.direction === 'out'
      ? outgoing
        ? opc.dexpiClass
        : 'FlowOutPipeOffPageConnector'
      : outgoing
        ? 'FlowInPipeOffPageConnector'
        : opc.dexpiClass;
  const target = opc.targetSheet === undefined ? undefined : ctx.pid.sheets[opc.targetSheet]?.number;
  return el(
    'PipeOffPageConnector',
    [
      ['ID', id],
      ['ComponentClass', dexpiClass],
      ['ComponentClassURI', dexpiClass === opc.dexpiClass ? opc.classUri : undefined],
    ],
    [
      position(opc.at, opc.rotationDeg),
      connectionPoints(id, [opc.at], ctx.claim),
      ...attributeNodes(opc, {
        set: { PipeConnectorNumberAssignmentClass: opc.pairKey === opc.sourceId ? undefined : opc.pairKey },
        ...(target === undefined ? {} : { pass: { 'pid:targetSheet': target } }),
      }),
    ],
  );
}

function extraNode(ctx: ExportContext, item: PidItem): XNode | undefined {
  if (item.kind === 'opc') return connectorNode(ctx, item);
  if (item.kind !== 'annotation') return undefined;
  return el(
    'PipeFlowArrow',
    [
      ['ID', ctx.ids.get(item.id)],
      ['ComponentClass', 'PipeFlowArrow'],
      ['ComponentClassURI', item.classUri],
    ],
    [position(item.at, item.rotationDeg), ...attributeNodes(item)],
  );
}

function segmentNode(ctx: ExportContext, chain: Chain, line: PidLine): XNode {
  const head = chain.head;
  const component = (id: string | undefined): XNode[] => {
    const item = id === undefined ? undefined : ctx.pid.items[id];
    return item?.kind === 'inline' ? [inlineNode(ctx, item)] : [];
  };
  const first = chain.pieces[0];
  const last = chain.pieces[chain.pieces.length - 1];
  const body: XNode[] = [...component(chain.leading)];
  chain.pieces.forEach((piece, index) => {
    body.push(centerLine(piece.route));
    body.push(...component(chain.inner[index]));
  });
  body.push(...component(chain.trailing));
  for (const id of chain.extras) {
    const item = ctx.pid.items[id];
    const node = item === undefined ? undefined : extraNode(ctx, item);
    if (node !== undefined) body.push(node);
  }
  const from = endpointRef(ctx, first?.from ?? { type: 'free', at: [0, 0] }, head.id);
  const to = endpointRef(ctx, last?.to ?? { type: 'free', at: [0, 0] }, head.id);
  // A trailing component sits in the segment: the importer reads the Connection node as its exit and takes the other port as the entry.
  if (last?.to.type === 'inline' && last.to.itemId === chain.trailing && to.id !== undefined) {
    const entry = last.to.node;
    const ports = ctx.pid.items[chain.trailing];
    const exit = Array.from({ length: ports?.kind === 'inline' ? ports.ports.length : 0 }, (_, index) => index).find(
      (index) => index !== entry,
    );
    if (exit !== undefined) to.node = String(exit + 1);
  }
  if (head.flow !== 'none' || from.id !== undefined || to.id !== undefined) {
    ctx.connections++;
    body.push(
      el('Connection', [
        ['FromID', from.id],
        ['FromNode', from.node],
        ['ToID', to.id],
        ['ToNode', to.node],
      ]),
    );
  }
  const secondary = head.attributes['PrimarySecondaryPipingNetworkSegmentSpecialization'];
  const wantsSecondary = !head.primary;
  const isSecondary = secondary?.kind !== undefined && secondary.kind !== 'quantity' && secondary.value === 'SecondaryPipingNetworkSegment';
  return el(
    'PipingNetworkSegment',
    identity(ctx, head).map(([key, value]) => (key === 'ID' ? [key, ctx.chainIds.get(head.id)] : [key, value])),
    [
      ...attributeNodes(head, {
        dn: head.dn !== undefined && head.dn !== line.dn ? head.dn : undefined,
        set: {
          PipingClassCodeAssignmentClass:
            head.pipingClass !== undefined && head.pipingClass !== line.pipingClass ? head.pipingClass : undefined,
          PrimarySecondaryPipingNetworkSegmentSpecialization:
            wantsSecondary === isSecondary ? undefined : wantsSecondary ? 'SecondaryPipingNetworkSegment' : 'PrimaryPipingNetworkSegment',
        },
      }),
      ...body,
    ],
  );
}

/** A line with the DEXPI segments of its chains. */
export function lineNode(ctx: ExportContext, line: PidLine): XNode {
  return el('PipingNetworkSystem', identity(ctx, line), [
    ...attributeNodes(line, {
      dn: line.dn,
      set: {
        LineNumberAssignmentClass: line.lineNumber,
        FluidCodeAssignmentClass: line.fluidCode,
        PipingClassCodeAssignmentClass: line.pipingClass,
      },
    }),
    ...(ctx.chains.byLine.get(line.id) ?? []).map((chain) => segmentNode(ctx, chain, line)),
  ]);
}

export function warnUnplaced(ctx: ExportContext): void {
  const ids = ctx.chains.unplaced;
  if (ids.length > 0)
    warn(
      ctx,
      'DEXPI_EXPORT_ITEM_SKIPPED',
      `${ids.length} item(s) belong in a piping segment but no segment exists on their sheet (or the item is a component no segment passes): not written`,
      ids.slice(0, 20),
    );
}
