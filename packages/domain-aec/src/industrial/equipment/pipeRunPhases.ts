/** Phases of add_pipe_run: spec binding, diameter resolution, element, summary label and data. */

import type { PipeElement } from '@aec/building/types';
import type { CommandResult } from '@core/commands/types';
import { fromMm, toMm } from '@core/model/units';
import type { CadDocument, Vec3 } from '@core/model/types';
import { noop } from '@core/commands/noop';
import { nextElementId, nextMark, type resolveLevel } from '../../building/model';
import { PIPE_OUTSIDE_DIAMETER_MM, outsideDiameterMm } from '../piping/pipeSizes';
import { hasRepeatedPoint } from '../piping/routeSupport';
import { refuse } from '../../plant/catalog/codes';
import { bindPipe, isBound, type Bound } from '../../plant/spec/binding';

export const isRefusal = (value: object): value is CommandResult => 'document' in value;

/** The spec binding of the pipe (undefined without `spec`), or the refusal of the bind / of a `diameter` that contradicts the spec OD. */
export function bindSpec(
  doc: CadDocument,
  request: {
    readonly spec: string | undefined;
    readonly revision: number | undefined;
    readonly nps: string | number | undefined;
    readonly dn: number | undefined;
    readonly diameter: number | undefined;
  },
): Bound | undefined | CommandResult {
  const { spec, revision, nps, dn, diameter } = request;
  if (spec === undefined) return undefined;
  if (nps !== undefined && dn !== undefined) return noop(doc, 'add_pipe_run failed: give nps or dn with spec, not both.');
  const outcome = bindPipe(doc, 'add_pipe_run', { specId: spec, revision, nps, dn });
  if (!isBound(outcome)) return outcome;
  if (diameter !== undefined && Math.abs(diameter - fromMm(doc, outcome.binding.odMm)) > fromMm(doc, 0.05))
    return refuse(
      doc,
      'add_pipe_run',
      'PSC_PIPE_SPEC_MISMATCH',
      `diameter ${diameter} differs from the outside diameter ${outcome.binding.odMm} mm of spec ${spec} at NPS ${outcome.binding.nps}: omit diameter`,
      [spec],
      ['diameter'],
    );
  return outcome;
}

/** The outside diameter (document units) and DN of the pipe, or the refusal of an untabulated DN / a degenerate route. */
export function resolveDiameter(
  doc: CadDocument,
  bound: Bound | undefined,
  diameter: number | undefined,
  dn: number | undefined,
  path: ReadonlyArray<Vec3>,
): { readonly diameter: number; readonly dn: number | null } | CommandResult {
  const tabulated = bound === undefined && dn !== undefined ? outsideDiameterMm(dn) : null;
  if (bound === undefined && diameter === undefined && dn !== undefined && tabulated === null) {
    const known = Object.keys(PIPE_OUTSIDE_DIAMETER_MM).join(', ');
    return noop(doc, `add_pipe_run failed: DN${dn} is not in the pipe size table (${known}); give an explicit diameter.`);
  }
  const resolvedDiameter = bound !== undefined ? fromMm(doc, bound.binding.odMm) : (diameter ?? fromMm(doc, tabulated ?? 114.3));
  const pipeDn = bound !== undefined ? bound.dn : (dn ?? null);
  if (hasRepeatedPoint(path) || resolvedDiameter <= 0)
    return noop(doc, 'add_pipe_run failed: consecutive points must differ and diameter be > 0.');
  return { diameter: resolvedDiameter, dn: pipeDn };
}

export interface PipeFacts {
  readonly path: Vec3[];
  readonly diameter: number;
  readonly dn: number | null;
  readonly bound: Bound | undefined;
  readonly lineNumber: string | undefined;
  readonly origin: string | undefined;
  readonly destination: string | undefined;
  readonly service: string | undefined;
  readonly material: string | undefined;
  readonly asBuilt: PipeElement['asBuilt'];
}

type Resolved = Extract<ReturnType<typeof resolveLevel>, { ok: true }>;

/** The new pipe element on the resolved level. */
export function pipeElementOf(resolution: Resolved, facts: PipeFacts): PipeElement {
  const { path, diameter, dn, bound, lineNumber, origin, destination, service, material, asBuilt } = facts;
  return {
    id: nextElementId(resolution.building, 'pipe'),
    category: 'pipe',
    mark: nextMark(resolution.building, 'pipe'),
    entityIds: [],
    levelId: resolution.level.id,
    points: path,
    diameter,
    service: service?.trim() || 'process',
    material: material?.trim() || 'steel',
    ...(lineNumber !== undefined ? { line: lineNumber } : {}),
    ...(dn !== null ? { dn } : {}),
    ...(bound !== undefined ? { spec: bound.binding } : {}),
    ...(origin !== undefined ? { from: origin } : {}),
    ...(destination !== undefined ? { to: destination } : {}),
    ...(asBuilt !== undefined ? { asBuilt } : {}),
  };
}

/** The line / DN / spec fragment of the summary. */
export function pipeLabel(lineNumber: string | undefined, dn: number | null, bound: Bound | undefined): string {
  return `${lineNumber !== undefined ? ` line ${lineNumber}` : ''}${dn !== null ? ` DN${dn}` : ''}${bound === undefined ? '' : ` spec ${bound.binding.specId} r${bound.binding.revision} NPS ${bound.binding.nps} sch ${bound.binding.schedule ?? '-'} wall ${bound.binding.wallMm} mm${bound.warnings.length === 0 ? '' : ` (${bound.warnings.map((entry) => entry.code).join(', ')})`}`}`;
}

/** The result data of a created pipe. */
export function pipeData(doc: CadDocument, pipe: PipeElement, bound: Bound | undefined): Record<string, unknown> {
  return {
    elementId: pipe.id,
    outsideDiameterMm: bound?.binding.odMm ?? toMm(doc, pipe.diameter),
    ...(bound === undefined
      ? {}
      : {
          specId: bound.binding.specId,
          revision: bound.binding.revision,
          nps: bound.binding.nps,
          wallMm: bound.binding.wallMm,
          ...(bound.binding.schedule === undefined ? {} : { schedule: bound.binding.schedule }),
          verified: bound.binding.verified,
          ...(bound.warnings.length === 0 ? {} : { warnings: bound.warnings }),
        }),
  };
}
