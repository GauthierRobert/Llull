import type { Vec3 } from '../model/types';
import { type Polygon3D } from './renderTypes';
import { add3, scale3 } from '../lib/vec3';
import { type Camera, type Projector, makeProjector, shade } from './renderCamera';

export const MAX_POLYGONS = 4000;

/** Round to 2 decimals (SVG coordinates and labels). */
export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Wrap `layers` in a `width`×`height` SVG with the standard dark background. */
export function svgDocument(width: number, height: number, layers: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <rect width="${width}" height="${height}" fill="#1a1a2e"/>`,
    ...layers,
    '</svg>',
  ].join('\n');
}

/** `<line>` between two screen points (coordinates rounded to 2 decimals); `attributes` is appended as is. */
export function svgLine(
  from: readonly [number, number],
  to: readonly [number, number],
  attributes = '',
): string {
  const extra = attributes === '' ? '' : ` ${attributes}`;
  return `<line x1="${r2(from[0])}" y1="${r2(from[1])}" x2="${r2(to[0])}" y2="${r2(to[1])}"${extra}/>`;
}

/** `<circle r="3">` at a screen point (coordinates rounded to 2 decimals); `attributes` is appended as is. */
export function svgDot(center: readonly [number, number], attributes: string): string {
  return `<circle cx="${r2(center[0])}" cy="${r2(center[1])}" r="3" ${attributes}/>`;
}

/** Build the complete SVG string. */
export function buildSvg(
  polygons: Polygon3D[],
  cam: Camera,
  orthoHalf: number,
  width: number,
  height: number,
  viewName: string,
  entityCount: number,
): string {
  const project = makeProjector(cam, orthoHalf, width, height);
  // Painter's algorithm: `depth` grows away from the camera, so draw farthest first so nearer
  // faces paint on top. Strokes (2D) always draw on top.
  const filled = polygons.filter((p) => !p.stroke).sort((a, b) => b.depth - a.depth);
  const stroked = polygons.filter((p) => p.stroke);

  return svgDocument(width, height, [
    buildGroundGrid(project, cam.target, orthoHalf),
    ...[...filled, ...stroked].map((poly) => polygonSvg(poly, project)),
    buildAxisTriad(project, cam.target, width, height, orthoHalf),
    `  <text x="8" y="20" font-family="monospace" font-size="13" fill="#aaaacc">${viewName.toUpperCase()} | ${entityCount} entit${entityCount === 1 ? 'y' : 'ies'}</text>`,
  ]);
}

function polygonSvg(poly: Polygon3D, project: Projector): string {
  const points = poly.verts
    .map((vertex) => {
      const [sx, sy] = project(vertex);
      return `${r2(sx)},${r2(sy)}`;
    })
    .join(' ');
  if (poly.stroke) {
    return `  <polyline points="${points}" fill="none" stroke="${poly.color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return `  <polygon points="${points}" fill="${shade(poly.normal, poly.color)}" stroke="rgba(0,0,0,0.25)" stroke-width="0.5"/>`;
}

/** A faint 5-line ground grid in the XY plane (Z=0), centred on the camera target. */
function buildGroundGrid(project: Projector, target: Vec3, orthoHalf: number): string {
  const GRID_LINES = 5;
  const step = (orthoHalf * 2) / GRID_LINES;
  const [cx, cy] = target;
  const at = (x: number, y: number): [number, number] => project([cx + x, cy + y, 0]);
  const gridLine = (a: [number, number], b: [number, number]): string =>
    svgLine(a, b, 'stroke="#333355" stroke-width="0.5"');
  const parts: string[] = [];
  for (let i = 0; i <= GRID_LINES; i++) {
    const offset = -orthoHalf + step * i;
    parts.push(gridLine(at(-orthoHalf, offset), at(orthoHalf, offset))); // constant Y
    parts.push(gridLine(at(offset, -orthoHalf), at(offset, orthoHalf))); // constant X
  }
  return `  <g id="grid">${parts.join('')}</g>`;
}

/** Small RGB axis triad at the bottom-left corner. */
function buildAxisTriad(
  project: Projector,
  origin: Vec3,
  width: number,
  height: number,
  orthoHalf: number,
): string {
  const armLen = orthoHalf * 0.15;
  const axes: [Vec3, string, string][] = [
    [add3(origin, scale3([1, 0, 0], armLen)), '#ff4444', 'X'],
    [add3(origin, scale3([0, 1, 0], armLen)), '#44ff44', 'Y'],
    [add3(origin, scale3([0, 0, 1], armLen)), '#4488ff', 'Z'],
  ];
  const [osx, osy] = project(origin);

  // Draw the triad in the bottom-left corner by offsetting screen coords.
  const triadX = 40;
  const triadY = height - 40;
  const triadScale = 30;

  const parts: string[] = [];
  for (const [tip, color, label] of axes) {
    const [tsx, tsy] = project(tip);
    const tx = r2(triadX + ((tsx - osx) / (width / 2)) * triadScale);
    const ty = r2(triadY + ((tsy - osy) / (height / 2)) * triadScale);
    parts.push(svgLine([triadX, triadY], [tx, ty], `stroke="${color}" stroke-width="2"`));
    parts.push(
      `<text x="${tx}" y="${ty}" font-family="monospace" font-size="10" fill="${color}">${label}</text>`,
    );
  }
  return `  <g id="axis-triad">${parts.join('')}</g>`;
}

/** Inner XML of a `<svg>` document (outer open/close tags stripped). */
export function extractSvgInner(svg: string): string {
  const openEnd = svg.indexOf('>');
  if (openEnd === -1) return svg;
  const closeStart = svg.lastIndexOf('</svg>');
  return svg.substring(openEnd + 1, closeStart === -1 ? undefined : closeStart);
}

/** `svg` with `overlay` inserted just before its closing `</svg>` tag. */
export function appendBeforeClose(svg: string, overlay: string): string {
  return svg.replace('</svg>', `${overlay}\n</svg>`);
}
