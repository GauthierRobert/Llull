import {
  createEmptyDocument,
  type ArcEntity,
  type CadDocument,
  type CircleEntity,
  type EntityRef,
  type LineEntity,
} from '@core/model/types';
import { execute } from '@core/commands/registry';

export type Sketch = { doc: CadDocument };

export interface SolveData {
  residual: number;
  iterations: number;
  converged: boolean;
  dof: number;
  fullyConstrained: string[];
  isFullyConstrained: boolean;
  skipped: { id: string; reason: string }[];
}

export const emptySketch = (): Sketch => ({ doc: createEmptyDocument() });

export function addLine(sketch: Sketch, from: [number, number], to: [number, number]): string {
  const result = execute(sketch.doc, 'draw_polyline', { points: [from, to] });
  sketch.doc = result.document;
  return result.affected[0]!;
}

export function addCircle(sketch: Sketch, center: [number, number], radius: number): string {
  const result = execute(sketch.doc, 'draw_arc', { center, radius });
  sketch.doc = result.document;
  return result.affected[0]!;
}

export function addArc(sketch: Sketch, center: [number, number], radius: number, startAngle: number, endAngle: number): string {
  const result = execute(sketch.doc, 'draw_arc', { center, radius, startAngle, endAngle });
  sketch.doc = result.document;
  return result.affected[0]!;
}

export const ref = (entityId: string, kind?: 'start' | 'end' | 'center' | 'mid'): EntityRef => (kind ? { entityId, kind } : { entityId });

/** Adds a constraint; returns the constraint id, or the refusal summary as `refused`. */
export function constrain(
  sketch: Sketch,
  kind: string,
  a: EntityRef,
  b?: EntityRef,
  extra: { value?: number | string; axis?: EntityRef } = {},
): { id?: string; refused?: string } {
  const result = execute(sketch.doc, 'add_constraint', { constraint: { kind, a, ...(b ? { b } : {}), ...extra } });
  if (result.affected.length === 0) return { refused: result.summary };
  sketch.doc = result.document;
  return { id: result.affected[0]! };
}

export function solve(sketch: Sketch): SolveData {
  const result = execute(sketch.doc, 'solve_constraints', {});
  sketch.doc = result.document;
  return result.data as SolveData;
}

export const lineOf = (sketch: Sketch, id: string): LineEntity => sketch.doc.entities[id] as LineEntity;
export const circleOf = (sketch: Sketch, id: string): CircleEntity => sketch.doc.entities[id] as CircleEntity;
export const arcOf = (sketch: Sketch, id: string): ArcEntity => sketch.doc.entities[id] as ArcEntity;

export const length = (line: LineEntity): number => Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]);
