/** The time-history requests of an explicit case as job data (`timeHistories` of job.json, solver crates/llull-explicit/src/history.rs) and their units. */

import type { ExplicitSpec } from '@core/model/explicit';
import { locate } from './constraints';
import type { ExplicitMesh } from './mesh';

export interface JobTimeHistory {
  /** Id `th-<step>.<k>` of the request. */
  readonly id: string;
  readonly name: string;
  readonly kind: 'node' | 'part' | 'rigid_wall';
  /** kind node: mesh node indices. */
  readonly nodes?: readonly number[];
  /** kind part: index in the sorted part ids (the `elementPart` value). */
  readonly part?: number;
  /** kind rigid_wall: index into the job walls. */
  readonly wall?: number;
  readonly quantities: readonly string[];
  /** Seconds; absent = the controls' history interval. */
  readonly interval?: number;
}

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

/** Unit of one recorded quantity in the case unit system (`length` is the case length unit, `energy` its energy unit). */
export function historyUnit(quantity: string, units: { readonly length: string; readonly energy: string }): string {
  const mass = units.length === 'mm' ? 't' : 'kg';
  switch (quantity) {
    case 'displacement':
      return units.length;
    case 'velocity':
      return `${units.length}/s`;
    case 'acceleration':
      return `${units.length}/s^2`;
    case 'mass':
      return mass;
    case 'momentum':
    case 'normal_impulse':
      return 'N*s';
    case 'normal_force':
      return 'N';
    default:
      return units.energy;
  }
}

/**
 * The requests resolved to mesh nodes, part and wall indices, in request order.
 * @failure a node target that does not resolve, or a part meshed as shells (no solid element to record) -> EXP_TIME_HISTORY_INVALID
 */
export function jobTimeHistories(
  spec: ExplicitSpec,
  mesh: ExplicitMesh,
  partIds: readonly string[],
  toCase: number,
): readonly JobTimeHistory[] | Refusal {
  const resolved: JobTimeHistory[] = [];
  for (const id of spec.timeHistoryOrder ?? []) {
    const history = spec.timeHistories?.[id];
    if (history === undefined) continue;
    const refuse = (message: string): Refusal => ({
      code: 'EXP_TIME_HISTORY_INVALID',
      message: `time history '${history.name}': ${message}`,
      ids: [id],
    });
    const base = {
      id,
      name: history.name,
      kind: history.kind,
      quantities: history.quantities,
      ...(history.intervalS !== undefined ? { interval: history.intervalS } : {}),
    };
    if (history.kind === 'rigid_wall') {
      const wall = spec.rigidWallOrder.indexOf(history.wallId ?? '');
      if (wall < 0) return refuse(`rigid wall '${history.wallId}' is not in the case`);
      resolved.push({ ...base, wall });
    } else if (history.kind === 'part') {
      const entityId = history.target?.entityId ?? '';
      if (Object.hasOwn(spec.shells ?? {}, entityId))
        return refuse(`part '${entityId}' is meshed as shells: only solid parts record energies, momentum and mass`);
      const part = partIds.indexOf(entityId);
      if (part < 0) return refuse(`'${entityId}' is no longer a part of the case`);
      resolved.push({ ...base, part });
    } else {
      if (history.target === undefined) return refuse('no target');
      const located = locate(mesh, history.target, toCase);
      if (typeof located === 'string') return refuse(located);
      if (located.nodes.length === 0) return refuse('the target selects no node');
      resolved.push({ ...base, nodes: located.nodes });
    }
  }
  return resolved;
}
