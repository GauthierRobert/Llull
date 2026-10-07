/**
 * Moment-frame analysis behind check_steel_members: detects the frames from the rigid joints,
 * solves each as a 2D frame, and returns the member rows, the frame reports and the storeys they
 * stabilise.
 * @layer domain-aec
 * @pure
 */

import { notionalLabel } from './steelBracingChecks';
import { frameRows } from './steelFrameChecks';
import {
  detectFrames,
  type FrameCoverage,
  type FrameDirection,
  type MomentFrame,
} from './steelFrameDetect';
import { buildFrameSystem } from './steelFrameModel';
import { solveFrameSystem } from './steelFrameSolve';
import type { BeamResult, ColumnNode } from './steelFraming';
import type { SteelBar } from './steelMemberBars';
import { skippedRow, type MemberRow } from './steelMemberRows';

interface FrameParams {
  readonly notionalFactor: number;
  readonly deflectionRatio: number;
  /** Storey drift limit as h / n. */
  readonly swayRatio: number;
}

export interface FrameReport {
  readonly label: string;
  /** Horizontal direction the frame stabilises. */
  readonly direction: FrameDirection;
  /** Plane coordinate, mm. */
  readonly coordinate: number;
  readonly columns: string[];
  readonly beams: string[];
  readonly status: 'solved' | 'mechanism';
  /** Elastic critical load factor (null when no compressed column sways). */
  readonly alphaCritical: number | null;
  /** Moment amplification applied (1 for αcr ≥ 10). */
  readonly amplification: number;
  /** Rigid joints: member mark → joint moment, kNm (hogging negative). */
  readonly jointMoments: Record<string, number>;
}

interface FrameAnalysis {
  readonly rows: Map<string, MemberRow>;
  readonly reports: FrameReport[];
  readonly coverage: FrameCoverage[];
  readonly warnings: string[];
}

function analyseFrame(
  frame: MomentFrame,
  columnNodes: ReadonlyMap<string, ReadonlyArray<ColumnNode>>,
  params: FrameParams,
): { rows: Map<string, MemberRow>; report: FrameReport; warnings: string[] } {
  const system = buildFrameSystem(frame, columnNodes);
  const marks = {
    label: frame.label,
    direction: frame.direction,
    coordinate: frame.coordinate,
    columns: frame.columns.map((column) => column.mark),
    beams: frame.beams.map((beam) => beam.loads.bar.mark),
  };
  const bars = [...frame.columns, ...frame.beams.map((beam) => beam.loads.bar)];
  const failed = (reason: string): ReturnType<typeof analyseFrame> => ({
    rows: new Map(bars.map((bar) => [bar.id, skippedRow(bar, reason)])),
    report: {
      ...marks,
      status: 'mechanism',
      alphaCritical: null,
      amplification: 1,
      jointMoments: {},
    },
    warnings: [`${frame.label}: ${reason}`],
  });
  const solutions = solveFrameSystem(system, params.notionalFactor);
  if (!solutions) {
    return failed(
      'the moment frame is a mechanism (unstable under the loads): fix the column bases, add rigid joints or bracing',
    );
  }
  const rows = frameRows({
    frame,
    system,
    solutions,
    deflectionRatio: params.deflectionRatio,
    swayRatio: params.swayRatio,
    phiText: notionalLabel(params.notionalFactor),
  });
  for (const [id, reason] of system.invalid) {
    const bar = bars.find((candidate) => candidate.id === id);
    if (bar) rows.set(id, skippedRow(bar, reason));
  }
  const jointMoments: Record<string, number> = {};
  for (const beam of frame.beams) {
    const forces = rows.get(beam.loads.bar.id)?.forces ?? {};
    for (const [key, suffix] of [
      ['jointMomentStart', 'start'],
      ['jointMomentEnd', 'end'],
    ] as const) {
      const moment = forces[key];
      if (moment !== undefined) jointMoments[`${beam.loads.bar.mark} ${suffix}`] = moment;
    }
  }
  const baseNotes = frame.columns.flatMap((column) =>
    column.plateFixity !== undefined && column.plateFixity !== column.baseFixity
      ? [
          `${column.mark}: baseFixity '${column.baseFixity}' but its base plate is '${column.plateFixity}' — check_foundations and the plate design only see the plate fixity (add_base_plates fixity)`,
        ]
      : [],
  );
  return {
    rows,
    report: {
      ...marks,
      status: 'solved',
      alphaCritical: Number.isFinite(solutions.alphaCritical) ? solutions.alphaCritical : null,
      amplification: solutions.amplification,
      jointMoments,
    },
    warnings: [
      ...baseNotes,
      ...[...system.invalid].map(
        ([id, reason]) => `${bars.find((bar) => bar.id === id)?.mark ?? id}: ${reason}`,
      ),
    ],
  };
}

/**
 * @param beams every analysed floor beam (frame beams are those with a rigid joint)
 * @param columnNodes reactions of the simply supported analysis, per column
 * @invariant a frame member gets its row from the frame analysis, never from the braced-column / simple-beam checks
 * @failure rigid joint to nothing / mechanism -> member rows not analysed with the reason
 */
export function analyseFrames(
  beams: ReadonlyArray<BeamResult>,
  columns: ReadonlyArray<SteelBar>,
  columnNodes: ReadonlyMap<string, ReadonlyArray<ColumnNode>>,
  params: FrameParams,
): FrameAnalysis {
  const detection = detectFrames(beams, columns);
  const rows = new Map<string, MemberRow>();
  for (const [id, reason] of detection.rejected) {
    const bar = beams.find((beam) => beam.loads.bar.id === id)?.loads.bar;
    if (bar) rows.set(id, skippedRow(bar, reason));
  }
  const warnings = [...detection.warnings];
  const reports: FrameReport[] = [];
  const coverage: FrameCoverage[] = [];
  for (const frame of detection.frames) {
    const outcome = analyseFrame(frame, columnNodes, params);
    for (const [id, row] of outcome.rows) rows.set(id, row);
    reports.push(outcome.report);
    warnings.push(...outcome.warnings);
    if (outcome.report.status === 'solved') {
      coverage.push({
        direction: frame.direction,
        beamTops: frame.beams.map((beam) => beam.loads.top),
      });
    }
  }
  return { rows, reports, coverage, warnings };
}
