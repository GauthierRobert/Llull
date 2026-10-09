/**
 * Generates the civil pilot-kit sample survey files in public/samples/ (deterministic: same output on
 * every run, no Date / Math.random):
 *   pilot-site-survey.csv  PENZD topographic survey (~900 points, TOPO / EP / TREE / STR codes)
 *   pilot-site-survey.dxf  ASCII DXF: 3D-polyline contours (layer C-TOPO-MAJR / C-TOPO-MINR) and
 *                          spot-level texts (layer C-TOPO-SPOT)
 *
 * The ground is analytic: a hillside rising to the north-east with a stream valley winding south
 * along the west of the site. Local site grid, metres: easting 1000..1240, northing 5000..5180.
 *
 *   node scripts/generate-civil-samples.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples');

/** Site origin (local grid) and extent, metres. */
const ORIGIN = { e: 1000, n: 5000 };
const SIZE = { e: 240, n: 180 };

/** Stream centreline easting (site-relative) at a site-relative northing. */
const streamAxis = (y) => 55 + 12 * Math.sin(y / 28);

/** Existing-ground elevation at site-relative (x, y), metres. */
function ground(x, y) {
  const slope = 100 + 0.045 * y + 0.025 * x;
  const undulation = 0.8 * Math.sin(x / 35) * Math.cos(y / 45);
  const valley = 2.5 * Math.exp(-(((x - streamAxis(y)) / 14) ** 2));
  return slope + undulation - valley;
}

