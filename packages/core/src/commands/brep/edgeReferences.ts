/**
 * Edge picking for fillet_edge / chamfer_edge with persistent names (SC-N1, SC-N2). Names recorded by an earlier run win over indices
 * and points; a name that no longer resolves to exactly one edge refuses the step with REF_LOST / REF_SPLIT and the way to re-pick it,
 * instead of silently rounding another edge. A first pick by index or point records the names of the edges it chose, so a later
 * regeneration follows those edges by name. A kernel without history keeps the positional pick, flagged unverified.
 */

import type { Vec3 } from '../../model/types';
import type { ShapeTopology } from '../../geometry/kernel';
import { hasNames, namesOf, referenceProblem, resolveNames } from '../../geometry/naming/references';
import type { CommandError } from '../types';
import { commandError } from '../noop';
import { selectEdges } from './edgeSelection';

export interface EdgeRequest {
  readonly indices: readonly number[];
  readonly near: readonly Vec3[];
  /** Persistent names recorded by an earlier run (`edgeNames`). */
  readonly names?: readonly string[] | undefined;
}

export type EdgePick =
  | {
      readonly edges: number[];
      /** Names to record for replay; null when the kernel names nothing, names were given, or the pick means "all edges". */
      readonly record: string[] | null;
      /** Appended to the summary (unverified positional pick). */
      readonly note: string;
    }
  | { readonly problem: string; readonly error?: CommandError };

export const REPICK_EDGES =
  'Re-pick: edit_step_params on this step with new edgeNames (inspect_topology lists the current edge names), or remove edgeNames to ' +
  'select by edgeIndices / edgesNear again.';

/** The edges `request` names on `topology` (see the module doc). */
export function pickEdges(topology: ShapeTopology | null, request: EdgeRequest): EdgePick {
  const names = request.names ?? [];
  if (names.length > 0 && hasNames(topology, 'edge')) {
    const resolved = resolveNames(topology, 'edge', names);
    if (resolved.ok) return { edges: resolved.indices, record: null, note: '' };
    const code = resolved.lost.length > 0 ? 'REF_LOST' : 'REF_SPLIT';
    return {
      problem: `${referenceProblem('edge', resolved)}. ${REPICK_EDGES}`,
      error: commandError(code, REPICK_EDGES, [], ['edgeNames']),
    };
  }
  const selection = selectEdges(topology, request.indices, request.near);
  if ('problem' in selection) return { problem: selection.problem };
  if (names.length > 0)
    return {
      edges: selection.edges,
      record: null,
      note: ' Edge names not checked: this kernel keeps no history, edges re-picked by index / position (unverified).',
    };
  const record = selection.edges.length > 0 ? namesOf(topology, 'edge', selection.edges) : null;
  return { edges: selection.edges, record, note: '' };
}
