/**
 * Portal hall cladding panels (roof, side walls, gables) as outward-facing corner loops.
 * @layer domain-aec
 */

import type { Vec2, Vec3 } from '@core/model/types';
import { dot3 } from '@lib/vec3';
import { panelFrame } from './evaluate';
import type { HallGeometry, PortalProfiles } from './portalGeometry';

interface CladdingPanel {
  readonly corners: Vec3[];
  readonly role: 'roof' | 'wall';
  readonly outward: Vec3;
}

/** Outward-facing panel corners: reversed when the Newell normal points against `outward`. */
export function facing(corners: Vec3[], outward: Vec3): Vec3[] {
  const frame = panelFrame(corners);
  if (!frame) return corners;
  return dot3(frame.normal, outward) >= 0 ? corners : [...corners].reverse();
}

/** Roof, side-wall and gable panels of the hall envelope. */
export function claddingPanels(geometry: HallGeometry, p: PortalProfiles): CladdingPanel[] {
  const { mm, h, pitch, monopitch, spanBounds, x0, x1, y0, yEnd, roofLine } = geometry;
  const railOffset = h(p.column) / 2 + h(p.rail) / 2;
  const wallX0 = x0 - railOffset - h(p.rail) / 2;
  const wallX1 = x1 + railOffset + h(p.rail) / 2;
  const roofLift = h(p.rafter) / 2 + h(p.purlin);
  const roofZ = (x: number): number => roofLine(x) + roofLift / Math.cos(pitch);
  const edge = mm(200);
  const [ya, yb] = [y0 - edge, yEnd + edge];
  const panels: CladdingPanel[] = [];
  const profileLine: Vec2[] = [];
  spanBounds.forEach(([a, b], index) => {
    const left = index === 0 ? wallX0 : a;
    const right = index === spanBounds.length - 1 ? wallX1 : b;
    const breaks = monopitch ? [left, right] : [left, (a + b) / 2, right];
    profileLine.push(...breaks.slice(0, -1).map((x): Vec2 => [x, roofZ(x)]));
    if (index === spanBounds.length - 1) profileLine.push([right, roofZ(right)]);
    breaks.slice(1).forEach((to, panel) => {
      const from = breaks[panel] as number;
      const rising = monopitch ? roofZ(to) >= roofZ(from) : panel === 0;
      panels.push({
        role: 'roof',
        outward: [rising ? -Math.sin(pitch) : Math.sin(pitch), 0, Math.cos(pitch)],
        corners: [
          [from, ya, roofZ(from)],
          [from, yb, roofZ(from)],
          [to, yb, roofZ(to)],
          [to, ya, roofZ(to)],
        ],
      });
    });
  });
  for (const [x, outward] of [
    [wallX0, -1],
    [wallX1, 1],
  ] as const) {
    panels.push({
      role: 'wall',
      outward: [outward, 0, 0],
      corners: [
        [x, ya, 0],
        [x, yb, 0],
        [x, yb, roofZ(x)],
        [x, ya, roofZ(x)],
      ],
    });
  }
  for (const [y, outward] of [
    [ya, -1],
    [yb, 1],
  ] as const) {
    panels.push({
      role: 'wall',
      outward: [0, outward, 0],
      corners: [
        [wallX0, y, 0],
        [wallX1, y, 0],
        ...[...profileLine].reverse().map(([x, z]): Vec3 => [x, y, z]),
      ],
    });
  }
  return panels;
}
