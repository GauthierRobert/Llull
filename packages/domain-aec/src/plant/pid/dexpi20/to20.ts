/**
 * The Proteus-shaped tree the exporter builds (plant 04 PID §6.3) -> a DEXPI 2.0 `<Model>` (§6.2). The data keeps the structure of the reference file
 * (`Plant/PlantModel` with tagged plant items, piping network systems / segments / items / pipes, instrumentation, loops, actuating systems), positions
 * and routes go to the `Core/Diagram`. The conversion is a pure function of the tree, so the 2.0 bytes are as deterministic as the 1.3 ones.
 */

import { el, type XNode } from '../export/xmlWrite';
import { encodeName } from './names20';
import {
  arrowGroup,
  border,
  connectorGroup,
  connectorLine,
  diagramComponents,
  itemGroup,
  placementOf,
  representation,
  type PositionedNode,
} from './to20Diagram';
import { ASSOCIATION_PROPERTY } from './names20';
import { attrOf, childrenOf, components, dataNodes, dataString, object, references, typeOf } from './to20Nodes';

interface Writer {
  readonly used: Set<string>;
  readonly counters: Map<string, number>;
  /** Raw element id -> raw ids of its nodes, in order. */
  readonly nodesOf: Map<string, string[]>;
  /** Raw node id -> its position (text) and the id of its `NodePosition` object. */
  readonly positioned: Map<string, PositionedNode>;
  readonly groups: XNode[];
  /** Raw id of an instrument -> the information flows it holds. */
  readonly flows: Map<string, XNode[]>;
  shape: string;
  classUris: number;
  /** `Connection` elements the Proteus reading of the file will have (segments and flows with a known end). */
  connections: number;
}

export interface To20 {
  readonly root: XNode;
  /** Kinds of content the 2.0 file cannot hold (for the export's info finding). */
  readonly dropped: readonly string[];
  /** Census key `connections` of the file as the importer reads it. */
  readonly connections: number;
}

const id = (raw: string | undefined): string | undefined => (raw === undefined || raw === '' ? undefined : encodeName(raw));

function claim(w: Writer, prefix: string): string {
  let n = w.counters.get(prefix) ?? 0;
  let name: string;
  do name = `${prefix}${++n}`;
  while (w.used.has(name));
  w.counters.set(prefix, n);
  w.used.add(name);
  return name;
}

/** Pre-pass: every id (so generated ones never clash), the nodes of each element with their positions and `NodePosition` ids. Iterative. */
function scan(root: XNode, w: Writer): void {
  const stack: XNode[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const raw = attrOf(node, 'ID');
    if (raw !== undefined) w.used.add(encodeName(raw));
    if (attrOf(node, 'ComponentClassURI') !== undefined) w.classUris++;
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index] as XNode);
  }
  const owners: XNode[] = [];
  stack.push(root);
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (attrOf(node, 'ID') !== undefined && childrenOf(node, 'ConnectionPoints').length > 0) owners.push(node);
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index] as XNode);
  }
  for (const owner of owners) {
    const points = childrenOf(owner, 'ConnectionPoints')[0] as XNode;
    const nodes = childrenOf(points, 'Node');
    w.nodesOf.set(
      attrOf(owner, 'ID') as string,
      nodes.flatMap((n) => attrOf(n, 'ID') ?? []),
    );
    for (const n of nodes) {
      const place = placementOf(n);
      const raw = attrOf(n, 'ID');
      if (place !== undefined && raw !== undefined)
        w.positioned.set(raw, { node: encodeName(raw), position: claim(w, 'NodePosition'), x: place.x, y: place.y });
    }
  }
}

const className = (node: XNode, fallback: string): string => attrOf(node, 'ComponentClass') || fallback;

/** `Nodes` of an element: one `PipingNode` per node of its `ConnectionPoints`. */
function nodeObjects(node: XNode): XNode[] {
  const points = childrenOf(node, 'ConnectionPoints')[0];
  return components(
    'Nodes',
    (points === undefined ? [] : childrenOf(points, 'Node')).map((n) =>
      object('Plant/Piping.PipingNode', id(attrOf(n, 'ID')), dataNodes(n)),
    ),
  );
}

