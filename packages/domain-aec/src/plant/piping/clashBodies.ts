/**
 * The clash bodies of spec-driven pipe runs (02 RTE §5.10, M3, V1), registered with `check_clashes` through `industrial/clash/clashSources`: boxes
 * of the circumscribing square of each round part, the same widened by the line's insulation for pipe pieces and elbows (kind `envelope`), and the
 * operator envelope of every valve whose catalogue row describes one (`accessoryOf` names the valve).
 *
 * - pipe piece, elbow: as in M3 (an elbow is its two tangent legs to the centre);
 * - valve: its faces, section = `bodyDiameter` of the row, else the pipe outside diameter;
 * - flange: the plate (thickness) at the face with the flange outside diameter, then the hub at the pipe outside diameter;
 * - tee: the header between its run ends and the branch stub to the outlet; olet: base to outlet; reducer: both ends at the larger diameter;
 * - gaskets, bolt sets and stub-ins have no body of their own.
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
import { operatorBodies } from './operator';
import { supportsByRun } from './runSupports';
import { deriveRun } from './routeParts';
import { attachedRunIds, refRunId } from './runLinks';

/** The box of a straight piece from `a` to `b` with a square section of half side `half`; null for a zero-length piece. */
function pieceBox(a: Vec3, b: Vec3, half: number): OrientedBox | null {
  const frame = sweepFrame(a, b);
  return frame === null
    ? null
    : { center: add3(a, scale3(sub3(b, a), 0.5)), axes: [frame.u, frame.v, frame.d], half: [half, half, frame.length / 2] };
}

/** A straight piece of a part's solid: its two ends and the half side of its square section. */
interface Piece {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly half: number;
  /** Pipe pieces and elbows are insulated with the line. */
  readonly insulated: boolean;
}

/** Plate then hub of a flange: the plate is `thickness` from the face port, the hub the rest up to the pipe end. */
function flangePieces(part: RoutedPart): Piece[] {
  const face = part.ports.find((port) => port.endType === 'FL');
  const back = part.ports.find((port) => port.endType !== 'FL');
  const outer = part.dims['outsideDiameter'];
  const pipeOd = part.dims['pipeOutsideDiameter'];
  if (face === undefined || back === undefined || outer === undefined || pipeOd === undefined) return [];
  const axis = sub3(back.position, face.position);
  const length = Math.hypot(...axis);
  if (!(length > 0)) return [];
  const plate = Math.min(part.dims['thickness'] ?? length, length);
  const edge = add3(face.position, scale3(axis, plate / length));
  return [
    { from: face.position, to: edge, half: outer / 2, insulated: false },
    { from: edge, to: back.position, half: pipeOd / 2, insulated: false },
  ];
}

/** The straight pieces of a part's solid body (none for parts that are not modelled). */
function pieces(part: RoutedPart): Piece[] {
  const [first, second, third] = part.ports;
  if (first === undefined || second === undefined) return [];
  const od = part.dims['outsideDiameter'];
  switch (part.kind) {
    case 'pipe':
      return od === undefined ? [] : [{ from: first.position, to: second.position, half: od / 2, insulated: true }];
    case 'elbow':
      return od === undefined || part.centre === undefined
        ? []
        : [
            { from: first.position, to: part.centre, half: od / 2, insulated: true },
            { from: part.centre, to: second.position, half: od / 2, insulated: true },
          ];
    case 'valve':
      return od === undefined
        ? []
        : [{ from: first.position, to: second.position, half: (part.dims['bodyDiameter'] ?? od) / 2, insulated: false }];
    case 'flange':
      return flangePieces(part);
    case 'reducer': {
      const out = part.dims['outsideDiameterOut'];
      return od === undefined || out === undefined
        ? []
        : [{ from: first.position, to: second.position, half: Math.max(od, out) / 2, insulated: false }];
    }
    case 'tee': {
      const branch = part.dims['branchOutsideDiameter'];
      if (od === undefined || branch === undefined || third === undefined || part.centre === undefined) return [];
      return [
        { from: first.position, to: second.position, half: od / 2, insulated: false },
        { from: part.centre, to: third.position, half: branch / 2, insulated: false },
      ];
    }
    case 'olet': {
      const branch = part.dims['branchOutsideDiameter'];
      return branch === undefined
        ? []
        : [{ from: first.position, to: second.position, half: (part.dims['baseDiameter'] ?? branch) / 2, insulated: false }];
    }
    default:
      return [];
  }
}

/** Groups (runs), equipment and pipe supports a run is connected to by design: its clashes with them are intentional. */
function connectionsOf(piping: PipingModel, run: PipeRun, supports: readonly string[]): string[] {
  const runs = [...attachedRunIds(piping, run.id), refRunId(run.start.ref), refRunId(run.end.ref)];
  const equipment = [run.start.ref, run.end.ref].flatMap((ref) => (ref?.kind === 'nozzle' ? [ref.equipmentId] : []));
  return [...runs.filter((id): id is string => id !== undefined), ...equipment, ...supports];
}

export function pipingClashBodies(doc: CadDocument): ExternalBody[] {
  const piping = getPiping(doc);
  if (doc.units !== 'mm' || piping.runOrder.length === 0) return [];
  const bodies: ExternalBody[] = [];
  const supports = supportsByRun(doc);
  for (const runId of piping.runOrder) {
    const run = piping.runs[runId];
    const line = run === undefined ? undefined : piping.lines[run.lineId];
    const derived = run === undefined ? undefined : deriveRun(doc, run);
    if (run === undefined || line === undefined || derived === undefined || !derived.ok) continue;
    const connectedTo = connectionsOf(
      piping,
      run,
      (supports[run.id] ?? []).map((support) => support.id),
    );
    const insulation = line.insulation?.thicknessMm ?? 0;
    for (const part of derived.parts) {
      for (const piece of pieces(part)) {
        const solid = pieceBox(piece.from, piece.to, piece.half);
        if (solid !== null) bodies.push({ id: part.id, kind: 'solid', box: solid, group: run.id, connectedTo });
        const envelope = piece.insulated && insulation > 0 ? pieceBox(piece.from, piece.to, piece.half + insulation) : null;
        if (envelope !== null) bodies.push({ id: part.id, kind: 'envelope', box: envelope, group: run.id, connectedTo });
      }
      if (part.kind !== 'valve') continue;
      for (const body of operatorBodies(part)) {
        const box = pieceBox(body.from, add3(body.from, scale3(body.axis, body.lengthMm)), body.radiusMm);
        if (box !== null) bodies.push({ id: body.id, kind: 'solid', box, group: run.id, connectedTo, accessoryOf: part.id });
      }
    }
  }
  return bodies;
}
