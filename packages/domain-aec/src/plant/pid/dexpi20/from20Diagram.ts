/** The `Core/Diagram` of a DEXPI 2.0 file reduced to what the P&ID model keeps: item placements, node positions, pipe and signal routes, flow arrows, paper (plant 04 PID §6.2). */

import { xmlAttr, xmlChildren, type XmlElement } from '@lib/xmlRead';
import type { Vec2 } from '@core/model/vectors';
import { PAPER_MM } from '@core/model/sheet';
import { decodeName } from './names20';
import { dataOf, referenceIds } from './syn';

export interface Placement {
  readonly at: Vec2;
  readonly rotationDeg: number;
}

export interface DiagramFacts {
  /** Object id -> where its shape sits. */
  readonly placements: Map<string, Placement>;
  /** Node id -> position. */
  readonly nodes: Map<string, Vec2>;
  /** Id of the represented pipe / information flow -> its route. */
  readonly routes: Map<string, Vec2[]>;
  /** Id of the represented segment -> its flow arrows. */
  readonly arrows: Map<string, Placement[]>;
  /** Largest coordinate of the border (sheet size, mm), when a border is drawn. */
  readonly extent: Vec2 | undefined;
  readonly name: string | undefined;
}

const num = (text: string | undefined): number | undefined => {
  const value = text === undefined || text.trim() === '' ? undefined : Number(text);
  return value !== undefined && Number.isFinite(value) ? value : undefined;
};

const textOf = (data: XmlElement | undefined, local: string): string | undefined => {
  const typed = data === undefined ? undefined : xmlChildren(data, local)[0];
  return typed === undefined ? undefined : typed.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
};

/** A `Core/Diagram.Point` value (`X` and `Y` doubles) held by `data`, or each of the points of a list. */
function pointsOf(data: XmlElement | undefined): Vec2[] {
  const points: Vec2[] = [];
  for (const value of data === undefined ? [] : xmlChildren(data, 'AggregatedDataValue')) {
    const x = num(textOf(dataOf(value, 'X'), 'Double'));
    const y = num(textOf(dataOf(value, 'Y'), 'Double'));
    if (x !== undefined && y !== undefined) points.push([x, y]);
  }
  return points;
}

/** Group types that only organise: a shape below them belongs to the object the group represents. */
const ORGANISING = new Set(['Core/Diagram.RepresentationGroup', 'Core/Diagram.Static', 'Core/Diagram.Diagram']);

interface Frame {
  readonly element: XmlElement;
  /** Id of the nearest object the diagram says it represents. */
  readonly represents: string | undefined;
  /** Nearest enclosing object that is not an organising group (a flow arrow, a symbol, a label). */
  readonly special: string | undefined;
}

interface Connector {
  readonly represents: string;
  readonly source: string | undefined;
  readonly target: string | undefined;
  readonly inner: Vec2[];
}

