/**
 * The clash bodies of spec-driven pipe runs (02 RTE §5.10, M3), registered with `check_clashes` through `industrial/clash/clashSources`: one box per
 * pipe piece and one per elbow leg (port to centre), sized by the pipe outside diameter, plus the same boxes widened by the line's insulation thickness
 * (envelope diameter OD + 2 t). Valves, flanges and tees are not modelled yet (V1). Boxes are the circumscribing square of the round section, like the
 * legacy pipe boxes.
 * @invariant derived from the same memoised derivation as `check_piping`; a run that does not derive has no bodies; none in a non-mm document
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { PipeRun, PipingModel, RoutedPart } from '@aec/plant/types';
import { add3, scale3, sub3 } from '@lib/vec3';
import type { OrientedBox } from '../../industrial/clash/clashBoxes';
import type { ExternalBody } from '../../industrial/clash/clashSources';
import { sweepFrame } from '../../shared/mesh';
import { getPiping } from './model';
import { deriveRun } from './routeParts';
import { attachedRunIds, refRunId } from './runLinks';

/** The box of a straight piece from `a` to `b` with a square section of half side `half`; null for a zero-length piece. */
function pieceBox(a: Vec3, b: Vec3, half: number): OrientedBox | null {
  const frame = sweepFrame(a, b);
  return frame === null
    ? null
    : { center: add3(a, scale3(sub3(b, a), 0.5)), axes: [frame.u, frame.v, frame.d], half: [half, half, frame.length / 2] };
}

/** The straight pieces of a part: a pipe piece is one, an elbow is its two tangent legs to the centre. */
function pieces(part: RoutedPart): Array<[Vec3, Vec3]> {
  const [first, second] = part.ports;
  if (first === undefined || second === undefined) return [];
  if (part.kind === 'pipe') return [[first.position, second.position]];
  return part.kind === 'elbow' && part.centre !== undefined
    ? [
        [first.position, part.centre],
        [part.centre, second.position],
      ]
    : [];
}

/** Groups (runs) and equipment a run is connected to by design: its clashes with them are intentional. */
function connectionsOf(piping: PipingModel, run: PipeRun): string[] {
  const runs = [...attachedRunIds(piping, run.id), refRunId(run.start.ref), refRunId(run.end.ref)];
  const equipment = [run.start.ref, run.end.ref].flatMap((ref) => (ref?.kind === 'nozzle' ? [ref.equipmentId] : []));
  return [...runs.filter((id): id is string => id !== undefined), ...equipment];
}

export function pipingClashBodies(doc: CadDocument): ExternalBody[] {
  const piping = getPiping(doc);
  if (doc.units !== 'mm' || piping.runOrder.length === 0) return [];
  const bodies: ExternalBody[] = [];
  for (const runId of piping.runOrder) {
    const run = piping.runs[runId];
    const line = run === undefined ? undefined : piping.lines[run.lineId];
    const derived = run === undefined ? undefined : deriveRun(doc, run);
    if (run === undefined || line === undefined || derived === undefined || !derived.ok) continue;
    const connectedTo = connectionsOf(piping, run);
    const insulation = line.insulation?.thicknessMm ?? 0;
    for (const part of derived.parts) {
      const od = part.dims['outsideDiameter'];
      if (od === undefined) continue;
      for (const [a, b] of pieces(part)) {
        const solid = pieceBox(a, b, od / 2);
        if (solid !== null) bodies.push({ id: part.id, kind: 'solid', box: solid, group: run.id, connectedTo });
        const envelope = insulation > 0 ? pieceBox(a, b, od / 2 + insulation) : null;
        if (envelope !== null) bodies.push({ id: part.id, kind: 'envelope', box: envelope, group: run.id, connectedTo });
      }
    }
  }
  return bodies;
}