/** The positioned nodes of an element, with the ids assigned up front. */
function positionedNodesOf(w: Writer, node: XNode): PositionedNode[] {
  const raw = attrOf(node, 'ID');
  return (raw === undefined ? [] : (w.nodesOf.get(raw) ?? [])).flatMap((nodeId) => {
    const found = w.positioned.get(nodeId);
    return found === undefined ? [] : [found];
  });
}

function place(w: Writer, node: XNode): void {
  const raw = attrOf(node, 'ID');
  const group = id(raw) === undefined ? undefined : itemGroup(id(raw) as string, placementOf(node), positionedNodesOf(w, node), w.shape);
  if (group !== undefined) w.groups.push(group);
}

const typed = (prefix: string, node: XNode, fallback: string): string => typeOf(prefix, className(node, fallback));

const SUB_PROPERTY: Readonly<Record<string, string>> = {
  Chamber: 'Chambers',
  TubeBundle: 'TubeBundle',
  Impeller: 'Impellers',
  Displacer: 'Displacers',
};

function nozzleObject(w: Writer, node: XNode): XNode {
  place(w, node);
  const access = attrOf(node, 'ComponentName') === 'MANHOLE';
  const type = access ? 'Plant/ProcessEquipment.AccessNozzle' : typed('Plant/ProcessEquipment', node, 'Nozzle');
  return object(type, id(attrOf(node, 'ID')), [...dataNodes(node), ...nodeObjects(node)]);
}

function equipmentObject(w: Writer, node: XNode): XNode {
  place(w, node);
  const subs = new Map<string, XNode[]>();
  for (const child of childrenOf(node, 'Equipment')) {
    const sub = className(child, '');
    const property = Object.hasOwn(SUB_PROPERTY, sub) ? (SUB_PROPERTY[sub] as string) : 'SubEquipment';
    subs.set(property, [...(subs.get(property) ?? []), equipmentObject(w, child)]);
  }
  return object(typed('Plant/ProcessEquipment', node, 'Equipment'), id(attrOf(node, 'ID')), [
    ...dataNodes(node),
    ...[...subs].flatMap(([property, objects]) => components(property, objects)),
    ...components(
      'Nozzles',
      childrenOf(node, 'Nozzle').map((child) => nozzleObject(w, child)),
    ),
  ]);
}

function componentObject(w: Writer, node: XNode): XNode {
  place(w, node);
  return object(typed('Plant/Piping', node, 'PipingComponent'), id(attrOf(node, 'ID')), [...dataNodes(node), ...nodeObjects(node)]);
}

const squared = (node: PositionedNode, point: readonly [string, string]): number =>
  (Number(node.x) - Number(point[0])) ** 2 + (Number(node.y) - Number(point[1])) ** 2;

/** Raw id of the node of `owner` nearest to `point`, else its second node (the first is the default node), else its first. */
function nodeNear(w: Writer, owner: string, point: readonly [string, string] | undefined): string | undefined {
  const nodes = w.nodesOf.get(owner) ?? [];
  let best: string | undefined;
  let distance = Infinity;
  for (const raw of nodes) {
    const at = w.positioned.get(raw);
    if (at === undefined || point === undefined) continue;
    const d = squared(at, point);
    if (d < distance) {
      best = raw;
      distance = d;
    }
  }
  return best ?? nodes[Math.min(1, nodes.length - 1)];
}

const routeOf = (line: XNode): Array<readonly [string, string]> =>
  childrenOf(line, 'Coordinate').flatMap((c) => {
    const x = attrOf(c, 'X');
    const y = attrOf(c, 'Y');
    return x === undefined || y === undefined ? [] : [[x, y] as const];
  });

interface End {
  readonly item: string | undefined;
  readonly node: string | undefined;
}

function connectionEnd(w: Writer, connection: XNode | undefined, side: 'From' | 'To'): End {
  const item = connection === undefined ? undefined : attrOf(connection, `${side}ID`);
  const index = connection === undefined ? undefined : attrOf(connection, `${side}Node`);
  const node = item === undefined || index === undefined ? undefined : (w.nodesOf.get(item) ?? [])[Number(index)];
  return { item, node };
}

const endReferences = (side: 'Source' | 'Target', end: End): XNode[] => [
  ...references(`${side}Item`, [id(end.item)]),
  ...references(`${side}Node`, [id(end.node)]),
];

