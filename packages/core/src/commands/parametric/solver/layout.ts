import type { CadDocument, Constraint, Entity, EntityRef, Vec3 } from '../../../model/types';
import { at } from './linalg';

export type Pt = readonly [number, number];

/** Variable block kinds: curves own geometry variables; every other referenced entity is a bare position. */
export type BlockKind = 'line' | 'circle' | 'arc' | 'point';

/** Which point of a block a reference resolves to. */
export type PointSlot = 'start' | 'end' | 'center' | 'mid' | 'position';

export interface Block {
  readonly id: string;
  readonly kind: BlockKind;
  /** First geometry variable (line: sx sy ex ey; circle: cx cy r; arc: cx cy r startAngle endAngle). */
  readonly offset: number;
  readonly size: number;
  /** First of the two position variables, or -1 when the entity position is a constant. */
  readonly posOffset: number;
  readonly position: Vec3;
}

/** The unknowns of a sketch: one flat vector, partitioned in per-entity blocks. */
export interface Layout {
  readonly blocks: ReadonlyMap<string, Block>;
  readonly x0: Float64Array;
  /** Owning entity id of each variable. */
  readonly owner: readonly string[];
}

const GEOMETRY_SIZE: Record<BlockKind, number> = { line: 4, circle: 3, arc: 5, point: 0 };

export function subKindOf(ref: EntityRef): string | undefined {
  return 'kind' in ref ? ref.kind : undefined;
}

export function slotOf(kind: BlockKind, sub: string | undefined): PointSlot {
  if (kind === 'line') return sub === 'start' || sub === 'end' ? sub : sub === 'center' || sub === 'mid' ? 'mid' : 'position';
  if (kind === 'circle') return sub === 'center' ? 'center' : 'position';
  if (kind === 'arc') return sub === 'center' || sub === 'start' || sub === 'end' || sub === 'mid' ? sub : 'position';
  return 'position';
}

function blockKindOf(entity: Entity): BlockKind {
  return entity.kind === 'line' || entity.kind === 'circle' || entity.kind === 'arc' ? entity.kind : 'point';
}

function constraintRefs(c: Constraint): EntityRef[] {
  return 'axis' in c ? [c.a, c.b, c.axis] : [c.a, c.b];
}

const POINT_PAIR_KINDS: ReadonlySet<string> = new Set([
  'coincident',
  'distance',
  'aligned',
  'horizontal_distance',
  'vertical_distance',
  'horizontal',
  'vertical',
  'symmetric',
]);

/** The references a constraint reads as points (a reference without a sub-point then means the entity position). */
function pointRefs(c: Constraint): EntityRef[] {
  const lineForm = c.a.entityId === c.b.entityId && subKindOf(c.a) === undefined && subKindOf(c.b) === undefined;
  if (POINT_PAIR_KINDS.has(c.kind)) {
    const axisPoint = 'axis' in c && subKindOf(c.axis) !== undefined ? [c.axis] : [];
    return (c.kind === 'aligned' || c.kind === 'horizontal' || c.kind === 'vertical') && lineForm ? [] : [c.a, c.b, ...axisPoint];
  }
  if (c.kind === 'midpoint' || c.kind === 'point_on_curve' || c.kind === 'point_to_line') return [c.a];
  return c.kind === 'fix' && subKindOf(c.a) !== undefined ? [c.a] : [];
}

/** Lay out every line/arc/circle of the document plus every other entity a constraint references. */
export function buildLayout(doc: CadDocument, constraints: readonly Constraint[], scoped = false): Layout {
  const refs = constraints.flatMap(constraintRefs).filter((ref) => Object.hasOwn(doc.entities, ref.entityId));
  const needsPosition = new Set<string>();
  const ids = new Set<string>();
  if (!scoped) for (const [id, entity] of Object.entries(doc.entities)) if (blockKindOf(entity) !== 'point') ids.add(id);
  for (const ref of refs) ids.add(ref.entityId);
  for (const ref of constraints.flatMap(pointRefs)) {
    const entity = doc.entities[ref.entityId];
    if (entity && slotOf(blockKindOf(entity), subKindOf(ref)) === 'position') needsPosition.add(ref.entityId);
  }
  const blocks = new Map<string, Block>();
  const values: number[] = [];
  const owner: string[] = [];
  const push = (id: string, ...numbers: number[]): void => {
    for (const value of numbers) {
      values.push(value);
      owner.push(id);
    }
  };
  for (const id of [...ids].sort()) {
    const entity = doc.entities[id];
    if (!entity) continue;
    const kind = blockKindOf(entity);
    const offset = values.length;
    if (entity.kind === 'line') push(id, entity.start[0], entity.start[1], entity.end[0], entity.end[1]);
    else if (entity.kind === 'circle') push(id, entity.center[0], entity.center[1], entity.radius);
    else if (entity.kind === 'arc') push(id, entity.center[0], entity.center[1], entity.radius, entity.startAngle, entity.endAngle);
    const posOffset = kind === 'point' || needsPosition.has(id) ? values.length : -1;
    if (posOffset >= 0) push(id, entity.position[0], entity.position[1]);
    blocks.set(id, { id, kind, offset, size: GEOMETRY_SIZE[kind], posOffset, position: entity.position });
  }
  return { blocks, x0: Float64Array.from(values), owner };
}

