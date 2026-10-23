/**
 * `PortSource` (02 RTE §2): resolves a port id to a `PortSpec` from tie-in points, equipment nozzles (03 EQP, through `equipmentPorts`; id
 * `<tag>:<mark>`) and the ends of existing runs (id `<runId>:start|end`). Routing never reads equipment geometry directly. A nozzle's end
 * type is FL (a nozzle record always carries its flange); a run end is a plain butt-weld pipe end of its line's size.
 * @invariant pure; a tie-in id wins over a run end, which wins over a nozzle (`<tag>:<mark>`), so a tag named like a run cannot hide a run
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { PipingModel, PipeRun, PortRef, PortSpec } from '@aec/plant/types';
import { elementsOf, getBuilding } from '../../building/model';
import { equipmentPorts } from '../equipment/geometry/ports';
import { getPiping, runPoints } from './model';

export interface ResolvedPort {
  /** The id as the agent passes it: `tie-3`, `P-101:N2`, `run-4:end`. */
  readonly id: string;
  readonly ref: PortRef;
  readonly spec: PortSpec;
}

export type PortResolution = { readonly ok: true; readonly port: ResolvedPort } | { readonly ok: false; readonly message: string };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
};

/** The end of `run` as a port: where a following run continues, along the direction the pipe was heading (start: backwards). */
function runEndPort(piping: PipingModel, run: PipeRun, end: 'start' | 'end'): PortSpec | null {
  const line = piping.lines[run.lineId];
  const points = runPoints(run);
  const [a, b] = end === 'end' ? [points.at(-2), points.at(-1)] : [points[1], points[0]];
  if (line === undefined || a === undefined || b === undefined) return null;
  return { position: b, direction: unit(sub(b, a)), dn: line.dn, endType: 'BW' };
}

function nozzlePort(doc: CadDocument, equipmentId: string, nozzleId: string): PortSpec | null {
  const element = getBuilding(doc).elements[equipmentId];
  if (element?.category !== 'equipment') return null;
  const port = equipmentPorts(doc, element).find((candidate) => candidate.mark === nozzleId);
  if (port === undefined) return null;
  return { position: port.position, direction: port.direction, dn: port.dn, endType: 'FL', rating: port.rating, facing: port.facing };
}

/** The port a stored reference points at now, or null when its tie-in / nozzle / run no longer exists. */
export function portOfRef(doc: CadDocument, ref: PortRef): PortSpec | null {
  const piping = getPiping(doc);
  switch (ref.kind) {
    case 'tieIn':
      return piping.tieIns[ref.id]?.port ?? null;
    case 'nozzle':
      return nozzlePort(doc, ref.equipmentId, ref.nozzleId);
    case 'runEnd': {
      const run = piping.runs[ref.runId];
      return run === undefined ? null : runEndPort(piping, run, ref.end);
    }
  }
}

/** The id an agent uses for `ref` (the inverse of `resolvePortId`). */
export function portIdOf(doc: CadDocument, ref: PortRef): string {
  switch (ref.kind) {
    case 'tieIn':
      return ref.id;
    case 'nozzle':
      return `${getBuilding(doc).elements[ref.equipmentId]?.mark ?? ref.equipmentId}:${ref.nozzleId}`;
    case 'runEnd':
      return `${ref.runId}:${ref.end}`;
  }
}

const sameRef = (a: PortRef, b: PortRef): boolean =>
  a.kind === 'tieIn'
    ? b.kind === 'tieIn' && a.id === b.id
    : a.kind === 'nozzle'
      ? b.kind === 'nozzle' && a.equipmentId === b.equipmentId && a.nozzleId === b.nozzleId
      : b.kind === 'runEnd' && a.runId === b.runId && a.end === b.end;

/**
 * Resolves a port id: `tie-3` (add_tie_in_point), `run-4:start` / `run-4:end` (the open end of an existing run) or `<tag>:<mark>` (equipment nozzle).
 * @failure unknown id -> ok:false with the message that names what exists
 */
export function resolvePortId(doc: CadDocument, portId: string): PortResolution {
  const piping = getPiping(doc);
  const tieIn = piping.tieIns[portId];
  if (tieIn !== undefined) return { ok: true, port: { id: portId, ref: { kind: 'tieIn', id: tieIn.id }, spec: tieIn.port } };
  const [head, tail] = portId.split(/:(?=[^:]*$)/);
  const run = head === undefined ? undefined : piping.runs[head];
  if (run !== undefined && (tail === 'start' || tail === 'end')) {
    const spec = runEndPort(piping, run, tail);
    if (spec !== null) return { ok: true, port: { id: portId, ref: { kind: 'runEnd', runId: run.id, end: tail }, spec } };
  }
  const equipment = tail === undefined ? undefined : elementsOf(getBuilding(doc), 'equipment').find((element) => element.mark === head);
  if (equipment !== undefined && tail !== undefined) {
    const spec = nozzlePort(doc, equipment.id, tail);
    if (spec !== null) return { ok: true, port: { id: portId, ref: { kind: 'nozzle', equipmentId: equipment.id, nozzleId: tail }, spec } };
    return {
      ok: false,
      message: `equipment ${head} has no nozzle "${tail}" (ports: ${nozzleIds(doc, equipment.id).join(', ') || 'none'})`,
    };
  }
  return {
    ok: false,
    message: `no port "${portId}": use a tie-in id (add_tie_in_point), "<tag>:<mark>" of an equipment nozzle (equipment_ports) or "<runId>:start|end"`,
  };
}

function nozzleIds(doc: CadDocument, equipmentId: string): string[] {
  const element = getBuilding(doc).elements[equipmentId];
  return element?.category === 'equipment' ? equipmentPorts(doc, element).map((port) => port.id) : [];
}

/**
 * The id of what already uses `ref`: a run whose start or end is connected to it, or (a run end) the port that end is connected to.
 * Undefined when the port is free.
 */
export function portOccupant(doc: CadDocument, ref: PortRef): string | undefined {
  const piping = getPiping(doc);
  const user = piping.runOrder.find((id) => {
    const run = piping.runs[id];
    return run !== undefined && [run.start.ref, run.end.ref].some((other) => other !== undefined && sameRef(other, ref));
  });
  if (user !== undefined) return user;
  if (ref.kind !== 'runEnd') return undefined;
  const connected = piping.runs[ref.runId]?.[ref.end === 'start' ? 'start' : 'end'].ref;
  return connected === undefined ? undefined : portIdOf(doc, connected);
}
