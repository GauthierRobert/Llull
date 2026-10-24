/**
 * `check_piping` rules (02 RTE §5.8, §7): the issues a designer would raise about the routed runs of some lines. Everything is read from the
 * derivation of each run and the connectivity graph; nothing is stored and a run that no longer derives is an error issue, not a refusal.
 * @invariant severity: error = the model is wrong (a run does not derive, a connection disagrees, a line number is used twice); warning = a human
 *   should look; info = a fact. Status: fail with any error, else warn with any warning, else pass. No limit is built in: the handwheel height
 *   and the weld spacing are parameters or named defaults and every result names the one it used.
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { add3, scale3 } from '@lib/vec3';
import { getBuilding } from '../../building/model';
import type { RunDerivation } from './deriveTypes';
import { buildGraph, externalPorts, selectRuns, type RunGraph } from './graph';
import { defaultMinWeldSpacing } from './jointStack';
import { getPiping } from './model';
import { slopeFindings } from './slopeChecks';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  readonly code: string;
  readonly severity: Severity;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly remediation: string;
}

export interface CheckOptions {
  readonly lineIds?: readonly string[] | undefined;
  /** Highest allowed handwheel centre above its reference level, mm; absent = the check is skipped (no code value exists, S24). */
  readonly maxHandwheelCentreHeight?: number | undefined;
  /** Minimum length of a pipe piece between welds, mm; absent = max(4 t, 50 mm) of the piece wall (named default). */
  readonly minWeldSpacing?: number | undefined;
  /** Only report these codes. */
  readonly include?: readonly string[] | undefined;
}

export interface CheckResult {
  readonly status: 'pass' | 'warn' | 'fail';
  readonly issues: readonly Issue[];
  readonly counts: {
    readonly errors: number;
    readonly warnings: number;
    readonly infos: number;
    readonly byCode: Readonly<Record<string, number>>;
  };
  readonly unverified: boolean;
  readonly reviewRequired: boolean;
  readonly lineIds: readonly string[];
  readonly runIds: readonly string[];
  readonly partCount: number;
  readonly limits: {
    readonly handwheelCentreHeight: { readonly valueMm: number | null; readonly source: string };
    readonly weldSpacing: { readonly valueMm: number | null; readonly source: string; readonly defaulted: boolean };
  };
}

const REMEDIATION: Readonly<Record<string, string>> = {
  RTE_OPEN_END: 'Route to a port, add a cap / blind or a tie-in, or accept the open end.',
  RTE_DISCONNECTED_PORT: 'Route it (route_pipe) or leave it as a spare.',
  RTE_FITTING_TO_FITTING: 'Accept the zero-length piece or lengthen the leg.',
  RTE_WELD_SPACING: 'Lengthen the leg or accept per the project weld-spacing rule (minWeldSpacing).',
  RTE_FROM_TO_MISMATCH: 'Update the line from / to text or the route so both name the equipment the line reaches.',
  RTE_VALVE_OPERATOR_HEIGHT:
    'Rotate the stem (move_inline_component / re-insert), move the valve, add a platform (06 STA) or a chain wheel.',
  RTE_STUB_IN_REVIEW: 'Have the stub-in reinforcement checked (ASME B31.3 304.3, 07 pipe stress) or use an olet / tee in the branch table.',
  RTE_ADVERSE_SLOPE:
    'Re-route the leg so it falls along the flow (edit_route move_pi / stretch_leg), or correct the declared slope of the line or leg.',
  RTE_FLAT_ON_SLOPED_LINE: 'Give the leg its fall (route_pipe planLength + slope, edit_route), or accept a flat stretch on the line.',
  RTE_POCKET:
    'Add a drain at a low point or a vent at a high point (add_branch downward / upward on an adjacent leg), or re-route the profile to fall continuously.',
  RTE_SPEC_UNVERIFIED: 'A reviewer approves the spec (01 PSC) and the catalogue rows are verified to grade A.',
  RTE_DUPLICATE_LINE_NUMBER: 'Give the lines different sequence numbers.',
  RTE_SIZE_MISMATCH: 'Add a reducer, or fix the nozzle / tie-in size.',
  RTE_RATING_MISMATCH: 'Use a spec whose flange rating equals the port rating, or fix the nozzle / tie-in rating.',
  RTE_FACING_MISMATCH: 'Use a spec whose flange facing equals the port facing, or fix the nozzle / tie-in facing.',
  RTE_END_TYPE_MISMATCH: 'Join ends of the same type (BW-BW, FL-FL) or add the connection rule to the spec.',
};

const remediationOf = (code: string): string =>
  REMEDIATION[code] ?? 'Re-route the run (route_pipe / edit_route) or fix the spec; delete_pipe_run clears it.';

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

interface Collector {
  readonly issues: Issue[];
  add(
    code: string,
    severity: Severity,
    ids: readonly string[],
    message: string,
    detail?: Readonly<Record<string, unknown>>,
    paths?: readonly string[],
  ): void;
}

function collector(): Collector {
  const issues: Issue[] = [];
  return {
    issues,
    add: (code, severity, ids, message, detail = {}, paths = []) =>
      issues.push({ code, severity, ids, paths, message, detail, remediation: remediationOf(code) }),
  };
}

