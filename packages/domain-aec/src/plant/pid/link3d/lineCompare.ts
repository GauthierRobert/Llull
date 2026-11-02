/** Line-level comparisons of one paired P&ID line and 3D line: size, spec (piping class), connectivity (plant 04 PID §5.6). */

import type { PidEndpoint, PidLine, PidModel, PidSegment } from '../model';
import { itemAt, text, type Norm, type Run } from './common';
import { makeFinding3d, type Finding3d, type Skip3d } from './finding';

interface End {
  readonly tag: string;
  readonly nozzle: string | undefined;
  /** The tag and sub-tag as written, for messages. */
  readonly shown: string;
}

/** `{ equipment tag, nozzle sub-tag }` of a segment end on a nozzle; any other end (free, branch, inline, off-page) is not compared. */
function pidEnd(pid: PidModel, end: PidEndpoint, norm: Norm): End | undefined {
  if (end.type !== 'nozzle') return undefined;
  const nozzle = itemAt(pid, end.itemId);
  if (nozzle?.kind !== 'nozzle') return undefined;
  let owner = itemAt(pid, nozzle.equipmentId);
  for (let depth = 0; depth < 16 && owner?.kind === 'equipment' && owner.parentId !== undefined; depth++)
    owner = itemAt(pid, owner.parentId);
  if (owner?.kind !== 'equipment' || owner.tag === undefined) return undefined;
  return { tag: norm(owner.tag), nozzle: norm(nozzle.subTag), shown: `${owner.tag}/${nozzle.subTag}` };
}

/** `TAG` or `TAG:NOZZLE` (the 03 EQP port id) of a pipe's from / to. */
function modelEnd(value: string | undefined, norm: Norm): End | undefined {
  const clean = text(value);
  if (clean === undefined) return undefined;
  const cut = clean.indexOf(':');
  return cut < 0
    ? { tag: norm(clean), nozzle: undefined, shown: clean }
    : { tag: norm(clean.slice(0, cut)), nozzle: norm(clean.slice(cut + 1)), shown: `${clean.slice(0, cut)}/${clean.slice(cut + 1)}` };
}

const sameEnd = (pidSide: End, modelSide: End): boolean =>
  pidSide.tag === modelSide.tag && (modelSide.nozzle === undefined || modelSide.nozzle === pidSide.nozzle);

export const segmentsOf = (pid: PidModel, line: PidLine): PidSegment[] =>
  line.segmentIds.flatMap((id) => {
    const segment = itemAt(pid, id);
    return segment?.kind === 'segment' ? [segment] : [];
  });

const dnList = (values: ReadonlyArray<number | undefined>): number[] =>
  [...new Set(values.filter((n): n is number => n !== undefined))].sort((a, b) => a - b);

/** Distinct normalised non-empty names, sorted, with the first spelling of each for messages. */
function nameSet(names: ReadonlyArray<string | undefined>, norm: Norm): Map<string, string> {
  const set = new Map<string, string>();
  for (const name of names) {
    const clean = text(name);
    if (clean !== undefined && !set.has(norm(clean))) set.set(norm(clean), clean);
  }
  return new Map([...set].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface LineComparison {
  readonly findings: Finding3d[];
  readonly skips: Skip3d[];
}

/**
 * P3D_SPEC_MISMATCH decision: a P&ID piping class IS the id of the 01 PSC spec (`PipeLine.spec`, `PipeElement.spec.specId`); both sides are
 * normalised like tags and compared as sets (a line with a spec break carries several), the way DN sets are.
 */
function compareSpec(line: PidLine, run: Run, segments: readonly PidSegment[], norm: Norm, label: string): LineComparison {
  const pidClasses = nameSet(segments.length > 0 ? segments.map((s) => s.pipingClass ?? line.pipingClass) : [line.pipingClass], norm);
  const specs = nameSet(run.specs, norm);
  const where = { item: label, pidIds: [line.id], elementIds: run.ids };
  if (pidClasses.size === 0)
    return {
      findings: [],
      skips: [{ code: 'P3D_SPEC_MISMATCH', reason: 'no_pid_class', ...where, detail: `line ${label}: the P&ID line has no piping class` }],
    };
  if (specs.size === 0)
    return {
      findings: [],
      skips: [
        {
          code: 'P3D_SPEC_MISMATCH',
          reason: 'no_3d_spec',
          ...where,
          detail: `line ${label}: the 3D line has no spec binding (a legacy pipe, or a spec-less line)`,
        },
      ],
    };
  const [pidKeys, specKeys] = [[...pidClasses.keys()].join(','), [...specs.keys()].join(',')];
  if (pidKeys === specKeys) return { findings: [], skips: [] };
  const [pidShown, specShown] = [[...pidClasses.values()].join('/'), [...specs.values()].join('/')];
  return {
    findings: [
      makeFinding3d({
        code: 'P3D_SPEC_MISMATCH',
        pidIds: [line.id],
        elementIds: run.ids,
        item: label,
        message: `line ${label}: P&ID piping class ${pidShown} but the 3D spec is ${specShown}`,
        values: { pidClass: pidShown, modelSpec: specShown },
      }),
    ],
    skips: [],
  };
}

export function compareLine(pid: PidModel, line: PidLine, run: Run, norm: Norm): LineComparison {
  const findings: Finding3d[] = [];
  const label = line.lineNumber ?? line.id;
  const segments = segmentsOf(pid, line);
  const pidDn = dnList(segments.map((s) => s.dn ?? line.dn));
  const modelDn = dnList(run.dns);
  if (pidDn.length > 0 && modelDn.length > 0 && pidDn.join(',') !== modelDn.join(','))
    findings.push(
      makeFinding3d({
        code: 'P3D_SIZE_MISMATCH',
        pidIds: [line.id],
        elementIds: run.ids,
        item: label,
        message: `line ${label}: P&ID DN ${pidDn.join('/')} but 3D DN ${modelDn.join('/')}`,
        values: { pidDn: pidDn.join(','), modelDn: modelDn.join(',') },
      }),
    );
  const spec = compareSpec(line, run, segments, norm, label);
  findings.push(...spec.findings);
  const first = segments[0];
  const last = segments[segments.length - 1];
  const a = first === undefined ? undefined : pidEnd(pid, first.from, norm);
  const b = last === undefined ? undefined : pidEnd(pid, last.to, norm);
  const c = modelEnd(run.from, norm);
  const d = modelEnd(run.to, norm);
  if (
    a !== undefined &&
    b !== undefined &&
    c !== undefined &&
    d !== undefined &&
    !((sameEnd(a, c) && sameEnd(b, d)) || (sameEnd(a, d) && sameEnd(b, c)))
  ) {
    findings.push(
      makeFinding3d({
        code: 'P3D_CONNECTIVITY_MISMATCH',
        pidIds: [line.id],
        elementIds: run.ids,
        item: label,
        message: `line ${label}: P&ID connects ${a.shown} and ${b.shown} but the 3D run goes ${c.shown} to ${d.shown}`,
        values: { pidEnds: `${a.shown} | ${b.shown}`, modelEnds: `${c.shown} | ${d.shown}` },
      }),
    );
  }
  return { findings, skips: spec.skips };
}
