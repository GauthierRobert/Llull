/**
 * Executes a route plan with the 02 RTE commands (plant 05 ISO M5, `import_pcf as route`): tie-in ports for the flanged ends, `create_pipeline`, `route_pipe` for the
 * main run (valves and reducers inline), `add_branch` for every tee / olet branch, `insert_inline_component` for the valves of a branch, then `add_field_weld` and
 * `add_pipe_support`. Every step goes through `execute`, so the result is the document a hand-routed line would be - never entities built here. The first refusal of
 * any step stops everything: the caller returns the original document with that step's code. Pure apart from the nested commands.
 */

import { codedRejection } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { distance3, normalize3, sub3 } from '@lib/vec3';
import { directionLabel } from '../../piping/legs';
import { placeableType } from '../supports';
import type { PlannedPort, PlannedRun, RoutePlan } from './plan';

export interface ComposeInput {
  readonly plan: RoutePlan;
  readonly lineNumber: string;
  readonly spec: string;
  readonly service: string;
  /** Place the supports of the file (needs a building level). */
  readonly supports: boolean;
  readonly valveType: string;
}

export interface Composed {
  readonly composed: true;
  readonly document: CadDocument;
  /** The routed line id (affected[0] of create_pipeline). */
  readonly lineId: string;
  readonly runIds: Readonly<Record<string, string>>;
  readonly portIds: readonly string[];
  readonly weldIds: readonly string[];
  readonly supportIds: readonly string[];
  readonly droppedSupports: number;
  readonly commands: readonly string[];
  /** Spec length of the cap of each capped run (plan run key), mm. */
  readonly capLengths: Readonly<Record<string, number>>;
  /** The plan that was executed (a cap's closed end filled in). */
  readonly plan: RoutePlan;
}

interface Applied {
  readonly next: CadDocument;
  readonly result: CommandResult;
}

/** Runs one nested command; on a refusal (or a no-op) returns the import's own coded refusal carrying the step's code. */
function step(
  original: CadDocument,
  doc: CadDocument,
  name: string,
  params: Record<string, unknown>,
  ctx: ExecutionContext | undefined,
): CommandResult | Applied {
  const result = execute(doc, name, params, ctx);
  if (result.rejected !== true && result.affected.length > 0) return { next: result.document, result };
  const error = result.error;
  return codedRejection(
    original,
    'import_pcf',
    error?.code ?? 'ISO_ROUTE_STEP_FAILED',
    `as route: ${name} did not apply - ${result.summary}`,
    error?.remediation ?? 'Fix the step named in the message, or import the line as pcf_line.',
    error?.ids ?? [],
    error?.paths ?? [],
    error?.detail,
  );
}

const isStep = (value: CommandResult | Applied): value is Applied => 'next' in value;

/** Catalogue type of an inline item: the valve type, a (flat-sided) reducer, or the flanged joint / instrument. */
function inlineTypeOf(item: PlannedRun['inline'][number], valveType: string): string {
  if (item.type === 'valve') return valveType;
  if (item.type === 'reducer') return item.flat === undefined ? 'reducerConcentric' : 'reducerEccentric';
  return item.type;
}

/** Compass-or-vector legs along `points`; with an end port the last segment is left to the closing leg. */
function legsOf(points: readonly Vec3[], closing: boolean): Array<{ direction: unknown; length: number }> {
  const segments = points.slice(1).map((point, k) => ({ from: points[k] as Vec3, to: point }));
  return (closing ? segments.slice(0, -1) : segments).map(({ from, to }) => ({
    direction: directionLabel(normalize3(sub3(to, from))),
    length: distance3(from, to),
  }));
}

/** Leg index and centre distance of a point on the polyline (the closing leg counts as a leg). */
function locate(points: readonly Vec3[], centre: Vec3): { leg: number; centreDistance: number } | undefined {
  for (let k = 1; k < points.length; k++) {
    const [a, b] = [points[k - 1] as Vec3, points[k] as Vec3];
    const length = distance3(a, b);
    const along = distance3(centre, a);
    if (Math.abs(along + distance3(centre, b) - length) <= 0.5 && along > 0) return { leg: k - 1, centreDistance: along };
  }
  return undefined;
}