/** Park–Miller LCG: reproducible jitter. */
function random(seed) {
  let state = seed;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

const fixed = (value, digits = 3) => value.toFixed(digits);

function surveyPoints() {
  const next = random(20261009);
  const points = [];
  let number = 1001;
  const push = (x, y, code) => {
    const cx = Math.min(SIZE.e, Math.max(0, x));
    const cy = Math.min(SIZE.n, Math.max(0, y));
    points.push({ number: number++, x: cx, y: cy, z: ground(cx, cy), code });
  };
  // Topographic grid, 7.5 m with +/- 2 m jitter (a surveyor never stands exactly on a grid).
  for (let i = 0; i <= SIZE.e / 7.5; i++) {
    for (let j = 0; j <= SIZE.n / 7.5; j++) {
      const edge = i === 0 || j === 0 || i === SIZE.e / 7.5 || j === SIZE.n / 7.5;
      const jx = edge ? 0 : (next() - 0.5) * 4;
      const jy = edge ? 0 : (next() - 0.5) * 4;
      push(i * 7.5 + jx, j * 7.5 + jy, 'TOPO');
    }
  }
  // Stream bed (thalweg) every 6 m.
  for (let y = 3; y < SIZE.n; y += 6) push(streamAxis(y), y, 'STR');
  // Existing farm track along the south boundary: both edges of pavement every 10 m.
  for (let x = 90; x <= SIZE.e; x += 10) {
    push(x, 2.5, 'EP');
    push(x, 7.5, 'EP');
  }
  // Isolated trees (ground shot at the trunk).
  for (let k = 0; k < 24; k++) push(10 + next() * 220, 10 + next() * 160, 'TREE');
  return points;
}

function surveyCsv(points) {
  const lines = ['P,E,N,Z,D'];
  for (const p of points) {
    lines.push(
      `${p.number},${fixed(ORIGIN.e + p.x)},${fixed(ORIGIN.n + p.y)},${fixed(p.z)},${p.code}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Marching squares on a regular grid: contour segments at `level`, chained into polylines. */
function contourPolylines(level, step) {
  const nx = Math.round(SIZE.e / step);
  const ny = Math.round(SIZE.n / step);
  const z = (i, j) => ground(i * step, j * step);
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const cross = (i0, j0, i1, j1) => {
    const a = z(i0, j0) - level;
    const b = z(i1, j1) - level;
    if (a < 0 === b < 0) return null;
    const t = a / (a - b);
    return [(i0 + (i1 - i0) * t) * step, (j0 + (j1 - j0) * t) * step];
  };
  const segments = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const hits = [
        cross(i, j, i + 1, j),
        cross(i + 1, j, i + 1, j + 1),
        cross(i + 1, j + 1, i, j + 1),
        cross(i, j + 1, i, j),
      ].filter((p) => p !== null);
      if (hits.length === 2) segments.push([hits[0], hits[1]]);
      if (hits.length === 4) segments.push([hits[0], hits[1]], [hits[2], hits[3]]);
    }
  }
  const lines = [];
  const used = new Array(segments.length).fill(false);
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const line = [...segments[s]];
    let grown = true;
    while (grown) {
      grown = false;
      for (let t = 0; t < segments.length; t++) {
        if (used[t]) continue;
        const [a, b] = segments[t];
        const head = key(line[0]);
        const tail = key(line[line.length - 1]);
        if (key(a) === tail) line.push(b);
        else if (key(b) === tail) line.push(a);
        else if (key(b) === head) line.unshift(a);
        else if (key(a) === head) line.unshift(b);
        else continue;
        used[t] = true;
        grown = true;
      }
    }
    lines.push(line);
  }
  return lines;
}

function dxfPair(code, value) {
  return `${String(code).padStart(3)}\n${value}\n`;
}

function polyline3d(points, z, layer) {
  let out = dxfPair(0, 'POLYLINE') + dxfPair(8, layer) + dxfPair(66, 1);
  out += dxfPair(10, '0.0') + dxfPair(20, '0.0') + dxfPair(30, '0.0') + dxfPair(70, 8);
  for (const [x, y] of points) {
    out += dxfPair(0, 'VERTEX') + dxfPair(8, layer);
    out += dxfPair(10, fixed(ORIGIN.e + x, 2)) + dxfPair(20, fixed(ORIGIN.n + y, 2));
    out += dxfPair(30, fixed(z, 2)) + dxfPair(70, 32);
  }
  return out + dxfPair(0, 'SEQEND') + dxfPair(8, layer);
}

function spotText(x, y, z) {
  return (
    dxfPair(0, 'TEXT') +
    dxfPair(8, 'C-TOPO-SPOT') +
    dxfPair(10, fixed(ORIGIN.e + x, 2)) +
    dxfPair(20, fixed(ORIGIN.n + y, 2)) +
    dxfPair(30, '0.0') +
    dxfPair(40, '1.2') +
    dxfPair(1, fixed(z, 2))
  );
}

function surveyDxf() {
  let entities = '';
  for (let level = 98; level <= 116; level++) {
    const layer = level % 5 === 0 ? 'C-TOPO-MAJR' : 'C-TOPO-MINR';
    for (const line of contourPolylines(level, 10)) {
      if (line.length >= 2) entities += polyline3d(line, level, layer);
    }
  }
  for (let x = 20; x < SIZE.e; x += 40) {
    for (let y = 15; y < SIZE.n; y += 30) entities += spotText(x, y, ground(x, y));
  }
  const header =
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'HEADER') +
    dxfPair(9, '$ACADVER') +
    dxfPair(1, 'AC1009') +
    dxfPair(9, '$INSUNITS') +
    dxfPair(70, 6) +
    dxfPair(0, 'ENDSEC');
  return (
    header +
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'ENTITIES') +
    entities +
    dxfPair(0, 'ENDSEC') +
    dxfPair(0, 'EOF')
  );
}

mkdirSync(OUT_DIR, { recursive: true });
const points = surveyPoints();
writeFileSync(join(OUT_DIR, 'pilot-site-survey.csv'), surveyCsv(points));
writeFileSync(join(OUT_DIR, 'pilot-site-survey.dxf'), surveyDxf());
console.warn(`wrote ${points.length} survey points and the contour DXF to ${OUT_DIR}`);
