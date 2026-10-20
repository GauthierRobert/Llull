/**
 * Independent sketch oracle for the SC-Q4b mutation judges: re-states every constraint kind as residual rows with its own geometry (no
 * import from the solver), and counts degrees of freedom as unknowns − rank of a finite-difference Jacobian of those rows. A judge that
 * agrees with this oracle proves the solver's answer, not the solver's code.
 */

import type { CadDocument, Constraint, EntityRef } from '@core/model/types';

type Pt = readonly [number, number];

/** Line: sx sy ex ey · circle: cx cy r · arc: cx cy r a0 a1 (all local; the entity position is added). */
interface Curve {
  readonly kind: 'line' | 'circle' | 'arc';
  readonly g: number[];
  readonly position: Pt;
}

type Sketch = Map<string, Curve>;

function sketchOf(doc: CadDocument): Sketch {
  const sketch: Sketch = new Map();
  for (const [id, e] of Object.entries(doc.entities)) {
    const position: Pt = [e.position[0], e.position[1]];
    if (e.kind === 'line') sketch.set(id, { kind: 'line', g: [...e.start, ...e.end], position });
    else if (e.kind === 'circle') sketch.set(id, { kind: 'circle', g: [...e.center, e.radius], position });
    else if (e.kind === 'arc') sketch.set(id, { kind: 'arc', g: [...e.center, e.radius, e.startAngle, e.endAngle], position });
  }
  return sketch;
}

const sub = (ref: EntityRef): string | undefined => ('kind' in ref ? ref.kind : undefined);
const g = (c: Curve, i: number): number => c.g[i] ?? Number.NaN;
const add = (c: Curve, x: number, y: number): Pt => [c.position[0] + x, c.position[1] + y];
const minus = (p: Pt, q: Pt): Pt => [p[0] - q[0], p[1] - q[1]];
const cross = (u: Pt, v: Pt): number => u[0] * v[1] - u[1] * v[0];
const dot = (u: Pt, v: Pt): number => u[0] * v[0] + u[1] * v[1];
const norm = (u: Pt): number => Math.hypot(u[0], u[1]);

function curve(sketch: Sketch, ref: EntityRef): Curve {
  const c = sketch.get(ref.entityId);
  if (!c) throw new Error(`oracle: '${ref.entityId}' is not a line, circle or arc`);
  return c;
}

function point(sketch: Sketch, ref: EntityRef): Pt {
  const c = curve(sketch, ref);
  const kind = sub(ref);
  if (c.kind === 'line') {
    if (kind === 'start') return add(c, g(c, 0), g(c, 1));
    if (kind === 'end') return add(c, g(c, 2), g(c, 3));
    if (kind === 'mid' || kind === 'center') return add(c, (g(c, 0) + g(c, 2)) / 2, (g(c, 1) + g(c, 3)) / 2);
  }
  if (c.kind === 'arc' && kind !== 'center' && kind !== undefined) {
    const angle = kind === 'start' ? g(c, 3) : kind === 'end' ? g(c, 4) : (g(c, 3) + g(c, 4)) / 2;
    return add(c, g(c, 0) + g(c, 2) * Math.cos(angle), g(c, 1) + g(c, 2) * Math.sin(angle));
  }
  if (c.kind !== 'line' && kind === 'center') return add(c, g(c, 0), g(c, 1));
  throw new Error(`oracle: reference ${ref.entityId}:${kind ?? ''} has no point`);
}

const lineEnds = (sketch: Sketch, id: string): [Pt, Pt] => [
  point(sketch, { entityId: id, kind: 'start' }),
  point(sketch, { entityId: id, kind: 'end' }),
];

const direction = (sketch: Sketch, id: string): Pt => {
  const [s, e] = lineEnds(sketch, id);
  return minus(e, s);
};

/** Signed distance of `p` from the infinite line `id` (left of start→end is positive). */
const sideOf = (sketch: Sketch, id: string, p: Pt): number => {
  const [s, e] = lineEnds(sketch, id);
  return cross(minus(e, s), minus(p, s)) / norm(minus(e, s));
};