/** `point` moved `length` further along the last segment of `points`. */
function beyondEnd(points: readonly Vec3[], length: number): Vec3 {
  const [a, b] = [points[points.length - 2] as Vec3, points[points.length - 1] as Vec3];
  const u = normalize3(sub3(b, a));
  return [b[0] + u[0] * length, b[1] + u[1] * length, b[2] + u[2] * length];
}

/**
 * The routed line of a plan. The file gives the joint of a cap and its pipe, not the cap's closed end, and the RTE's run ends at the closed end (the spec cap takes its row length
 * out of the last leg): a plan with such a cap is composed once to learn the spec cap length, then again with each run ending one cap length beyond the joint, so the cap sits
 * where the file has it.
 */
export function composeRoute(original: CadDocument, input: ComposeInput, ctx: ExecutionContext | undefined): Composed | CommandResult {
  const first = composeOnce(original, input, ctx);
  if (!isComposed(first)) return first;
  const open = input.plan.runs.filter((planned) => planned.cap !== undefined && planned.cap.tip === undefined);
  if (open.length === 0 || open.every((planned) => first.capLengths[planned.key] === undefined)) return first;
  const runs = input.plan.runs.map((planned): PlannedRun => {
    const length = first.capLengths[planned.key];
    if (planned.cap === undefined || planned.cap.tip !== undefined || length === undefined) return planned;
    const tip = beyondEnd(planned.points, length);
    return { ...planned, points: [...planned.points.slice(0, -1), tip], cap: { ...planned.cap, tip } };
  });
  return composeOnce(original, { ...input, plan: { ...input.plan, runs } }, ctx);
}

