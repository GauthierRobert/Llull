/**
 * Where the two discs of a spectacle blind part lie (display and clash read the same layout). The plate runs from its upstream face to its downstream face along `axis` (an inline
 * part: its two ports; a run-end closure: the closed outer face `centre` to its single mating port). The disc in the line (`state` closed: the solid disc, open: the open ring) is
 * centred on the pipe axis; the spare one (the other disc) is `webLength` away toward `side`, the direction perpendicular to the pipe that points up (+X on a vertical pipe).
 */

import type { Vec3 } from '@core/model/vectors';
import type { RoutedPart } from '@aec/plant/types';
import { add3, dot3, len3, scale3, sub3 } from '@lib/vec3';
import { unitVector } from './legs';

export interface SpectacleDisc {
  /** Centre of the upstream face of the disc. */
  readonly centreStart: Vec3;
  /** Outside diameter, mm. */
  readonly diameter: number;
  /** An open ring (drawn with the pipe bore) or a solid disc. */
  readonly ring: boolean;
}

export interface SpectacleLayout {
  readonly axis: Vec3;
  readonly thickness: number;
  readonly boreDiameter: number;
  readonly inLine: SpectacleDisc;
  readonly spare: SpectacleDisc;
}

/** The layout of a spectacle blind part, or null when its ports or row dimensions are missing. */
export function spectacleLayout(part: RoutedPart): SpectacleLayout | null {
  const [first, second] = part.ports;
  const { discDiameterClosed: closed, discDiameterOpen: open, webLength: web } = part.dims;
  const start = second === undefined ? part.centre : first?.position;
  const end = second === undefined ? first?.position : second.position;
  if (start === undefined || end === undefined || closed === undefined || open === undefined || web === undefined) return null;
  const length = len3(sub3(end, start));
  if (!(length > 0)) return null;
  const axis = unitVector(sub3(end, start));
  const up: Vec3 = Math.abs(axis[2]) < 0.999 ? [0, 0, 1] : [1, 0, 0];
  const side = unitVector(sub3(up, scale3(axis, dot3(up, axis))));
  const ring: SpectacleDisc = { centreStart: start, diameter: open, ring: true };
  const solid: SpectacleDisc = { centreStart: start, diameter: closed, ring: false };
  const [inLine, spare] = part.state === 'open' ? [ring, solid] : [solid, ring];
  return {
    axis,
    thickness: length,
    boreDiameter: part.dims['outsideDiameter'] ?? 0,
    inLine,
    spare: { ...spare, centreStart: add3(start, scale3(side, web)) },
  };
}
