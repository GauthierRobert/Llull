// UXD reference generator (specs only, no llull import): node generate_refs.mjs
// 1. KLM predictions of every benchmark task method (data/benchmark_tasks.json x data/klm_operators.json) -> data/klm_predictions.json
// 2. Closed-form expected points of the coordinate grammar, snap and tracking cases -> data/*_cases.json ("expected" fields)
// Every value written here is derived from the inputs by the formulas below; nothing is typed by hand.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const data = (name) => join(here, 'data', name);
const readJson = (name) => JSON.parse(readFileSync(data(name), 'utf8'));
const writeJson = (name, value) => writeFileSync(data(name), JSON.stringify(value, null, 1) + '\n');
const round = (x, digits = 10) => Number(x.toFixed(digits));
const deg = Math.PI / 180;

// ---------- 1. KLM ----------
const operators = readJson('klm_operators.json');
const tasks = readJson('benchmark_tasks.json');

/** Count operators of one method: { M, P, B, BB, H, K } */
function countOperators(steps) {
  const counts = { M: 0, P: 0, B: 0, BB: 0, H: 0, K: 0 };
  for (const raw of steps) {
    const [step, times = '1'] = raw.split('*');
    const n = Number(times);
    if (step.startsWith('K:')) {
      const keys = [...step.slice(2).replace(/\{[^}]+\}/g, '#')].length;
      counts.K += keys * n;
    } else if (step in counts) counts[step] += n;
    else throw new Error(`unknown KLM step ${raw}`);
  }
  return counts;
}

function timeOf(counts, values) {
  return (
    counts.M * values.M + counts.P * values.P + counts.B * values.B + counts.BB * values.BB + counts.H * values.H + counts.K * values.K
  );
}

const primary = Object.fromEntries(Object.entries(operators.primary).map(([k, v]) => [k, v.value]));
const variants = [{ name: 'primary', ...primary }, ...operators.sensitivity.map((s) => ({ ...primary, ...s }))];

const predictions = tasks.tasks.map((task) => {
  const row = { id: task.id, title: task.title };
  for (const method of ['incumbent', 'target', 'today']) {
    const steps = task[method].steps;
    if (steps === null) {
      row[method] = null;
      continue;
    }
    const counts = countOperators(steps);
    const times = Object.fromEntries(variants.map((v) => [v.name, round(timeOf(counts, v), 3)]));
    const formula = `${counts.M}M + ${counts.P}P + ${counts.B}B + ${counts.BB}BB + ${counts.H}H + ${counts.K}K`;
    row[method] = { counts, formula, seconds: times };
  }
  row.targetOverIncumbent = row.target && row.incumbent ? round(row.target.seconds.primary / row.incumbent.seconds.primary, 4) : null;
  row.todayOverIncumbent = row.today && row.incumbent ? round(row.today.seconds.primary / row.incumbent.seconds.primary, 4) : null;
  return row;
});

const sum = (method) =>
  round(
    predictions.reduce((s, r) => s + (r[method]?.seconds.primary ?? 0), 0),
    3,
  );
const completableToday = predictions.filter((r) => r.today !== null).map((r) => r.id);
writeJson('klm_predictions.json', {
  generated: 'generate_refs.mjs',
  operatorValues: primary,
  rule: 'seconds = sum(count x operator time); primary = Kieras values (K .28, P 1.1, B .1, BB .2, H .4, M 1.2)',
  totals: {
    incumbentAll: sum('incumbent'),
    targetAll: sum('target'),
    completableToday,
    todayOnCompletable: round(
      predictions.reduce((s, r) => s + (r.today?.seconds.primary ?? 0), 0),
      3,
    ),
    incumbentOnCompletable: round(
      predictions.filter((r) => r.today !== null).reduce((s, r) => s + r.incumbent.seconds.primary, 0),
      3,
    ),
  },
  tasks: predictions,
});

// ---------- 2a. coordinate grammar (llull convention: angle CCW from +X, degrees) ----------
const polar = (from, distance, angleDeg) => [from[0] + distance * Math.cos(angleDeg * deg), from[1] + distance * Math.sin(angleDeg * deg)];
const add = (a, b) => a.map((v, i) => v + b[i]);
const coordinateCases = readJson('coordinate_grammar_cases.json');
for (const c of coordinateCases.cases) {
  if (c.expectError) continue;
  const m = c.meaning;
  let p;
  if (m.kind === 'absolute') p = m.xy;
  else if (m.kind === 'relative') p = add(c.lastPoint, m.dxy);
  else if (m.kind === 'polar-relative') p = polar(c.lastPoint, m.distance, m.angleDeg);
  else if (m.kind === 'polar-absolute') p = polar([0, 0, 0].slice(0, c.lastPoint.length), m.distance, m.angleDeg);
  else if (m.kind === 'direct-distance') p = polar(c.lastPoint, m.distance, m.cursorAngleDeg);
  else throw new Error(`unknown meaning ${m.kind}`);
  if (p.length < c.lastPoint.length) p = [...p, c.lastPoint[2] ?? 0];
  c.expected = p.map((v) => round(v));
}
writeJson('coordinate_grammar_cases.json', coordinateCases);