/** The reference level of a point: the highest building level at or below it, else the datum z = 0. */
function referenceLevel(doc: CadDocument, z: number): { id: string | null; elevationMm: number } {
  const below = Object.values(getBuilding(doc).levels)
    .filter((level) => level.elevation <= z + 1e-6)
    .sort((a, b) => b.elevation - a.elevation)[0];
  return below === undefined ? { id: null, elevationMm: 0 } : { id: below.id, elevationMm: below.elevation };
}

function weldSpacingIssues(out: Collector, run: PipeRun, derivation: RunDerivation, override: number | undefined): void {
  for (const part of derivation.parts) {
    const cut = part.cutLength;
    if (part.kind !== 'pipe' || cut === undefined || !(cut > 1e-6 * Math.max(1, cut))) continue;
    const wall = part.dims['wall'] ?? 0;
    const minimum = override ?? defaultMinWeldSpacing(wall);
    if (cut >= minimum) continue;
    out.add(
      'RTE_WELD_SPACING',
      'warning',
      [part.id, run.id],
      `pipe piece ${part.id} is ${round(cut)} mm, shorter than the weld spacing ${minimum} mm`,
      {
        cutLengthMm: round(cut),
        minWeldSpacingMm: minimum,
        source: override === undefined ? 'project default (BS 2633 4t / common 50 mm), defaulted: true' : 'check_piping minWeldSpacing',
        wallMm: wall,
      },
      [`runs.${run.id}.legs.${part.leg ?? 0}`],
    );
  }
}

function runIssues(out: Collector, doc: CadDocument, run: PipeRun, derivation: RunDerivation, options: CheckOptions): void {
  weldSpacingIssues(out, run, derivation, options.minWeldSpacing);
  for (const finding of slopeFindings(getPiping(doc), run))
    out.add(finding.code, 'warning', finding.ids, finding.message, finding.detail, finding.paths);
  for (const warning of derivation.warnings)
    if (warning.code === 'RTE_FITTING_TO_FITTING')
      out.add(warning.code, 'warning', [...warning.ids, run.id], warning.message, warning.detail, [
        `runs.${run.id}.legs.${String(warning.detail['leg'])}`,
      ]);
  for (const branch of derivation.branches)
    if (branch.reviewRequired)
      out.add(
        'RTE_STUB_IN_REVIEW',
        'warning',
        [branch.id, branch.partId, run.id],
        `branch ${branch.id} is a stub-in (branch-table cell ${branch.fittingCode}) DN${branch.headerDn} x DN${branch.branchDn}: the reinforcement needs a review`,
        { reviewRequired: true, headerDn: branch.headerDn, branchDn: branch.branchDn },
        [`runs.${run.id}.branches`],
      );
  const limit = options.maxHandwheelCentreHeight;
  if (limit === undefined) return;
  for (const placed of derivation.inline) {
    if (placed.stemDirection === undefined) continue;
    const stemHeight = placed.stemHeightMm ?? 0;
    const wheel: Vec3 = add3(placed.centre, scale3(placed.stemDirection, stemHeight));
    const level = referenceLevel(doc, wheel[2]);
    const height = wheel[2] - level.elevationMm;
    if (height <= limit) continue;
    out.add(
      'RTE_VALVE_OPERATOR_HEIGHT',
      'warning',
      [placed.id],
      `handwheel of ${placed.type} ${placed.id}${placed.tag === undefined ? '' : ` "${placed.tag}"`} is ${round(height)} mm above ${level.id ?? 'the datum z = 0'}, over the limit ${limit} mm`,
      {
        handwheelCentre: wheel.map(round),
        heightMm: round(height),
        limitMm: limit,
        referenceLevel: level,
        stemHeightMm: stemHeight,
        stemHeightFromCatalogue: placed.stemHeightMm !== null,
      },
      [`runs.${run.id}.inline`],
    );
  }
}

/** Tags and port ids the components of the graph that contain a line's parts reach. */
function reachedBy(graph: RunGraph, lineId: string): Set<string> {
  const lineParts = new Set([...graph.parts.values()].filter((entry) => entry.lineId === lineId).map((entry) => entry.part.id));
  const reached = new Set<string>();
  for (const component of graph.components) {
    if (!component.some((id) => lineParts.has(id))) continue;
    for (const id of component) {
      const external = graph.externals.get(id);
      if (external !== undefined) [external.id, external.tag].forEach((name) => reached.add(name.trim().toLowerCase()));
    }
  }
  return reached;
}

