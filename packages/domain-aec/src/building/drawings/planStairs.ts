import type { Vec2 } from '@core/model/types';
import type { StairElement } from '@core/model/building';
import type { DrawingPrimitive } from '@core/model/drawing';
import { fromMm } from '@core/model/units';
import { type StairFlight, flightPoint, stairFlights, stairLanding, stairPoint } from '../geometry/stairGeometry';
import { type PlanSource, annotationText, layerName, thinLine } from './planModel';

/** Direction arrow along the path with a head at its end. */
function arrow(layer: string, path: ReadonlyArray<Vec2>, headSize: number): DrawingPrimitive[] {
  const [from, tip] = [path[path.length - 2], path[path.length - 1]];
  const shaft: DrawingPrimitive = { type: 'polyline', layer, style: 'thin', points: [...path] };
  if (!from || !tip) return [shaft];
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const wing = (offset: number): Vec2 => [tip[0] - headSize * Math.cos(angle + offset), tip[1] - headSize * Math.sin(angle + offset)];
  return [shaft, { type: 'polyline', layer, style: 'thin', points: [wing(0.45), tip, wing(-0.45)] }];
}

/** Plan symbol of a flight: outline, tread lines, and optionally a break (cut) line across its middle. */
function flightSymbol(stair: StairElement, flight: StairFlight, layer: string, cutLine: boolean): DrawingPrimitive[] {
  const half = stair.width / 2;
  const going = stair.treadDepth;
  const length = (flight.risers - 1) * going;
  const at = (u: number, v: number): Vec2 => {
    const [along, across] = flightPoint(flight, u, v);
    return stairPoint(stair, along, across);
  };
  const primitives: DrawingPrimitive[] = [
    { type: 'polygon', layer, style: 'thin', points: [at(0, -half), at(length, -half), at(length, half), at(0, half)] },
  ];
  for (let index = 1; index < flight.risers - 1; index++)
    primitives.push(thinLine(layer, at(index * going, -half), at(index * going, half)));
  if (!cutLine) return primitives;
  const [middle, slant] = [length / 2, going / 4];
  primitives.push({
    type: 'polyline',
    layer,
    style: 'thin',
    points: [at(middle - slant, -half), at(middle - slant, -half / 4), at(middle + slant, half / 4), at(middle + slant, half)],
  });
  return primitives;
}

/** Centreline from the first flight's end, across the landing, to the second flight's start (stair plan frame). */
function landingPath(stair: StairElement, first: StairFlight, second: StairFlight): Vec2[] {
  const end = flightPoint(first, (first.risers - 1) * stair.treadDepth, 0);
  const start = second.origin;
  const landing = stairLanding(stair);
  const depth = landing ? (landing.plan[1]?.[0] ?? end[0]) - end[0] : 0;
  if (stair.shape === 'quarter_turn') return [end, [start[0], end[1]], start];
  if (stair.shape === 'half_turn') return [end, [end[0] + depth / 2, end[1]], [end[0] + depth / 2, start[1]], start];
  return [end, start];
}

/**
 * Plan symbol of a stair on A-FLOR-STRS. A stair without a landing: outline, tread lines, run arrow and "UP nR" text. With a landing: for
 * each flight an outline, tread lines and a cut line, the landing outline, and one arrow along the whole path (through the turn).
 */
export function stairPrimitives(doc: PlanSource, stair: StairElement): DrawingPrimitive[] {
  const layer = layerName('stair');
  const flights = stairFlights(stair);
  const label = annotationText(layer, stairPoint(stair, -fromMm(doc, 400), 0), fromMm(doc, 200), `UP ${stair.riserCount}R`);
  const [first, second] = [flights[0], flights[1]];
  if (!first) return [];
  if (!second) {
    const length = (stair.riserCount - 1) * stair.treadDepth;
    const base = flightSymbol(stair, first, layer, false);
    return [
      ...base,
      {
        type: 'polyline',
        layer,
        style: 'thin',
        points: [stairPoint(stair, stair.treadDepth / 2, 0), stairPoint(stair, length - stair.treadDepth / 2, 0)],
      },
      label,
    ];
  }
  const landing = stairLanding(stair);
  const primitives = flights.flatMap((flight) => flightSymbol(stair, flight, layer, true));
  if (landing) {
    primitives.push({
      type: 'polygon',
      layer,
      style: 'thin',
      points: landing.plan.map(([along, across]) => stairPoint(stair, along, across)),
    });
  }
  const shaftStart = flightPoint(first, stair.treadDepth / 2, 0);
  const shaftEnd = flightPoint(second, (second.risers - 1) * stair.treadDepth - stair.treadDepth / 2, 0);
  const path = [shaftStart, ...landingPath(stair, first, second), shaftEnd].map(([along, across]) => stairPoint(stair, along, across));
  return [...primitives, ...arrow(layer, path, stair.width / 6), label];
}