function segmentObject(w: Writer, node: XNode): XNode {
  const raw = attrOf(node, 'ID');
  const segmentId = id(raw) ?? claim(w, 'PipingNetworkSegment');
  const connection = childrenOf(node, 'Connection')[0];
  const steps = node.children.filter((child) => child.name === 'PipingComponent' || child.name === 'CenterLine');
  const items = node.children.filter((child) => child.name === 'PipingComponent' || child.name === 'PipeOffPageConnector');
  const start = connectionEnd(w, connection, 'From');
  const finish = connectionEnd(w, connection, 'To');
  if (start.item !== undefined || finish.item !== undefined) w.connections++;
  const pipes: XNode[] = [];
  const pipeGroups: XNode[] = [];
  steps.forEach((step, index) => {
    if (step.name !== 'CenterLine') return;
    const route = routeOf(step);
    const before = steps[index - 1];
    const after = steps[index + 1];
    const beforeId = before?.name === 'PipingComponent' ? attrOf(before, 'ID') : undefined;
    const afterId = after?.name === 'PipingComponent' ? attrOf(after, 'ID') : undefined;
    const source: End =
      beforeId === undefined
        ? start
        : { item: beforeId, node: start.item === beforeId && start.node !== undefined ? start.node : nodeNear(w, beforeId, route[0]) };
    const target: End = afterId === undefined ? finish : { item: afterId, node: nodeNear(w, afterId, route[route.length - 1]) };
    const pipeId = claim(w, 'Pipe');
    pipes.push(object('Plant/Piping.Pipe', pipeId, [...endReferences('Source', source), ...endReferences('Target', target)]));
    const from = source.node === undefined ? undefined : w.positioned.get(source.node);
    const to = target.node === undefined ? undefined : w.positioned.get(target.node);
    pipeGroups.push(connectorGroup(pipeId, connectorLine(route, from, to)));
  });
  const arrows = node.children.flatMap((child) => {
    const arrow = child.name === 'PipeFlowArrow' ? placementOf(child) : undefined;
    return arrow === undefined ? [] : [arrowGroup(arrow, w.shape)];
  });
  if (pipeGroups.length + arrows.length > 0) w.groups.push(representation(segmentId, components('Groups', [...pipeGroups, ...arrows])));
  return object(typed('Plant/Piping', node, 'PipingNetworkSegment'), segmentId, [
    ...dataNodes(node),
    ...components('Connections', pipes),
    ...components(
      'Items',
      items.map((item) => componentObject(w, item)),
    ),
    ...endReferences('Source', start),
    ...endReferences('Target', finish),
  ]);
}

function systemObject(w: Writer, node: XNode): XNode {
  return object(typed('Plant/Piping', node, 'PipingNetworkSystem'), id(attrOf(node, 'ID')), [
    ...dataNodes(node),
    ...components(
      'Segments',
      childrenOf(node, 'PipingNetworkSegment').map((segment) => segmentObject(w, segment)),
    ),
  ]);
}

function associationOf(node: XNode, type: string): string[] {
  return childrenOf(node, 'Association').flatMap((a) => (attrOf(a, 'Type') === type ? (attrOf(a, 'ItemID') ?? []) : []));
}

function flowObject(w: Writer, node: XNode): XNode {
  const raw = attrOf(node, 'ID');
  const connection = childrenOf(node, 'Connection')[0];
  const from = connectionEnd(w, connection, 'From');
  const to = connectionEnd(w, connection, 'To');
  const source = from.item ?? associationOf(node, 'has logical start')[0];
  const target = to.item ?? associationOf(node, 'has logical end')[0];
  const byAssociation = connection === undefined;
  if (!byAssociation && (source !== undefined || target !== undefined)) w.connections++;
  const line = childrenOf(node, 'CenterLine')[0];
  const flowId = id(raw) ?? claim(w, 'SignalConveyingFunction');
  if (line !== undefined) w.groups.push(connectorGroup(flowId, connectorLine(routeOf(line), undefined, undefined)));
  return object(typed('Plant/Instrumentation', node, 'SignalConveyingFunction'), flowId, [
    ...dataNodes(node),
    ...(byAssociation ? [dataString(ASSOCIATION_PROPERTY, 'true')] : []),
    ...references('Source', [id(source)]),
    ...references('SourceNode', [id(from.node)]),
    ...references('Target', [id(target)]),
    ...references('TargetNode', [id(to.node)]),
  ]);
}

