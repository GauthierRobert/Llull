import type { CadDocument, Constraint, EntityRef } from '../../../model/types';
import { resolveNumeric } from '../expression';
import { pointOf, slotOf, subKindOf, type Layout } from './layout';
import { at } from './linalg';

/** A point whose world position is `variable + offset` in two directly owned variables (movable without side effects). */
interface Handle {
  readonly ix: number;
  readonly iy: number;
  readonly ox: number;
  readonly oy: number;
}

interface Known {
  x: boolean;
  y: boolean;
}

type Relation = { kind: 'copy'; axis: 0 | 1 } | { kind: 'offset'; axis: 0 | 1; amount: number } | { kind: 'distance'; amount: number };

function handleOf(layout: Layout, ref: EntityRef): Handle | null {
  const block = layout.blocks.get(ref.entityId);
  if (!block) return null;
  const slot = slotOf(block.kind, subKindOf(ref));
  if (slot === 'position') return block.posOffset >= 0 ? { ix: block.posOffset, iy: block.posOffset + 1, ox: 0, oy: 0 } : null;
  if (block.kind === 'point' || block.posOffset >= 0) return null;
  const [ox, oy] = [block.position[0], block.position[1]];
  const o = block.offset;
  if (slot === 'center' && block.kind !== 'line') return { ix: o, iy: o + 1, ox, oy };
  if (block.kind === 'line' && slot === 'start') return { ix: o, iy: o + 1, ox, oy };
  if (block.kind === 'line' && slot === 'end') return { ix: o + 2, iy: o + 3, ox, oy };
  return null;
}

/** The point pair a constraint relates: the endpoints of the line in line form, else its `a` and `b` references. */
function pairOf(layout: Layout, c: Constraint): [EntityRef, EntityRef] {
  const lineForm = c.a.entityId === c.b.entityId && subKindOf(c.a) === undefined && subKindOf(c.b) === undefined;
  return lineForm && layout.blocks.get(c.a.entityId)?.kind === 'line'
    ? [
        { entityId: c.a.entityId, kind: 'start' },
        { entityId: c.a.entityId, kind: 'end' },
      ]
    : [c.a, c.b];
}

function relationOf(doc: CadDocument, layout: Layout, c: Constraint, p: EntityRef, q: EntityRef): Relation | null {
  const value = 'value' in c ? resolveNumeric(c.value, doc.parameters) : null;
  const here = (ref: EntityRef): readonly [number, number] => pointOf(layout, layout.x0, ref) ?? [0, 0];
  switch (c.kind) {
    case 'horizontal':
      return { kind: 'copy', axis: 1 };
    case 'vertical':
      return { kind: 'copy', axis: 0 };
    case 'horizontal_distance':
    case 'vertical_distance': {
      const axis = c.kind === 'horizontal_distance' ? 0 : 1;
      if (value === null) return null;
      return { kind: 'offset', axis, amount: (here(q)[axis] - here(p)[axis] < 0 ? -1 : 1) * Math.abs(value) };
    }
    case 'distance':
    case 'aligned':
      return value === null ? null : { kind: 'distance', amount: value };
    default:
      return null;
  }
}

/**
 * Initial guess for the iterative solve: starts from the sketch as it is and, keeping its branch (signs of current offsets), sets every
 * point that fixed points, coincidences, horizontal/vertical relations and distances already determine. The least-squares pass refines it.
 * Rigid clusters are not detected; the least-squares pass handles them.
 */
