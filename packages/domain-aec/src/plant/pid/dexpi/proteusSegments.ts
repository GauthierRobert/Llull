/**
 * Second pass: PipingNetworkSegment -> `PidSegment`s and InformationFlow -> `PidSignal`s (plant 04 PID §6.1).
 * A DEXPI segment is a chain source -> components -> target; llull splits it at every component into segments between two items, each tagged
 * `passthrough['dexpi:segment']` with the DEXPI segment id so the census (and the DEXPI export of M5) can fold the pieces back.
 */

import { xmlAttr, xmlChildren, type XmlElement } from '@lib/xmlRead';
import type { Vec2 } from '@core/model/vectors';
import type { PidEndpoint } from '../model';
import { endpointOf, nearestPort, pointOfEndpoint } from './proteusConnect';
import {
  addItem,
  baseOf,
  lineCoordinates,
  diameterOf,
  toNumber,
  readAttributes,
  register,
  type Base,
  type ImportContext,
  type Pending,
} from './proteusContext';

type Step = { readonly type: 'line'; readonly points: Vec2[] } | { readonly type: 'component'; readonly ref: ComponentRef };
type ComponentRef = NonNullable<ReturnType<Pending['components']['get']>>;

interface Piece {
  readonly from: PidEndpoint;
  readonly to: PidEndpoint;
  readonly route: Vec2[];
}

const same = (a: Vec2 | undefined, b: Vec2): boolean => a !== undefined && a[0] === b[0] && a[1] === b[1];

function stepsOf(ctx: ImportContext, segment: XmlElement, pending: Pending): Step[] {
  const steps: Step[] = [];
  for (const child of xmlChildren(segment)) {
    if (child.local === 'CenterLine') {
      steps.push({ type: 'line', points: lineCoordinates(ctx, child) });
    } else if (child.local === 'PipingComponent') {
      const ref = pending.components.get(child);
      if (ref !== undefined) steps.push({ type: 'component', ref });
    }
  }
  return steps;
}

/** For each step, the first point of the next centre line after it (computed backwards: linear in the number of steps). */
function pointsAhead(steps: readonly Step[]): Array<Vec2 | undefined> {
  const ahead: Array<Vec2 | undefined> = new Array<Vec2 | undefined>(steps.length);
  let next: Vec2 | undefined;
  for (let index = steps.length - 1; index >= 0; index--) {
    ahead[index] = next;
    const step = steps[index];
    if (step?.type === 'line' && step.points[0] !== undefined) next = step.points[0];
  }
  return ahead;
}

function piecesOf(ctx: ImportContext, steps: readonly Step[], source: PidEndpoint, target: PidEndpoint): Piece[] {
  const components = steps.flatMap((step) => (step.type === 'component' ? [step.ref] : []));
  const firstComponent = components[0];
  const lastComponent = components[components.length - 1];
  const startsInside = source.type === 'inline' && firstComponent?.id === source.itemId;
  const endsInside = target.type === 'inline' && lastComponent?.id === target.itemId;
  const pieces: Piece[] = [];
  let start = source;
  let current: Vec2[] = [];
  const close = (to: PidEndpoint): void => {
    pieces.push({ from: start, to, route: current.length >= 2 ? current : [pointOfEndpoint(ctx, start), pointOfEndpoint(ctx, to)] });
    current = [];
  };
  const nextPoints = pointsAhead(steps);
  let seen = 0;
  steps.forEach((step, index) => {
    if (step.type === 'line') {
      for (const point of step.points) if (!same(current[current.length - 1], point)) current.push(point);
      return;
    }
    const first = seen === 0;
    const last = seen === components.length - 1;
    seen++;
    const fromHere = first && startsInside && source.type === 'inline' ? source.node : undefined;
    const toHere = last && endsInside && target.type === 'inline' ? target.node : undefined;
    const from = current[current.length - 1] ?? pointOfEndpoint(ctx, start);
    const entry = nearestPort(step.ref.ports, from, toHere ?? fromHere);
    const ahead = nextPoints[index] ?? (last && !endsInside ? pointOfEndpoint(ctx, target) : undefined);
    const exit = toHere ?? fromHere ?? nearestPort(step.ref.ports, ahead, entry);
    if (first && startsInside) current = [];
    else close({ type: 'inline', itemId: step.ref.id, node: entry });
    start = { type: 'inline', itemId: step.ref.id, node: exit };
  });
  if (!endsInside) close(target);
  else if (pieces.length === 0)
    pieces.push({ from: source, to: target, route: [pointOfEndpoint(ctx, source), pointOfEndpoint(ctx, target)] });
  return pieces;
}

/** Appends the pieces of every queued segment; `lineSegments` collects the segment ids of each line. */
export function buildSegments(ctx: ImportContext, pending: Pending, lineSegments: Map<string, string[]>): void {
  for (const queued of pending.segments) {
    const el = queued.el;
    const steps = stepsOf(ctx, el, pending);
    const connection = xmlChildren(el, 'Connection')[0];
    const all = steps.flatMap((s): Vec2[] => (s.type === 'line' ? s.points : s.ref.ports.slice()));
    const firstPoint: Vec2 = all[0] ?? [0, 0];
    const lastPoint: Vec2 = all[all.length - 1] ?? firstPoint;
    const node = (name: string): number | undefined => (connection === undefined ? undefined : toNumber(xmlAttr(connection, name)));
    const at = connection ?? el;
    const source = endpointOf(ctx, connection && xmlAttr(connection, 'FromID'), node('FromNode'), firstPoint, at);
    const target = endpointOf(ctx, connection && xmlAttr(connection, 'ToID'), node('ToNode'), lastPoint, at);
    const read = readAttributes(ctx, el);
    const dn = diameterOf(read) ?? queued.dn;
    const pipingClass = read.raw.get('PipingClassCodeAssignmentClass') ?? queued.pipingClass;
    const primary = read.raw.get('PrimarySecondaryPipingNetworkSegmentSpecialization') !== 'SecondaryPipingNetworkSegment';
    const key = xmlAttr(el, 'ID') ?? `segment@line ${el.line}`;
    const ids = lineSegments.get(queued.lineId) ?? [];
    const pieces = piecesOf(ctx, steps, source, target);
    const count = pieces.length;
    pieces.forEach((piece, index) => {
      const base: Base = {
        ...baseOf(ctx, el, 'PipingNetworkSegment', read, { at: piece.route[0], rotationDeg: 0, passthrough: { 'dexpi:segment': key } }),
      };
      if (index > 0) delete base.sourceId;
      addItem(ctx, {
        ...base,
        kind: 'segment',
        lineId: queued.lineId,
        from: piece.from,
        to: piece.to,
        route: piece.route,
        flow: connection === undefined ? 'none' : 'forward',
        primary,
        ...(dn === undefined ? {} : { dn }),
        ...(pipingClass === undefined ? {} : { pipingClass }),
      });
      ids.push(base.id);
    });
    lineSegments.set(queued.lineId, ids);
    const firstPiece = ids[ids.length - count];
    if (firstPiece !== undefined) register(ctx, el, { type: 'segment', id: firstPiece });
  }
}
