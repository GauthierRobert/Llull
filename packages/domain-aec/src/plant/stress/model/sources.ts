/**
 * What a stress model reads from the document: the centrelines (building pipes and 02 RTE runs) in absolute millimetres with their section,
 * and the pipe supports. Read on every analysis, so routing edits are never out of sync (07 PST FR-20).
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { elementsOf, getBuilding } from '../../../building/model';
import { getPiping } from '../../piping/model';
import { pipeCentreline, type SourcePipe } from '../../common/pipeCentrelines';
import { runComponents, type SourceBranch, type SourceComponent } from './components';
import type { StressModel } from './schema';

export type { SourcePipe };

export interface SourceSupport {
  readonly id: string;
  readonly pipeId: string;
  readonly type: 'shoe' | 'hanger' | 'guide' | 'anchor';
  readonly point: Vec3;
}

export interface Sources {
  readonly pipes: readonly SourcePipe[];
  readonly supports: readonly SourceSupport[];
  /** Valves and reducers of 02 RTE runs, and the fittings of branch runs (building pipes have none: the model declares them). */
  readonly components: readonly SourceComponent[];
  readonly branches: readonly SourceBranch[];
  /** Referenced ids that no longer exist or no longer derive: [id, reason]. */
  readonly missing: readonly (readonly [string, string])[];
}

/** The pipes of the model scope and every support that rests on them, in scope order. */
export function resolveSources(doc: CadDocument, model: Pick<StressModel, 'scope'>): Sources {
  const pipes: SourcePipe[] = [];
  const missing: [string, string][] = [];
  const components: SourceComponent[] = [];
  const branches: SourceBranch[] = [];
  for (const id of model.scope.ids) {
    const found = pipeCentreline(doc, model.scope.kind, id);
    if (typeof found === 'string') missing.push([id, found]);
    else {
      pipes.push(found);
      if (found.kind === 'run') {
        const own = runComponents(doc, id);
        components.push(...own.components);
        branches.push(...own.branches);
      }
    }
  }
  const building = getBuilding(doc);
  const wanted = new Set(pipes.map((pipe) => pipe.id));
  const supports = elementsOf(building, 'pipeSupport')
    .filter((support) => wanted.has(support.pipeId))
    .map(
      (support): SourceSupport => ({
        id: support.id,
        pipeId: support.pipeId,
        type: support.type,
        point: [support.position[0], support.position[1], support.position[2] + (building.levels[support.levelId]?.elevation ?? 0)],
      }),
    );
  return { pipes, supports, components, branches, missing };
}

/** Pipe ids a `lineId` resolves to (its runs, in run order). */
export const runsOfLine = (doc: CadDocument, lineId: string): string[] =>
  getPiping(doc).runOrder.filter((id) => getPiping(doc).runs[id]?.lineId === lineId);
