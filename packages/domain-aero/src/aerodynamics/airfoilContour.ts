/** Airfoil contours for the panel method: from a NACA designation or from a closed 2D polyline of the document. */

import type { CadDocument, Vec2 } from '@core/model/types';
import { nacaOrdinates, parseNaca, type NacaSection } from './naca';

export interface AirfoilContour {
  readonly label: string;
  /** Clockwise nodes from the lower trailing edge round to the upper one (repeated first node when the TE is sharp), chord-normalised; an open TE stays open. */
  readonly nodes: ReadonlyArray<readonly [number, number]>;
  readonly section: NacaSection | null;
  readonly chord: number;
}

const signedArea = (points: ReadonlyArray<readonly [number, number]>): number =>
  points.reduce((sum, [x, y], index) => {
    const [nx, ny] = points[(index + 1) % points.length] as readonly [number, number];
    return sum + x * ny - nx * y;
  }, 0) / 2;

/** Contour of a NACA section with `pointsPerSide` panels per surface. */
export function nacaContour(designation: string, pointsPerSide: number, closedTrailingEdge: boolean): AirfoilContour | string {
  const section = parseNaca(designation);
  if (typeof section === 'string') return section;
  const ordinates = nacaOrdinates(section, pointsPerSide, closedTrailingEdge).reverse();
  return { label: section.designation, nodes: ordinates, section, chord: 1 };
}

/**
 * Contour of a closed polyline entity: made clockwise, started at its lower trailing-edge point (an open trailing-edge gap between the
 * two rearmost points is left out of the panels), scaled to unit chord.
 * @failure not a closed polyline of ≥ 8 points, or zero chord -> string reason
 */
export function polylineContour(doc: CadDocument, entityId: string): AirfoilContour | string {
  const entity = doc.entities[entityId];
  if (entity?.kind !== 'polyline' || !entity.closed || entity.points.length < 8)
    return `'${entityId}' is not a closed 2D polyline of at least 8 points (draw_naca_airfoil or draw_polyline closed:true)`;
  const raw = entity.points.filter((point, index, all) => {
    const next = all[(index + 1) % all.length] as Vec2;
    return Math.hypot(next[0] - point[0], next[1] - point[1]) > 1e-12;
  });
  const xs = raw.map(([x]) => x);
  const leading = Math.min(...xs);
  const chord = Math.max(...xs) - leading;
  if (!(chord > 0)) return `'${entityId}' has zero chord along its local x axis`;
  const clockwise = signedArea(raw) < 0 ? raw : [...raw].reverse();
  const n = clockwise.length;
  const iMax = clockwise.reduce((best, [x], index) => (x > (clockwise[best] as Vec2)[0] ? index : best), 0);
  const at = (index: number): Vec2 => clockwise[(index + n) % n] as Vec2;
  /** `upper` -> `lower` is an open trailing-edge base: short, running across the chord (|dy| > 2|dx|), downwards. */
  const isGap = (upper: Vec2, lower: Vec2): boolean =>
    upper[1] - lower[1] > 2 * Math.abs(upper[0] - lower[0]) && Math.hypot(upper[0] - lower[0], upper[1] - lower[1]) < 0.05 * chord;
  const gapAfter = isGap(at(iMax), at(iMax + 1));
  const gapBefore = !gapAfter && isGap(at(iMax - 1), at(iMax));
  const start = gapAfter ? (iMax + 1) % n : iMax;
  const ordered = [...clockwise.slice(start), ...clockwise.slice(0, start)];
  const origin = raw[xs.indexOf(leading)] as Vec2;
  const nodes = ordered.map(([x, y]): [number, number] => [(x - leading) / chord, (y - origin[1]) / chord]);
  const openTrailingEdge = gapAfter || gapBefore;
  return {
    label: entity.name ?? entityId,
    nodes: openTrailingEdge ? nodes : [...nodes, nodes[0] as [number, number]],
    section: null,
    chord,
  };
}
