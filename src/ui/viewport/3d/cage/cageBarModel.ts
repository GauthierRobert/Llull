// Display model of the cage edit bar: counts, readouts and hints derived from the stores. Pure.

import type { SubdivisionEntity } from '@core/model/types';
import { type CageSelection, edgeSharpnessOf, selectionCount } from './cageSelection';
import type { CageTool } from './cageKeys';

/** "3 vertices, 1 face" style summary; "Nothing selected" when empty. */
export function selectionText(selection: CageSelection): string {
  const part = (n: number, one: string, many: string): string[] => (n === 0 ? [] : [`${n} ${n === 1 ? one : many}`]);
  const parts = [
    ...part(selection.vertices.length, 'vertex', 'vertices'),
    ...part(selection.edges.length, 'edge', 'edges'),
    ...part(selection.faces.length, 'face', 'faces'),
  ];
  return parts.length === 0 ? 'Nothing selected' : parts.join(', ');
}

/** Crease readout for a single selected edge ("smooth", "sharpness 2", "infinitely sharp"), else null. */
export function sharpnessText(entity: SubdivisionEntity, selection: CageSelection): string | null {
  if (selectionCount(selection) !== 1 || selection.edges.length !== 1) return null;
  const s = edgeSharpnessOf(entity, selection.edges[0] as string);
  return s === 0 ? 'Edge: smooth' : s === Infinity ? 'Edge: infinitely sharp' : `Edge: sharpness ${s}`;
}

/** One-line hint for what the pointer does now. */
export function hintFor(tool: CageTool, selection: CageSelection, cuts: number): string {
  if (tool === 'loop_cut') return `Click an edge to cut ${cuts} loop${cuts === 1 ? '' : 's'} (arrows: count, Esc: done)`;
  if (selectionCount(selection) === 0) return 'Click an element to pick it. Shift adds. Drag to move.';
  return selection.faces.length > 0
    ? 'Drag to move, Alt-drag a face to extrude, I to inset.'
    : 'Drag to move; the gizmo rotates and scales.';
}