/** One iterative pass over the diagram objects (document order); node positions a connector names are resolved after the pass. */
export function readDiagram(diagram: XmlElement | undefined): DiagramFacts {
  const placements = new Map<string, Placement>();
  const nodes = new Map<string, Vec2>();
  const positionAt = new Map<string, Vec2>();
  const routes = new Map<string, Vec2[]>();
  const arrows = new Map<string, Placement[]>();
  const connectors: Connector[] = [];
  let extent: Vec2 | undefined;
  const name = diagram === undefined ? undefined : textOf(dataOf(diagram, 'Name'), 'String');
  const stack: Frame[] = diagram === undefined ? [] : [{ element: diagram, represents: undefined, special: undefined }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { element } = frame;
    const type = xmlAttr(element, 'type') ?? '';
    const represents = referenceIds(element, 'Represents')[0] ?? frame.represents;
    const special = ORGANISING.has(type) ? frame.special : type;
    if (type === 'Core/Diagram.Border') {
      for (const polyline of descendants(element, 'Core/Diagram.PolyLine'))
        for (const [x, y] of pointsOf(dataOf(polyline, 'Points'))) extent = [Math.max(extent?.[0] ?? 0, x), Math.max(extent?.[1] ?? 0, y)];
    } else if (type.endsWith('NodePosition')) {
      const at = pointsOf(dataOf(element, 'Position'))[0];
      const node = referenceIds(element, 'Node')[0];
      const id = xmlAttr(element, 'id');
      if (at !== undefined && node !== undefined) nodes.set(node, at);
      if (at !== undefined && id !== undefined) positionAt.set(decodeName(id), at);
    } else if (type === 'Core/Diagram.ShapeUsage' && represents !== undefined) {
      const at = pointsOf(dataOf(element, 'Position'))[0];
      const place: Placement | undefined =
        at === undefined ? undefined : { at, rotationDeg: num(textOf(dataOf(element, 'Rotation'), 'Double')) ?? 0 };
      if (place !== undefined && frame.special === undefined && !placements.has(represents)) placements.set(represents, place);
      else if (place !== undefined && frame.special === 'Core/Diagram.PipeFlowArrow')
        arrows.set(represents, [...(arrows.get(represents) ?? []), place]);
    } else if (type === 'Core/Diagram.ConnectorLine' && represents !== undefined) {
      connectors.push({
        represents,
        source: referenceIds(element, 'Source')[0],
        target: referenceIds(element, 'Target')[0],
        inner: pointsOf(dataOf(element, 'InnerPoints')),
      });
    }
    const children: XmlElement[] = [];
    for (const components of xmlChildren(element, 'Components')) children.push(...xmlChildren(components, 'Object'));
    for (let index = children.length - 1; index >= 0; index--) stack.push({ element: children[index] as XmlElement, represents, special });
  }
  for (const connector of connectors) {
    const from = connector.source === undefined ? undefined : positionAt.get(connector.source);
    const to = connector.target === undefined ? undefined : positionAt.get(connector.target);
    routes.set(connector.represents, [...(from === undefined ? [] : [from]), ...connector.inner, ...(to === undefined ? [] : [to])]);
  }
  return { placements, nodes, routes, arrows, extent, name };
}

/** The objects of `type` at or below `root`, in document order. */
function descendants(root: XmlElement, type: string): XmlElement[] {
  const found: XmlElement[] = [];
  const stack: XmlElement[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (xmlAttr(node, 'type') === type) found.push(node);
    const children: XmlElement[] = [];
    for (const components of xmlChildren(node, 'Components')) children.push(...xmlChildren(components, 'Object'));
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index] as XmlElement);
  }
  return found;
}

const PAPERS = ['A4', 'A3', 'A2', 'A1', 'A0'] as const;
const clean = (value: number): number => Math.round(value * 1e9) / 1e9;

/**
 * The facts in the sheet's own frame. A DEXPI 2.0 diagram has its origin at the top left with Y pointing down (the reference file draws the border
 * from (1, 1) to (419, 296) on an A3 sheet) and angles clockwise; the P&ID model is Y up and counter-clockwise like Proteus. `height` is the height
 * of the smallest standard sheet that holds the border (A1 when the diagram has none, the default of the mapper).
 */
export function orient(facts: DiagramFacts): DiagramFacts {
  const paper =
    facts.extent === undefined
      ? undefined
      : PAPERS.find((name) => facts.extent !== undefined && facts.extent[0] <= PAPER_MM[name][0] && facts.extent[1] <= PAPER_MM[name][1]);
  const height = PAPER_MM[paper ?? 'A1'][1];
  const up = ([x, y]: Vec2): Vec2 => [x, clean(height - y)];
  const turned = (place: Placement): Placement => ({ at: up(place.at), rotationDeg: clean(-place.rotationDeg) + 0 });
  return {
    ...facts,
    placements: new Map([...facts.placements].map(([id, place]) => [id, turned(place)])),
    nodes: new Map([...facts.nodes].map(([id, at]) => [id, up(at)])),
    routes: new Map([...facts.routes].map(([id, route]) => [id, route.map(up)])),
    arrows: new Map([...facts.arrows].map(([id, list]) => [id, list.map(turned)])),
  };
}