// ---------- 2b. snap / ortho / polar / tracking closed forms ----------
const snapCases = readJson('snap_cases.json');
const handlers = {
  quadrant: ({ center: [cx, cy], radius: r }) => [
    [cx + r, cy],
    [cx, cy + r],
    [cx - r, cy],
    [cx, cy - r],
  ],
  midpoint: ({ a, b }) => [[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]],
  intersection: ({ a, b, c, d }) => {
    const den = (a[0] - b[0]) * (c[1] - d[1]) - (a[1] - b[1]) * (c[0] - d[0]);
    const t = ((a[0] - c[0]) * (c[1] - d[1]) - (a[1] - c[1]) * (c[0] - d[0])) / den;
    return [[a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]];
  },
  perpendicular: ({ from, a, b }) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = ((from[0] - a[0]) * dx + (from[1] - a[1]) * dy) / (dx * dx + dy * dy);
    return [[a[0] + t * dx, a[1] + t * dy]];
  },
  tangent: ({ from, center, radius }) => {
    const [dx, dy] = [from[0] - center[0], from[1] - center[1]];
    const d = Math.hypot(dx, dy);
    const base = Math.atan2(dy, dx);
    const half = Math.acos(radius / d);
    return [base + half, base - half].map((t) => [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)]);
  },
  geometricCenter: ({ polygon }) => {
    let area2 = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < polygon.length; i++) {
      const [x0, y0] = polygon[i];
      const [x1, y1] = polygon[(i + 1) % polygon.length];
      const cross = x0 * y1 - x1 * y0;
      area2 += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    return [[cx / (3 * area2), cy / (3 * area2)]];
  },
  extension: ({ a, b, distanceBeyondB }) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [[b[0] + ((b[0] - a[0]) / len) * distanceBeyondB, b[1] + ((b[1] - a[1]) / len) * distanceBeyondB]];
  },
  ortho: ({ origin, cursor }) => {
    const [dx, dy] = [cursor[0] - origin[0], cursor[1] - origin[1]];
    return [Math.abs(dx) >= Math.abs(dy) ? [origin[0] + dx, origin[1]] : [origin[0], origin[1] + dy]];
  },
  polar: ({ origin, cursor, incrementDeg }) => {
    const [dx, dy] = [cursor[0] - origin[0], cursor[1] - origin[1]];
    const len = Math.hypot(dx, dy);
    const inc = incrementDeg * deg;
    const angle = Math.round(Math.atan2(dy, dx) / inc) * inc;
    return [[origin[0] + len * Math.cos(angle), origin[1] + len * Math.sin(angle)]];
  },
  trackingTwoPaths: ({ a, angleADeg, b, angleBDeg }) => {
    // intersection of the ray through a at angleA with the ray through b at angleB
    const [ux, uy] = [Math.cos(angleADeg * deg), Math.sin(angleADeg * deg)];
    const [vx, vy] = [Math.cos(angleBDeg * deg), Math.sin(angleBDeg * deg)];
    const den = ux * vy - uy * vx;
    const t = ((b[0] - a[0]) * vy - (b[1] - a[1]) * vx) / den;
    return [[a[0] + t * ux, a[1] + t * uy]];
  },
  viewCubeDirections: () => {
    const dirs = [];
    for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) dirs.push([x, y, z]);
    return dirs;
  },
};
for (const c of snapCases.cases) {
  const handler = handlers[c.kind];
  if (!handler) throw new Error(`unknown snap case kind ${c.kind}`);
  const points = handler(c.input);
  c.expected = c.kind === 'viewCubeDirections' ? { count: points.length } : points.map((p) => p.map((v) => round(v)));
}
writeJson('snap_cases.json', snapCases);

for (const r of predictions) {
  const f = (m) => (r[m] ? r[m].seconds.primary.toFixed(2).padStart(6) : '     -');
  process.stdout.write(`${r.id}  incumbent ${f('incumbent')} s  target ${f('target')} s  today ${f('today')} s
`);
}
process.stdout.write(`totals ${JSON.stringify(JSON.parse(readFileSync(data('klm_predictions.json'), 'utf8')).totals)}
`);