export function constructiveGuess(doc: CadDocument, layout: Layout, constraints: readonly Constraint[]): Float64Array {
  const x = Float64Array.from(layout.x0);
  const known = new Map<number, Known>();
  const flags = (h: Handle): Known => {
    const existing = known.get(h.ix);
    if (existing) return existing;
    const created = { x: false, y: false };
    known.set(h.ix, created);
    return created;
  };
  const world = (h: Handle): [number, number] => [at(x, h.ix) + h.ox, at(x, h.iy) + h.oy];
  const set = (h: Handle, axis: 0 | 1, value: number): void => {
    x[axis === 0 ? h.ix : h.iy] = value - (axis === 0 ? h.ox : h.oy);
    flags(h)[axis === 0 ? 'x' : 'y'] = true;
  };
  const isKnown = (h: Handle, axis: 0 | 1): boolean => flags(h)[axis === 0 ? 'x' : 'y'];
  const complete = (h: Handle): boolean => isKnown(h, 0) && isKnown(h, 1);

  for (const c of constraints) {
    if (c.kind !== 'fix') continue;
    const block = layout.blocks.get(c.a.entityId);
    const refs: EntityRef[] =
      block && block.kind !== 'point' && subKindOf(c.a) === undefined
        ? [
            { entityId: c.a.entityId, kind: block.kind === 'line' ? 'start' : 'center' },
            ...(block.kind === 'line' ? [{ entityId: c.a.entityId, kind: 'end' as const }] : []),
          ]
        : [c.a];
    for (const ref of refs) {
      const h = handleOf(layout, ref);
      if (h) {
        flags(h).x = true;
        flags(h).y = true;
      }
    }
  }

  const apply = (relation: Relation, from: Handle, to: Handle, sign: 1 | -1): boolean => {
    if (relation.kind === 'distance') return false;
    const axis = relation.axis;
    if (!isKnown(from, axis) || isKnown(to, axis)) return false;
    const base = world(from)[axis];
    set(to, axis, relation.kind === 'copy' ? base : base + sign * relation.amount);
    return true;
  };
  /** One coordinate of `to` is known: the other follows from the distance, on the side it is on now. */
  const solveDistance = (relation: Relation, from: Handle, to: Handle): boolean => {
    if (relation.kind !== 'distance' || !complete(from) || complete(to)) return false;
    for (const axis of [0, 1] as const) {
      const other = axis === 0 ? 1 : 0;
      if (!isKnown(to, axis) || isKnown(to, other)) continue;
      const along = world(to)[axis] - world(from)[axis];
      const across = Math.sqrt(Math.max(relation.amount ** 2 - along ** 2, 0));
      const current = world(to)[other] - world(from)[other];
      set(to, other, world(from)[other] + (current < 0 ? -across : across));
      return true;
    }
    return false;
  };

  const links = constraints.flatMap((c) => {
    const [pRef, qRef] = pairOf(layout, c);
    const p = handleOf(layout, pRef);
    const q = handleOf(layout, qRef);
    const relation = c.kind === 'coincident' ? null : relationOf(doc, layout, c, pRef, qRef);
    if (!p || !q || (c.kind !== 'coincident' && !relation)) return [];
    return [
      {
        p,
        q,
        relation: c.kind === 'coincident' ? ({ kind: 'copy', axis: 0 } as const) : (relation as Relation),
        coincident: c.kind === 'coincident',
      },
    ];
  });

  const propagate = (): void => {
    for (let pass = 0; pass < 12; pass++) {
      let changed = false;
      for (const { p, q, relation, coincident } of links) {
        const relations: Relation[] = coincident
          ? [
              { kind: 'copy', axis: 0 },
              { kind: 'copy', axis: 1 },
            ]
          : [relation];
        for (const r of relations) {
          changed = apply(r, p, q, 1) || apply(r, q, p, -1) || solveDistance(r, p, q) || solveDistance(r, q, p) || changed;
        }
      }
      if (!changed) break;
    }
  };
  propagate();
  for (const { p, q, relation } of links) {
    if (relation.kind !== 'distance' || relation.amount <= 0) continue;
    const [moving, anchor] = complete(q) && !complete(p) ? [p, q] : [q, p];
    if (complete(moving)) continue;
    const [ax, ay] = world(anchor);
    const [mx, my] = world(moving);
    const gap = Math.hypot(mx - ax, my - ay);
    const [ux, uy] = gap < 1e-9 ? [1, 0] : [(mx - ax) / gap, (my - ay) / gap];
    if (!isKnown(moving, 0) && !isKnown(moving, 1)) {
      x[moving.ix] = ax + ux * relation.amount - moving.ox;
      x[moving.iy] = ay + uy * relation.amount - moving.oy;
    }
  }
  propagate();
  return x;
}