/** The instrument a flow is written in: the one at its start, else the one at its end, else none (it goes to the plant model). */
function hostOf(node: XNode, instruments: ReadonlySet<string>): string | undefined {
  const connection = childrenOf(node, 'Connection')[0];
  const candidates = [
    connection === undefined ? undefined : attrOf(connection, 'FromID'),
    ...associationOf(node, 'has logical start'),
    connection === undefined ? undefined : attrOf(connection, 'ToID'),
    ...associationOf(node, 'has logical end'),
  ];
  return candidates.find((candidate) => candidate !== undefined && instruments.has(candidate));
}

function instrumentObject(w: Writer, node: XNode): XNode {
  place(w, node);
  const raw = attrOf(node, 'ID');
  const generating = childrenOf(node, 'ProcessSignalGeneratingFunction').map((child) => {
    place(w, child);
    const sensing = associationOf(child, 'is located in')[0];
    return object(typed('Plant/Instrumentation', child, 'ProcessSignalGeneratingFunction'), id(attrOf(child, 'ID')), [
      ...dataNodes(child),
      ...references('SensingLocation', [id(sensing)]),
    ]);
  });
  const actuating = childrenOf(node, 'ActuatingFunction').map((child) =>
    object(typed('Plant/Instrumentation', child, 'ActuatingFunction'), id(attrOf(child, 'ID')), [
      ...dataNodes(child),
      ...references('Systems', [id(associationOf(child, 'is fulfilled by')[0])]),
    ]),
  );
  return object(typed('Plant/Instrumentation', node, 'ProcessInstrumentationFunction'), id(raw), [
    ...dataNodes(node),
    ...components('ProcessSignalGeneratingFunctions', generating),
    ...components('ActuatingFunctions', actuating),
    ...components(
      'SignalConveyingFunctions',
      (raw === undefined ? [] : (w.flows.get(raw) ?? [])).map((flow) => flowObject(w, flow)),
    ),
  ]);
}

function loopObject(w: Writer, node: XNode): XNode {
  place(w, node);
  return object(typed('Plant/Instrumentation', node, 'InstrumentationLoopFunction'), id(attrOf(node, 'ID')), [
    ...dataNodes(node),
    ...references('ProcessInstrumentationFunctions', associationOf(node, 'is a collection including').map(id)),
  ]);
}

/** Attributes the controlled actuator of an actuating system holds in DEXPI 2.0; the rest stays on the system. */
const ACTUATOR_PROPERTIES = new Set(['DeviceTypeName', 'FailAction', 'FailActionRepresentation']);

function actuatingObject(w: Writer, node: XNode): XNode {
  const parts = childrenOf(node, 'ActuatingSystemComponent');
  const actuator = parts.find((part) => attrOf(part, 'ComponentClass') === 'ControlledActuator');
  const valve = parts.find((part) => attrOf(part, 'ComponentClass') === 'OperatedValveReference');
  if (actuator !== undefined) place(w, actuator);
  const own = dataNodes(node);
  const owner = (data: XNode): boolean => ACTUATOR_PROPERTIES.has(attrOf(data, 'property') ?? '');
  const valveId = valve === undefined ? undefined : associationOf(valve, 'refers to')[0];
  return object(typed('Plant/Instrumentation', node, 'ActuatingSystem'), id(attrOf(node, 'ID')), [
    ...own.filter((data) => !owner(data)),
    ...components('ControlledActuator', [
      object('Plant/Instrumentation.ControlledActuator', id(actuator === undefined ? undefined : attrOf(actuator, 'ID')), [
        ...own.filter(owner),
        ...(actuator === undefined ? [] : dataNodes(actuator)),
      ]),
    ]),
    ...components(
      'OperatedValveReference',
      valve === undefined
        ? []
        : [object('Plant/Instrumentation.OperatedValveReference', undefined, [...dataNodes(valve), ...references('Valve', [id(valveId)])])],
    ),
  ]);
}

function annotationObject(w: Writer, node: XNode, prefix: string): XNode {
  place(w, node);
  return object(typed(prefix, node, 'Item'), id(attrOf(node, 'ID')), dataNodes(node));
}

const flipped = (text: string | undefined, height: number): string | undefined =>
  text === undefined ? undefined : String(Math.round((height - Number(text)) * 1e9) / 1e9);