function composeOnce(original: CadDocument, input: ComposeInput, ctx: ExecutionContext | undefined): Composed | CommandResult {
  const { plan } = input;
  const main = plan.runs[0] as PlannedRun;
  const reducerInBranch = plan.runs.find((run) => run.parent !== undefined && run.inline.some((item) => item.type === 'reducer'));
  if (reducerInBranch !== undefined)
    return codedRejection(
      original,
      'import_pcf',
      'ISO_ROUTE_UNSUPPORTED',
      'as route: a reducer inside a branch cannot be placed (add_branch takes the branch size of its end port)',
      'Import the line as pcf_line, or edit the PCF.',
      reducerInBranch.inline.filter((item) => item.type === 'reducer').map((item) => item.componentId),
    );
  const commands: string[] = [];
  const portIds: string[] = [];
  const capLengths: Record<string, number> = {};
  let doc = original;
  /** A nested command: its result, or (document untouched) the import's refusal carrying the step's code. */
  const run = (name: string, params: Record<string, unknown>): CommandResult => {
    const outcome = step(original, doc, name, params, ctx);
    if (!isStep(outcome)) return outcome;
    doc = outcome.next;
    commands.push(name);
    return outcome.result;
  };
  const tie = (port: PlannedPort, label: string): string | CommandResult => {
    const made = run('add_tie_in_point', {
      tag: `${input.lineNumber}-PCF-${label}`,
      position: port.position,
      direction: port.direction,
      dn: port.dn,
      endType: 'FL',
    });
    if (made.rejected === true) return made;
    const id = made.affected[0] as string;
    portIds.push(id);
    return id;
  };

  /** A run that ends in a cap: the spec cap on its end (its length is how far the closed end lies beyond the joint). */
  const closeEnd = (planned: PlannedRun, runId: string): CommandResult | undefined => {
    if (planned.cap === undefined) return undefined;
    const capped = run('set_run_end_cap', { runId, end: 'end', cap: true, closure: planned.cap.kind });
    if (capped.rejected === true) return capped;
    const length = (capped.data as { capLengthMm?: number } | undefined)?.capLengthMm;
    if (length !== undefined) capLengths[planned.key] = length;
    return undefined;
  };

  const created = run('create_pipeline', {
    service: input.service,
    sequence: input.lineNumber,
    spec: input.spec,
    dn: main.dn,
    lineNumber: input.lineNumber,
  });
  if (created.rejected === true) return created;
  const lineId = created.affected[0] as string;
  const runIds: Record<string, string> = {};

  for (const planned of plan.runs) {
    let from: unknown = { point: planned.points[0] };
    if (planned.startPort !== undefined) {
      const id = tie(planned.startPort, `${planned.key}-S`);
      if (typeof id !== 'string') return id;
      from = { portId: id };
    }
    let to: unknown;
    if (planned.endPort !== undefined) {
      const id = tie(planned.endPort, `${planned.key}-E`);
      if (typeof id !== 'string') return id;
      to = { portId: id };
    }
    const legs = legsOf(planned.points, planned.endPort !== undefined);
    const located = planned.inline.map((item) => ({ item, at: locate(planned.points, item.centre) }));
    const lost = located.find((entry) => entry.at === undefined);
    if (lost !== undefined)
      return codedRejection(
        original,
        'import_pcf',
        'ISO_ROUTE_UNSUPPORTED',
        `as route: ${lost.item.type} ${lost.item.componentId} does not lie on the centreline of ${planned.key}`,
        'Import the line as pcf_line, or edit the PCF.',
        [lost.item.componentId],
      );
    const inlineParams = located.map(({ item, at }) => ({
      type: inlineTypeOf(item, input.valveType),
      ...(item.lengthMm === undefined ? {} : { lengthMm: item.lengthMm }),
      ...(item.endType === undefined ? {} : { endType: item.endType }),
      at,
      ...(item.dn2 === undefined ? {} : { dn2: item.dn2 }),
      ...(item.flat === undefined ? {} : 'side' in item.flat ? { flat: item.flat.side } : { flatDirection: item.flat.direction }),
      ...(item.stem === undefined ? {} : { stemDirection: item.stem }),
    }));
    if (planned.parent === undefined) {
      const routed = run('route_pipe', {
        lineId,
        from,
        ...(to === undefined ? {} : { to }),
        legs,
        ...(inlineParams.length === 0 ? {} : { inline: inlineParams }),
      });
      if (routed.rejected === true) return routed;
      runIds[planned.key] = routed.affected[0] as string;
      const closed = closeEnd(planned, runIds[planned.key] as string);
      if (closed !== undefined) return closed;
      continue;
    }
    const header = runIds[planned.parent];
    const branched = run('add_branch', {
      runId: header,
      at: { point: planned.points[0] },
      dn: planned.dn,
      ...(to === undefined ? {} : { to }),
      legs,
    });
    if (branched.rejected === true) return branched;
    const branchRun = branched.affected[0] as string;
    runIds[planned.key] = branchRun;
    const closed = closeEnd(planned, branchRun);
    if (closed !== undefined) return closed;
    for (const item of inlineParams) {
      const placed = run('insert_inline_component', { runId: branchRun, ...item });
      if (placed.rejected === true) return placed;
    }
  }

  const weldIds: string[] = [];
  for (const weld of plan.welds) {
    const added = run('add_field_weld', { lineId, at: weld.at, type: weld.kind });
    if (added.rejected === true) return added;
    weldIds.push(added.affected[0] as string);
  }

  const supportIds: string[] = [];
  let droppedSupports = 0;
  if (!input.supports) droppedSupports = plan.supports.length;
  else {
    // One call per support: a support the pipe does not carry is a failure of that support, not a silently shorter list.
    for (const support of plan.supports) {
      const placed = run('add_pipe_support', {
        line: input.lineNumber,
        at: [support.at],
        type: placeableType(support.type?.toLowerCase() ?? ''),
      });
      if (placed.rejected === true) return placed;
      const created = (placed.data as { supports?: Array<{ id: string }> } | undefined)?.supports ?? [];
      supportIds.push(...created.map((entry) => entry.id));
    }
  }
  return { composed: true, document: doc, lineId, runIds, portIds, weldIds, supportIds, droppedSupports, commands, capLengths, plan };
}

export const isComposed = (value: Composed | CommandResult): value is Composed => 'composed' in value;
