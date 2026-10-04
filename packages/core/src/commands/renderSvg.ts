import type { Vec3 } from '../model/types';
import { type Polygon3D } from './renderTypes';
import { r2 } from './renderMath';
import { add3, scale3 } from '../lib/vec3';
import { type Camera, projectPoint, toScreenCoords, shade } from './renderCamera';

export const MAX_POLYGONS = 4000;

/** Build the complete SVG string. */
export function buildSvg(
  polygons: Polygon3D[],
  cam: Camera,
  basis: { fwd: Vec3; right: Vec3; up: Vec3 },
  orthoHalf: number,
  width: number,
  height: number,
  viewName: string,
  entityCount: number,
): string {
  // Sort back-to-front (painter's algorithm): farthest first so nearer faces paint
  // on top. `depth` is the centroid's distance along the camera forward axis, so
  // larger depth = farther — sort DESCENDING. Strokes (2D) always draw on top.
  const filled = polygons.filter((p) => !p.stroke).sort((a, b) => b.depth - a.depth);
  const stroked = polygons.filter((p) => p.stroke);
  const sorted = [...filled, ...stroked];

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );

  // Background
  lines.push(`  <rect width="${width}" height="${height}" fill="#1a1a2e"/>`);

  // Faint ground grid (projected XY plane, Z=0)
  const gridLines = buildGroundGrid(cam, basis, orthoHalf, width, height);
  if (gridLines) lines.push(gridLines);

  // Filled polygons (3D solids)
  for (const poly of sorted) {
    const pts = poly.verts.map((v) => {
      const [u, v2] = projectPoint(v, cam, basis);
      const [sx, sy] = toScreenCoords(u, v2, orthoHalf, width, height);
      return `${r2(sx)},${r2(sy)}`;
    });

    if (poly.stroke) {
      lines.push(
        `  <polyline points="${pts.join(' ')}" fill="none" stroke="${poly.color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    } else {
      const shadedColor = shade(poly.normal, poly.color);
      lines.push(
        `  <polygon points="${pts.join(' ')}" fill="${shadedColor}" stroke="rgba(0,0,0,0.25)" stroke-width="0.5"/>`,
      );
    }
  }

  // Axis triad (bottom-left corner)
  const triadSvg = buildAxisTriad(cam, basis, width, height, orthoHalf);
  lines.push(triadSvg);

  // Overlay: view label + entity count
  lines.push(
    `  <text x="8" y="20" font-family="monospace" font-size="13" fill="#aaaacc">${viewName.toUpperCase()} | ${entityCount} entit${entityCount === 1 ? 'y' : 'ies'}</text>`,
  );

  lines.push('</svg>');
  return lines.join('\n');
}

/** A faint 5-line ground grid in the XY plane (Z=0). */
function buildGroundGrid(
  cam: Camera,
  basis: { fwd: Vec3; right: Vec3; up: Vec3 },
  orthoHalf: number,
  width: number,
  height: number,
): string {
  const GRID_LINES = 5;
  const step = (orthoHalf * 2) / GRID_LINES;
  const start = -orthoHalf;
  const end = orthoHalf;
  const cx = cam.target[0],
    cy = cam.target[1];
  const screen = (x: number, y: number): [number, number] => {
    const [u, v] = projectPoint([cx + x, cy + y, 0], cam, basis);
    return toScreenCoords(u, v, orthoHalf, width, height);
  };
  const gridLine = (a: [number, number], b: [number, number]): string =>
    `<line x1="${r2(a[0])}" y1="${r2(a[1])}" x2="${r2(b[0])}" y2="${r2(b[1])}" stroke="#333355" stroke-width="0.5"/>`;
  const parts: string[] = [];
  for (let i = 0; i <= GRID_LINES; i++) {
    const offset = start + step * i;
    parts.push(gridLine(screen(start, offset), screen(end, offset))); // constant Y
    parts.push(gridLine(screen(offset, start), screen(offset, end))); // constant X
  }
  return `  <g id="grid">${parts.join('')}</g>`;
}

/** Small RGB axis triad at the bottom-left corner. */
function buildAxisTriad(
  cam: Camera,
  basis: { fwd: Vec3; right: Vec3; up: Vec3 },
  width: number,
  height: number,
  orthoHalf: number,
): string {
  const origin: Vec3 = cam.target;
  const armLen = orthoHalf * 0.15;
  const axes: [Vec3, string, string][] = [
    [add3(origin, scale3([1, 0, 0], armLen)), '#ff4444', 'X'],
    [add3(origin, scale3([0, 1, 0], armLen)), '#44ff44', 'Y'],
    [add3(origin, scale3([0, 0, 1], armLen)), '#4488ff', 'Z'],
  ];

  const [ou, ov] = projectPoint(origin, cam, basis);
  const [osx, osy] = toScreenCoords(ou, ov, orthoHalf, width, height);

  // Render triad in bottom-left corner by offsetting screen coords
  const triadX = 40;
  const triadY = height - 40;
  const triadScale = 30;

  const parts: string[] = [];
  for (const [tip, color, label] of axes) {
    const [tu, tv] = projectPoint(tip, cam, basis);
    const [tsx, tsy] = toScreenCoords(tu, tv, orthoHalf, width, height);
    const dx = ((tsx - osx) / (width / 2)) * triadScale;
    const dy = ((tsy - osy) / (height / 2)) * triadScale;
    const tx = r2(triadX + dx);
    const ty = r2(triadY + dy);
    parts.push(
      `<line x1="${triadX}" y1="${triadY}" x2="${tx}" y2="${ty}" stroke="${color}" stroke-width="2"/>`,
    );
    parts.push(
      `<text x="${tx}" y="${ty}" font-family="monospace" font-size="10" fill="${color}">${label}</text>`,
    );
  }
  return `  <g id="axis-triad">${parts.join('')}</g>`;
}