/** Size of an entity in the initial sketch: line length or radius (0 for bare positions). Scales tolerances and difference steps. */
export function featureSize(layout: Layout, id: string): number {
  const block = layout.blocks.get(id);
  if (!block || block.kind === 'point') return 0;
  const o = block.offset;
  if (block.kind === 'line') return Math.hypot(at(layout.x0, o + 2) - at(layout.x0, o), at(layout.x0, o + 3) - at(layout.x0, o + 1));
  return Math.abs(at(layout.x0, o + 2));
}

export function positionOf(block: Block, x: Float64Array): Pt {
  return block.posOffset >= 0 ? [at(x, block.posOffset), at(x, block.posOffset + 1)] : [block.position[0], block.position[1]];
}

/** World point a reference resolves to under the variable vector `x`; null when the entity has no block. */
export function pointOf(layout: Layout, x: Float64Array, ref: EntityRef): Pt | null {
  const block = layout.blocks.get(ref.entityId);
  if (!block) return null;
  const [px, py] = positionOf(block, x);
  const o = block.offset;
  switch (slotOf(block.kind, subKindOf(ref))) {
    case 'start':
      return block.kind === 'line'
        ? [at(x, o) + px, at(x, o + 1) + py]
        : [at(x, o) + px + at(x, o + 2) * Math.cos(at(x, o + 3)), at(x, o + 1) + py + at(x, o + 2) * Math.sin(at(x, o + 3))];
    case 'end':
      return block.kind === 'line'
        ? [at(x, o + 2) + px, at(x, o + 3) + py]
        : [at(x, o) + px + at(x, o + 2) * Math.cos(at(x, o + 4)), at(x, o + 1) + py + at(x, o + 2) * Math.sin(at(x, o + 4))];
    case 'mid': {
      if (block.kind === 'line') return [(at(x, o) + at(x, o + 2)) / 2 + px, (at(x, o + 1) + at(x, o + 3)) / 2 + py];
      const angle = (at(x, o + 3) + at(x, o + 4)) / 2;
      return [at(x, o) + px + at(x, o + 2) * Math.cos(angle), at(x, o + 1) + py + at(x, o + 2) * Math.sin(angle)];
    }
    case 'center':
      return [at(x, o) + px, at(x, o + 1) + py];
    case 'position':
      return [px, py];
  }
}

/** Line endpoints in world space; null when the entity is not a line. */
export function lineOf(layout: Layout, x: Float64Array, id: string): { start: Pt; end: Pt } | null {
  const block = layout.blocks.get(id);
  if (block?.kind !== 'line') return null;
  const [px, py] = positionOf(block, x);
  const o = block.offset;
  return { start: [at(x, o) + px, at(x, o + 1) + py], end: [at(x, o + 2) + px, at(x, o + 3) + py] };
}

/** Center and radius of a circle or arc; null for other kinds. */
export function circleOf(layout: Layout, x: Float64Array, id: string): { center: Pt; radius: number } | null {
  const block = layout.blocks.get(id);
  if (block?.kind !== 'circle' && block?.kind !== 'arc') return null;
  const [px, py] = positionOf(block, x);
  return { center: [at(x, block.offset) + px, at(x, block.offset + 1) + py], radius: Math.abs(at(x, block.offset + 2)) };
}

/** Unit direction start→end; `[1, 0]` for a degenerate line. */
export function directionOf(line: { start: Pt; end: Pt }): Pt {
  const dx = line.end[0] - line.start[0];
  const dy = line.end[1] - line.start[1];
  const length = Math.hypot(dx, dy);
  return length < 1e-12 ? [1, 0] : [dx / length, dy / length];
}

/** The document with every changed block written back; untouched entities keep their identity. */
export function applyLayout(doc: CadDocument, layout: Layout, solution: Float64Array): CadDocument {
  // Round-off sized moves are not moves: variables within 1e-10 (relative) of where they started stay exactly there.
  const x = solution.map((value, index) =>
    Math.abs(value - at(layout.x0, index)) < 1e-10 * (1 + Math.abs(value)) ? at(layout.x0, index) : value,
  );
  const entities: CadDocument['entities'] = { ...doc.entities };
  let changed = false;
  for (const block of layout.blocks.values()) {
    const entity = doc.entities[block.id];
    if (!entity) continue;
    const o = block.offset;
    const g = (k: number): number => at(x, o + k);
    const indices = [
      ...Array.from({ length: block.size }, (_, k) => o + k),
      ...(block.posOffset >= 0 ? [block.posOffset, block.posOffset + 1] : []),
    ];
    if (indices.every((index) => at(layout.x0, index) === at(x, index))) continue;
    const position: Vec3 =
      block.posOffset >= 0 ? [at(x, block.posOffset), at(x, block.posOffset + 1), entity.position[2]] : entity.position;
    if (entity.kind === 'line') entities[block.id] = { ...entity, start: [g(0), g(1)], end: [g(2), g(3)], position };
    else if (entity.kind === 'circle') entities[block.id] = { ...entity, center: [g(0), g(1)], radius: Math.abs(g(2)), position };
    else if (entity.kind === 'arc')
      entities[block.id] = { ...entity, center: [g(0), g(1)], radius: Math.abs(g(2)), startAngle: g(3), endAngle: g(4), position };
    else entities[block.id] = { ...entity, position };
    changed = true;
  }
  return changed ? { ...doc, entities } : doc;
}
