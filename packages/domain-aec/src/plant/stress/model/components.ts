/**
 * Components of the pipes of a stress model (07 PST M5a): the valves and reducers an 02 RTE run places inline, and the fitting of every branch run
 * (tee, olet, stub-in), read from the derivation on every analysis. Building pipes carry no components: the model declares them (`StressComponent`).
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { isFailure } from '../../piping/deriveTypes';
import { getPiping } from '../../piping/model';
import { deriveRun } from '../../piping/routeParts';
import type { Section } from './sections';

export interface SourceComponent {
  /** The RTE inline component id, or the id of the declared component. */
  readonly key: string;
  readonly pipeId: string;
  readonly kind: 'valve' | 'reducer' | 'flange' | 'rigid';
  readonly tag?: string;
  /** Upstream and downstream end faces, absolute mm. */
  readonly faces: readonly [Vec3, Vec3];
  readonly lengthMm: number;
  /** Reducers: the section of the pipe downstream of the component. */
  readonly downstream?: Section;
}

export interface SourceBranch {
  readonly branchPipeId: string;
  readonly headerPipeId: string;
  readonly kind: 'tee' | 'olet' | 'stubIn';
}

/** The valves, reducers and branch fittings of the run `runId` (none when it does not derive). */
export function runComponents(doc: CadDocument, runId: string): { components: SourceComponent[]; branches: SourceBranch[] } {
  const piping = getPiping(doc);
  const run = Object.hasOwn(piping.runs, runId) ? piping.runs[runId] : undefined;
  const derivation = run === undefined ? null : deriveRun(doc, run);
  if (derivation === null || isFailure(derivation)) return { components: [], branches: [] };
  const components: SourceComponent[] = [];
  for (const inline of derivation.inline) {
    const isReducer = inline.type.startsWith('reducer');
    if (!isReducer && !inline.type.startsWith('valve')) continue;
    let downstream: Section | undefined;
    if (isReducer) {
      const at = derivation.parts.findIndex((part) => part.componentId === inline.id && part.kind === 'reducer');
      const next = derivation.parts.slice(at + 1).find((part) => part.kind === 'pipe');
      const outside = next?.dims['outsideDiameter'];
      const wall = next?.dims['wall'];
      if (outside !== undefined && wall !== undefined) downstream = { odMm: outside, wallMm: wall };
    }
    components.push({
      key: inline.id,
      pipeId: runId,
      kind: isReducer ? 'reducer' : 'valve',
      ...(inline.tag === undefined ? {} : { tag: inline.tag }),
      faces: inline.faces,
      lengthMm: inline.lengthMm,
      ...(downstream === undefined ? {} : { downstream }),
    });
  }
  const branches = derivation.branches.map(
    (branch): SourceBranch => ({ branchPipeId: branch.branchRunId, headerPipeId: runId, kind: branch.kind }),
  );
  return { components, branches };
}