/** The tree in the DEXPI 2.0 frame (origin top left, Y down, angles clockwise): every Y becomes `height - Y`, the reference axis is mirrored. */
function mirrored(node: XNode, height: number): XNode {
  const attrs = node.attrs.map(([key, value]): readonly [string, string] => {
    if (key === 'Y' && (node.name === 'Location' || node.name === 'Coordinate')) return [key, flipped(value, height) ?? value];
    if (key === 'Y' && node.name === 'Reference') return [key, String(-Number(value) + 0)];
    return [key, value];
  });
  return { ...node, attrs, children: node.children.map((child) => mirrored(child, height)) };
}

/** The DEXPI 2.0 model of a Proteus-shaped export tree. */
export function toDexpi20(source: XNode): To20 {
  const drawingMax = childrenOf(source, 'Drawing')[0];
  const maxNode = drawingMax === undefined ? undefined : childrenOf(childrenOf(drawingMax, 'Extent')[0] ?? drawingMax, 'Max')[0];
  const root = mirrored(source, Number(maxNode === undefined ? 0 : (attrOf(maxNode, 'Y') ?? 0)));
  const w: Writer = {
    used: new Set(),
    counters: new Map(),
    nodesOf: new Map(),
    positioned: new Map(),
    groups: [],
    flows: new Map(),
    shape: '',
    classUris: 0,
    connections: 0,
  };
  scan(root, w);
  w.shape = claim(w, 'Shape');
  const plantId = claim(w, 'PlantModel');
  const writer = w;
  const of = (name: string): XNode[] => childrenOf(root, name);
  const instruments = new Set(of('ProcessInstrumentationFunction').flatMap((node) => attrOf(node, 'ID') ?? []));
  const loose: XNode[] = [];
  for (const flow of of('InformationFlow')) {
    const host = hostOf(flow, instruments);
    if (host === undefined) loose.push(flow);
    else writer.flows.set(host, [...(writer.flows.get(host) ?? []), flow]);
  }
  const metadata = of('MetaData');
  const structure = of('PlantStructureItem');
  const plant = object('Plant/PlantModel', plantId, [
    ...components(
      'ActuatingSystems',
      of('ActuatingSystem').map((node) => actuatingObject(writer, node)),
    ),
    ...components(
      'InstrumentationLoopFunctions',
      of('InstrumentationLoopFunction').map((node) => loopObject(writer, node)),
    ),
    ...components(
      'MetaData',
      metadata.map((node) => annotationObject(writer, node, 'Plant/Diagram')),
    ),
    ...components(
      'PipingNetworkSystems',
      of('PipingNetworkSystem').map((node) => systemObject(writer, node)),
    ),
    ...components(
      'PlantStructureItems',
      structure.map((node) => annotationObject(writer, node, 'Plant/PlantStructure')),
    ),
    ...components(
      'ProcessInstrumentationFunctions',
      of('ProcessInstrumentationFunction').map((node) => instrumentObject(writer, node)),
    ),
    ...components(
      'SignalConveyingFunctions',
      loose.map((node) => flowObject(writer, node)),
    ),
    ...components(
      'TaggedPlantItems',
      of('Equipment').map((node) => equipmentObject(writer, node)),
    ),
  ]);
  const drawing = of('Drawing')[0];
  const extent = drawing === undefined ? undefined : childrenOf(childrenOf(drawing, 'Extent')[0] ?? drawing, 'Max')[0];
  const width = extent === undefined ? undefined : attrOf(extent, 'X');
  const height = extent === undefined ? undefined : attrOf(extent, 'Y');
  const groups = [...(width === undefined || height === undefined ? [] : [border(width, height)]), ...writer.groups];
  const model = el(
    'Model',
    [
      ['name', 'LlullPid'],
      ['uri', 'urn:llull:pid'],
    ],
    [
      el('Import', [
        ['prefix', 'Core'],
        ['source', 'https://data.dexpi.org/models/2.0.1/Core.xml'],
      ]),
      el('Import', [
        ['prefix', 'Plant'],
        ['source', 'https://data.dexpi.org/models/2.0.1/Plant.xml'],
      ]),
      object('Core/EngineeringModel', undefined, [
        ...components('ConceptualModel', [plant]),
        ...diagramComponents(groups, drawing === undefined ? undefined : attrOf(drawing, 'Name'), writer.shape),
      ]),
    ],
  );
  return {
    root: model,
    connections: writer.connections,
    dropped: [...(writer.classUris > 0 ? ['class URIs'] : []), 'labels and text', 'flow arrow attributes'],
  };
}
