#!/usr/bin/env node
// The bundled single-line (open-stroke) engraving font of llull (03 WRP M5, D-WRP-3): drawn for this project, an original work released under CC0-1.0, so it ships offline and
// carries no third-party licence (Relief SingleLine [R25] is not bundled: it cannot be fetched offline). Glyphs are polylines on a 5 x 7 grid scaled to 1000 units per em
// (cap height 700, left bearing 50); curves are sampled arcs. Capitals, digits and a few marks; lower case maps to capitals in the layout.
//
//   node generate_single_line_font.mjs        writes ../../../../server/fonts/LlullSingleLine.json
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', '..', '..', 'server', 'fonts', 'LlullSingleLine.json');

/** Points of an elliptical arc about (cx, cy), degrees counter-clockwise from +x; a negative sweep runs clockwise. */
function arc(cx, cy, rx, ry, from, to, steps = 14) {
  return Array.from({ length: steps + 1 }, (_, k) => {
    const a = ((from + ((to - from) * k) / steps) * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}
const loop = (cx, cy, rx, ry) => arc(cx, cy, rx, ry, 0, 360, 24);
const line = (...c) => c.reduce((acc, v, k) => (k % 2 === 0 ? [...acc, [v, c[k + 1]]] : acc), []);
const join2 = (...parts) => parts.flat();

const G = {
  A: [line(0, 0, 2.5, 7, 5, 0), line(1, 2.6, 4, 2.6)],
  B: [
    join2(line(0, 0, 0, 7, 3, 7), arc(3, 5.25, 1.5, 1.75, 90, -90), line(0, 3.5)),
    join2(line(0, 3.5, 3.4, 3.5), arc(3.4, 1.75, 1.6, 1.75, 90, -90), line(0, 0)),
  ],
  C: [arc(2.6, 3.5, 2.4, 3.5, 40, 320, 24)],
  D: [join2(line(0, 0, 0, 7, 2.5, 7), arc(2.5, 3.5, 2.5, 3.5, 90, -90, 18), line(0, 0))],
  E: [line(5, 7, 0, 7, 0, 0, 5, 0), line(0, 3.5, 3.8, 3.5)],
  F: [line(5, 7, 0, 7, 0, 0), line(0, 3.5, 3.8, 3.5)],
  G: [join2(arc(2.6, 3.5, 2.4, 3.5, 40, 360, 26), line(2.8, 3.5))],
  H: [line(0, 0, 0, 7), line(5, 0, 5, 7), line(0, 3.5, 5, 3.5)],
  I: [line(1, 0, 1, 7)],
  J: [join2(line(4, 7, 4, 2), arc(2.5, 2, 1.5, 1.5, 0, -180, 12), line(1, 2.3))],
  K: [line(0, 0, 0, 7), line(5, 7, 0, 2.5), line(1.6, 4.2, 5, 0)],
  L: [line(0, 7, 0, 0, 4.5, 0)],
  M: [line(0, 0, 0, 7, 2.5, 2.5, 5, 7, 5, 0)],
  N: [line(0, 0, 0, 7, 5, 0, 5, 7)],
  O: [loop(2.5, 3.5, 2.5, 3.5)],
  P: [join2(line(0, 0, 0, 7, 3, 7), arc(3, 5.25, 1.9, 1.75, 90, -90), line(0, 3.5))],
  Q: [loop(2.5, 3.5, 2.5, 3.5), line(3.2, 1.6, 5, -0.6)],
  R: [join2(line(0, 0, 0, 7, 3, 7), arc(3, 5.25, 1.9, 1.75, 90, -90), line(0, 3.5)), line(2.4, 3.5, 5, 0)],
  S: [join2(arc(2.5, 5.25, 2.3, 1.75, 25, 270, 16), arc(2.5, 1.75, 2.5, 1.75, 90, -160, 18))],
  T: [line(0, 7, 5, 7), line(2.5, 7, 2.5, 0)],
  U: [join2(line(0, 7, 0, 2.5), arc(2.5, 2.5, 2.5, 2.5, 180, 360, 18), line(5, 7))],
  V: [line(0, 7, 2.5, 0, 5, 7)],
  W: [line(0, 7, 1.25, 0, 2.5, 5, 3.75, 0, 5, 7)],
  X: [line(0, 0, 5, 7), line(0, 7, 5, 0)],
  Y: [line(0, 7, 2.5, 3.5, 5, 7), line(2.5, 3.5, 2.5, 0)],
  Z: [line(0, 7, 5, 7, 0, 0, 5, 0)],
  0: [loop(2.5, 3.5, 2.3, 3.5)],
  1: [line(0.8, 5.6, 2.5, 7, 2.5, 0)],
  2: [join2(arc(2.5, 5.2, 2.3, 1.8, 160, -35, 14), line(0, 0, 5, 0))],
  3: [join2(arc(2.4, 5.25, 2.2, 1.75, 150, -90, 14)), join2(arc(2.4, 1.75, 2.4, 1.75, 90, -150, 16))],
  4: [line(3.8, 0, 3.8, 7, 0, 2.2, 5, 2.2)],
  5: [join2(line(4.6, 7, 0.6, 7, 0.3, 3.9), arc(2.4, 2.2, 2.5, 2.2, 120, -150, 18))],
  6: [loop(2.5, 2.3, 2.3, 2.3), line(0.2, 2.3, 0.5, 4.6, 1.6, 6.5, 3.1, 7, 4.4, 6.4)],
  7: [line(0, 7, 5, 7, 1.8, 0)],
  8: [loop(2.5, 5.3, 2, 1.7), loop(2.5, 1.8, 2.4, 1.8)],
  9: [loop(2.5, 4.7, 2.3, 2.3), line(4.8, 4.7, 4.5, 2.4, 3.4, 0.5, 1.9, 0, 0.6, 0.6)],
  '.': [loop(1.5, 0.45, 0.35, 0.35).slice(0, 25)],
  ',': [line(1.7, 0.4, 1.2, -1.2)],
  '-': [line(0.8, 3.5, 4.2, 3.5)],
  '+': [line(0.8, 3.5, 4.2, 3.5), line(2.5, 1.8, 2.5, 5.2)],
  '=': [line(0.8, 2.6, 4.2, 2.6), line(0.8, 4.4, 4.2, 4.4)],
  '/': [line(0, 0, 5, 7)],
  ':': [loop(1.5, 0.45, 0.35, 0.35), loop(1.5, 4.55, 0.35, 0.35)],
  '!': [line(1.5, 7, 1.5, 2.3), loop(1.5, 0.45, 0.35, 0.35)],
  '(': [arc(4.4, 3.5, 2.6, 4.2, 118, 242, 12)],
  ')': [arc(0.6, 3.5, 2.6, 4.2, 62, -62, 12)],
  _: [line(0, -1, 5, -1)],
  '#': [line(1.5, 0, 1.5, 7), line(3.5, 0, 3.5, 7), line(0, 2.4, 5, 2.4), line(0, 4.6, 5, 4.6)],
};
const advances = { I: 3, J: 5.5, '.': 3, ',': 3, ':': 3, '!': 3, '(': 4.5, ')': 4.5, ' ': 3, 1: 5 };

const round = (v) => Math.round(v * 100 * 10) / 10;
const glyphs = {};
for (const [char, strokes] of Object.entries(G))
  glyphs[char] = {
    advance: Math.round((advances[char] ?? 6) * 100),
    strokes: strokes.map((stroke) =>
      stroke
        .map(([x, y]) => [round(x + 0.5), round(y)])
        .filter((p, k, all) => k === 0 || Math.hypot(p[0] - all[k - 1][0], p[1] - all[k - 1][1]) > 1e-6),
    ),
  };
glyphs[' '] = { advance: 300, strokes: [] };

const font = {
  format: 'llull-stroke-font',
  version: 1,
  family: 'LLULL Single Line',
  style: 'Regular',
  licence: 'CC0-1.0 (original work for llull)',
  unitsPerEm: 1000,
  capHeight: 700,
  ascender: 900,
  descender: -250,
  lineGap: 0,
  glyphs,
};
const text = JSON.stringify(font) + '\n';
writeFileSync(out, text);
process.stdout.write(
  `${Object.keys(glyphs).length} glyphs, ${text.length} bytes, sha256 ${createHash('sha256').update(text).digest('hex')}\n`,
);