const radius = (c: Curve): number => Math.abs(g(c, 2));
const centre = (c: Curve): Pt => add(c, g(c, 0), g(c, 1));
const sweep = (c: Curve): number => {
  const raw = (g(c, 4) - g(c, 3)) % (2 * Math.PI);
  return raw <= 0 ? raw + 2 * Math.PI : raw;
};
const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Unit tangent of a line or arc at one of its ends, in the direction of travel start → end. */
function tangentAt(sketch: Sketch, ref: EntityRef): Pt {
  const c = curve(sketch, ref);
  if (c.kind === 'line') {
    const d = direction(sketch, ref.entityId);
    return [d[0] / norm(d), d[1] / norm(d)];
  }
  const angle = sub(ref) === 'start' ? g(c, 3) : g(c, 4);
  return [-Math.sin(angle), Math.cos(angle)];
}

const isRound = (c: Curve): boolean => c.kind !== 'line';
const lineForm = (c: Constraint): boolean => c.a.entityId === c.b.entityId && sub(c.a) === undefined && sub(c.b) === undefined;

/** Residual rows of one constraint (all zero when it holds). `value` must be numeric; `fix` is skipped (it pins to the pre-solve state). */
function residuals(doc: CadDocument, c: Constraint, sketch: Sketch = sketchOf(doc)): number[] {
  const value = 'value' in c ? Number(c.value) : 0;
  const pa = (): Pt => point(sketch, c.a);
  const pb = (): Pt => point(sketch, c.b);
  const ca = (): Curve => curve(sketch, c.a);
  const cb = (): Curve => curve(sketch, c.b);
  switch (c.kind) {
    case 'coincident':
      return [...minus(pa(), pb())];
    case 'horizontal':
      return lineForm(c) ? [direction(sketch, c.a.entityId)[1]] : [pa()[1] - pb()[1]];
    case 'vertical':
      return lineForm(c) ? [direction(sketch, c.a.entityId)[0]] : [pa()[0] - pb()[0]];
    case 'parallel':
    case 'perpendicular': {
      const [u, v] = [direction(sketch, c.a.entityId), direction(sketch, c.b.entityId)];
      return [(c.kind === 'parallel' ? cross(u, v) : dot(u, v)) / (norm(u) * norm(v))];
    }
    case 'equal':
      return isRound(ca())
        ? [radius(ca()) - radius(cb())]
        : [norm(direction(sketch, c.a.entityId)) - norm(direction(sketch, c.b.entityId))];
    case 'concentric':
      return [...minus(centre(ca()), centre(cb()))];
    case 'collinear':
      return lineEnds(sketch, c.b.entityId).map((p) => sideOf(sketch, c.a.entityId, p));
    case 'midpoint': {
      const [s, e] = lineEnds(sketch, c.b.entityId);
      return [...minus(pa(), [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2])];
    }
    case 'symmetric': {
      const [p, q] = [pa(), pb()];
      const mid: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      if (sub(c.axis) !== undefined) return [...minus(mid, point(sketch, c.axis))];
      const axis = direction(sketch, c.axis.entityId);
      return [sideOf(sketch, c.axis.entityId, mid), dot(minus(q, p), axis) / norm(axis)];
    }
    case 'point_on_curve':
      return cb().kind === 'line' ? [sideOf(sketch, c.b.entityId, pa())] : [norm(minus(pa(), centre(cb()))) - radius(cb())];
    case 'tangent': {
      const [a, b] = [ca(), cb()];
      if (a.kind === 'line' || b.kind === 'line') {
        const [lineId, round] = a.kind === 'line' ? [c.a.entityId, b] : [c.b.entityId, a];
        return [Math.abs(sideOf(sketch, lineId, centre(round))) - radius(round)];
      }
      const d = norm(minus(centre(a), centre(b)));
      const [outer, inner] = [d - (radius(a) + radius(b)), d - Math.abs(radius(a) - radius(b))];
      return [Math.abs(outer) < Math.abs(inner) ? outer : inner];
    }
    case 'curvature': {
      const g1 = cross(tangentAt(sketch, c.a), tangentAt(sketch, c.b));
      const g2 = isRound(ca()) && isRound(cb()) ? [radius(ca()) - radius(cb())] : [];
      return [...minus(pa(), pb()), g1, ...g2];
    }
    case 'distance':
      return [norm(minus(pa(), pb())) - value];
    case 'aligned':
      return [(lineForm(c) ? norm(direction(sketch, c.a.entityId)) : norm(minus(pa(), pb()))) - value];
    case 'horizontal_distance':
      return [Math.abs(pb()[0] - pa()[0]) - value];
    case 'vertical_distance':
      return [Math.abs(pb()[1] - pa()[1]) - value];
    case 'point_to_line':
      return [Math.abs(sideOf(sketch, c.b.entityId, pa())) - value];
    case 'angle': {
      const [u, v] = [direction(sketch, c.a.entityId), direction(sketch, c.b.entityId)];
      return [wrap(Math.atan2(cross(u, v), dot(u, v)) - value)];
    }
    case 'radius':
      return [radius(ca()) - value];
    case 'diameter':
      return [2 * radius(ca()) - value];
    case 'arc_sweep':
      return [wrap(sweep(ca()) - value)];
    case 'arc_length':
      return [radius(ca()) * sweep(ca()) - value];
    case 'slot_length':
      return [norm(minus(centre(ca()), centre(cb()))) - value];
    case 'fix':
      return [];
  }
}