function lineIssues(
  out: Collector,
  piping: PipingModel,
  lineIds: readonly string[],
  graph: RunGraph,
  derived: ReadonlyMap<string, RunDerivation>,
): void {
  const reportedNumbers = new Set<string>();
  for (const lineId of lineIds) {
    const line = piping.lines[lineId];
    if (line === undefined) continue;
    const twins = piping.lineOrder.filter((id) => piping.lines[id]?.lineNumber === line.lineNumber);
    if (twins.length > 1 && !reportedNumbers.has(line.lineNumber)) {
      reportedNumbers.add(line.lineNumber);
      out.add('RTE_DUPLICATE_LINE_NUMBER', 'error', twins, `line number ${line.lineNumber} is used by ${twins.join(', ')}`, {
        lineNumber: line.lineNumber,
      });
    }
    const runs = piping.runOrder.filter((id) => piping.runs[id]?.lineId === lineId && derived.has(id));
    if (runs.length === 0) continue;
    const reasons = [...new Set(runs.flatMap((id) => (derived.get(id) as RunDerivation).unverifiedReasons))];
    if (reasons.length > 0)
      out.add('RTE_SPEC_UNVERIFIED', 'warning', [lineId], `line ${line.lineNumber} rests on unverified data: ${reasons.join('; ')}`, {
        reasons,
        spec: line.spec,
      });
    const reached = reachedBy(graph, lineId);
    for (const field of ['from', 'to'] as const) {
      const text = line[field];
      if (text === undefined || text.trim() === '' || reached.has(text.trim().toLowerCase())) continue;
      out.add(
        'RTE_FROM_TO_MISMATCH',
        'warning',
        [lineId],
        `line ${line.lineNumber} says ${field} "${text}" but its runs reach ${reached.size === 0 ? 'no equipment or tie-in' : [...reached].join(', ')}`,
        { field, text, reached: [...reached] },
        [`lines.${lineId}.${field}`],
      );
    }
  }
}

/**
 * Checks the runs of `options.lineIds` (all lines when absent) and the runs attached to them.
 * @invariant a run that does not derive gives one error issue with its code; the rest of the model is still checked
 */
export function checkPipingModel(doc: CadDocument, options: CheckOptions = {}): CheckResult {
  const piping = getPiping(doc);
  const lineIds = options.lineIds ?? piping.lineOrder;
  const { runIds, graphRuns, broken } = selectRuns(doc, options.lineIds);
  const out = collector();
  for (const { runId, failure } of broken)
    out.add(failure.code, 'error', [runId, ...failure.ids], `run ${runId} does not derive: ${failure.message}`, failure.detail ?? {}, [
      `runs.${runId}`,
      ...failure.paths,
    ]);
  const derived = new Map<string, RunDerivation>();
  for (const { runId, derivation } of graphRuns) {
    derived.set(runId, derivation);
    runIssues(out, doc, piping.runs[runId] as PipeRun, derivation, options);
  }
  const graph = buildGraph(doc, graphRuns);
  for (const open of graph.openEnds)
    out.add(
      'RTE_OPEN_END',
      'warning',
      [open.partId, open.runId],
      `${open.partId} port ${open.portIndex} (DN${open.dn} ${open.endType}) at [${open.position.map(round).join(', ')}] connects to nothing`,
      { position: open.position, direction: open.direction, dn: open.dn, endType: open.endType, portIndex: open.portIndex },
      [`runs.${open.runId}`],
    );
  for (const mismatch of graph.mismatches)
    out.add(
      mismatch.code,
      'error',
      [mismatch.a, mismatch.b],
      `${mismatch.a} and ${mismatch.b} are joined but disagree (${mismatch.code})`,
      { ...mismatch.detail, position: mismatch.position },
    );
  if (options.lineIds === undefined)
    for (const port of externalPorts(doc))
      if (!graph.attached.has(port.id))
        out.add('RTE_DISCONNECTED_PORT', 'info', [port.id], `port ${port.id} (DN${port.spec.dn} ${port.spec.endType}) has no run`, {
          tag: port.tag,
        });
  lineIssues(out, piping, lineIds, graph, derived);
  const issues = options.include === undefined ? out.issues : out.issues.filter((issue) => options.include?.includes(issue.code));
  const byCode: Record<string, number> = {};
  for (const issue of issues) byCode[issue.code] = (byCode[issue.code] ?? 0) + 1;
  const [errors, warnings, infos] = (['error', 'warning', 'info'] as const).map(
    (severity) => issues.filter((issue) => issue.severity === severity).length,
  ) as [number, number, number];
  const weldOverride = options.minWeldSpacing;
  return {
    status: errors > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass',
    issues,
    counts: { errors, warnings, infos, byCode },
    unverified: [...derived.values()].some((derivation) => derivation.unverified),
    reviewRequired: issues.some((issue) => issue.code === 'RTE_STUB_IN_REVIEW'),
    lineIds,
    runIds,
    partCount: graph.parts.size,
    limits: {
      handwheelCentreHeight:
        options.maxHandwheelCentreHeight === undefined
          ? {
              valueMm: null,
              source: 'not given: no built-in limit exists (no public code value); RTE_VALVE_OPERATOR_HEIGHT was not checked',
            }
          : { valueMm: options.maxHandwheelCentreHeight, source: 'check_piping maxHandwheelCentreHeight (project limit)' },
      weldSpacing:
        weldOverride === undefined
          ? { valueMm: null, source: 'max(4 t, 50 mm) of the pipe wall t (BS 2633 4t / common 50 mm project default)', defaulted: true }
          : { valueMm: weldOverride, source: 'check_piping minWeldSpacing', defaulted: false },
    },
  };
}
