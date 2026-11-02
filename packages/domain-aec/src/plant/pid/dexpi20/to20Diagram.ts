/** The `Core/Diagram` written next to the DEXPI 2.0 plant model: item shapes, node positions, pipe and signal routes, flow arrows, border (plant 04 PID §6.3). */

import { el, type XNode } from '../export/xmlWrite';
import { attrOf, childrenOf, components, dataPoint, dataString, dataTyped, object, references } from './to20Nodes';

export interface Placement {
  readonly x: string;
  readonly y: string;
  /** Degrees CCW as text. */
  readonly rot: string;
}

/** Position / Reference of a Proteus element as the 2.0 shape placement. */
export function placementOf(node: XNode): Placement | undefined {
  const position = childrenOf(node, 'Position')[0];
  const location = position === undefined ? undefined : childrenOf(position, 'Location')[0];
  const x = location === undefined ? undefined : attrOf(location, 'X');
  const y = location === undefined ? undefined : attrOf(location, 'Y');
  if (x === undefined || y === undefined) return undefined;
  const reference = position === undefined ? undefined : childrenOf(position, 'Reference')[0];
  const rx = Number(reference === undefined ? 0 : (attrOf(reference, 'X') ?? 0));
  const ry = Number(reference === undefined ? 0 : (attrOf(reference, 'Y') ?? 0));
  const degrees = rx === 0 && ry === 0 ? 0 : Math.round(((Math.atan2(ry, rx) * 180) / Math.PI) * 1e9) / 1e9;
  return { x, y, rot: String(Object.is(degrees, -0) ? 0 : degrees) };
}

/** `ShapeUsage` of the placeholder shape `shape` at `place`. */
export function shapeUsage(place: Placement, shape: string): XNode {
  return object('Core/Diagram.ShapeUsage', undefined, [
    dataTyped('IsMirrored', 'Boolean', 'false'),
    dataPoint('Position', place.x, place.y),
    dataTyped('Rotation', 'Double', place.rot),
    dataTyped('ScaleX', 'Double', '1.0'),
    dataTyped('ScaleY', 'Double', '1.0'),
    ...references('Shape', [shape]),
  ]);
}

const staticGroup = (elements: readonly XNode[]): XNode => object('Core/Diagram.Static', undefined, components('Elements', elements));

/** A group that says it represents the object `id` and holds `parts`. */
export const representation = (id: string, parts: readonly XNode[]): XNode =>
  object('Core/Diagram.RepresentationGroup', undefined, [...parts, ...references('Represents', [id])]);

export interface PositionedNode {
  readonly node: string;
  readonly position: string;
  readonly x: string;
  readonly y: string;
}

/** Group of an item: its node positions and its shape. */
export function itemGroup(id: string, place: Placement | undefined, nodes: readonly PositionedNode[], shape: string): XNode | undefined {
  if (place === undefined && nodes.length === 0) return undefined;
  return representation(id, [
    ...components(
      'NodePositions',
      nodes.map((node) =>
        object('Plant/Diagram.PipingNodePosition', node.position, [
          ...references('Node', [node.node]),
          dataPoint('Position', node.x, node.y),
        ]),
      ),
    ),
    ...components('Groups', place === undefined ? [] : [staticGroup([shapeUsage(place, shape)])]),
  ]);
}

/** Route of a pipe or signal: `Source` / `Target` node positions when the route starts / ends exactly on one, the other points inline. */
export function connectorLine(
  route: readonly (readonly [string, string])[],
  source: PositionedNode | undefined,
  target: PositionedNode | undefined,
): XNode {
  const same = (point: readonly [string, string] | undefined, node: PositionedNode | undefined): node is PositionedNode =>
    point !== undefined && node !== undefined && Number(point[0]) === Number(node.x) && Number(point[1]) === Number(node.y);
  const fromNode = same(route[0], source);
  const toNode = route.length > 1 && same(route[route.length - 1], target);
  const inner = route.slice(fromNode ? 1 : 0, toNode ? route.length - 1 : route.length);
  return object('Core/Diagram.ConnectorLine', undefined, [
    ...(inner.length === 0
      ? []
      : [
          el(
            'Data',
            [['property', 'InnerPoints']],
            inner.map(([x, y]) =>
              el('AggregatedDataValue', [['type', 'Core/Diagram.Point']], [dataTyped('X', 'Double', x), dataTyped('Y', 'Double', y)]),
            ),
          ),
        ]),
    ...(fromNode && source !== undefined ? references('Source', [source.position]) : []),
    ...(toNode && target !== undefined ? references('Target', [target.position]) : []),
  ]);
}

export const connectorGroup = (represented: string, line: XNode): XNode =>
  representation(represented, components('Groups', [staticGroup([line])]));

export const arrowGroup = (place: Placement, shape: string): XNode =>
  object('Core/Diagram.PipeFlowArrow', undefined, components('Elements', [shapeUsage(place, shape)]));

/** The border rectangle of the sheet. */
export function border(width: string, height: string): XNode {
  const corner = (x: string, y: string): XNode =>
    el('AggregatedDataValue', [['type', 'Core/Diagram.Point']], [dataTyped('X', 'Double', x), dataTyped('Y', 'Double', y)]);
  const points = [corner('0', '0'), corner(width, '0'), corner(width, height), corner('0', height), corner('0', '0')];
  return object(
    'Core/Diagram.Border',
    undefined,
    components('Elements', [object('Core/Diagram.PolyLine', undefined, [el('Data', [['property', 'Points']], points)])]),
  );
}

/** The diagram object (named after the drawing) and the one-shape catalogue the shape usages refer to. */
export function diagramComponents(groups: readonly XNode[], name: string | undefined, shape: string): XNode[] {
  return [
    ...components('Diagram', [
      object('Core/Diagram.Diagram', undefined, [
        ...(name === undefined ? [] : [dataString('Name', name)]),
        ...components('Groups', groups),
      ]),
    ]),
    ...components('ShapeCatalogues', [
      object('Core/Diagram.ShapeCatalogue', undefined, [
        dataString('Name', 'llull'),
        ...components('Shapes', [object('Core/Diagram.Shape', shape, [dataString('Name', 'LLULL_PLACEHOLDER_SHAPE')])]),
      ]),
    ]),
  ];
}