/** Largest residual over every constraint of the document. */
export function worstResidual(doc: CadDocument): { id: string; residual: number } {
  const sketch = sketchOf(doc);
  let worst = { id: '', residual: 0 };
  for (const id of doc.constraintOrder) {
    const c = doc.constraints[id];
    if (!c) continue;
    const r = Math.max(0, ...residuals(doc, c, sketch).map(Math.abs));
    if (r > worst.residual) worst = { id, residual: r };
  }
  return worst;
}

/** Rows of `fix`: the pinned point, or every variable of a pinned curve, held at the variable values `x0`. */
function fixRows(sketch: Sketch, base: Sketch, c: Constraint): number[] {
  if (sub(c.a) !== undefined) return [...minus(point(sketch, c.a), point(base, c.a))];
  const [now, then] = [curve(sketch, c.a), curve(base, c.a)];
  return now.g.map((v, i) => v - g(then, i));
}

/** Rank of `rows` (each a gradient) by Gaussian elimination with partial pivoting, relative tolerance `tol`. */
function rank(rows: number[][], tol = 1e-7): number {
  const m = rows.map((r) => [...r]);
  const scale = Math.max(1e-30, ...m.flat().map(Math.abs));
  let r = 0;
  const columns = m[0]?.length ?? 0;
  for (let col = 0; col < columns && r < m.length; col++) {
    let pivot = r;
    for (let i = r + 1; i < m.length; i++) if (Math.abs(m[i]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) pivot = i;
    const pivotRow = m[pivot];
    if (!pivotRow || Math.abs(pivotRow[col] ?? 0) <= tol * scale) continue;
    [m[r], m[pivot]] = [pivotRow, m[r] ?? pivotRow];
    for (let i = r + 1; i < m.length; i++) {
      const row = m[i];
      if (!row) continue;
      const f = (row[col] ?? 0) / (pivotRow[col] ?? 1);
      for (let k = col; k < columns; k++) row[k] = (row[k] ?? 0) - f * (pivotRow[k] ?? 0);
    }
    r++;
  }
  return r;
}

/** Degrees of freedom of the document's lines/circles/arcs: unknowns − rank of the constraint Jacobian at the current geometry. */
export function oracleDof(doc: CadDocument): number {
  const base = sketchOf(doc);
  const ids = [...base.keys()].sort();
  const slots = ids.flatMap((id) => (base.get(id)?.g ?? []).map((_, i) => [id, i] as const));
  const constraints = doc.constraintOrder.flatMap((id) => doc.constraints[id] ?? []);
  const rowsAt = (sketch: Sketch): number[] =>
    constraints.flatMap((c) => (c.kind === 'fix' ? fixRows(sketch, base, c) : residuals(doc, c, sketch)));
  const columns = slots.map(([id, i]) => {
    const h = 1e-6 * Math.max(1, Math.abs(g(base.get(id) as Curve, i)));
    const shifted = (delta: number): Sketch => {
      const copy: Sketch = new Map(base);
      const c = base.get(id) as Curve;
      copy.set(id, { ...c, g: c.g.map((v, k) => (k === i ? v + delta : v)) });
      return copy;
    };
    const [plus, less] = [rowsAt(shifted(h)), rowsAt(shifted(-h))];
    return plus.map((v, k) => (v - (less[k] ?? 0)) / (2 * h));
  });
  const rowCount = columns[0]?.length ?? 0;
  const jacobian = Array.from({ length: rowCount }, (_, row) => columns.map((col) => col[row] ?? 0));
  return slots.length - rank(jacobian);
}
