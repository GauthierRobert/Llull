/** Fixtures of the PID-M7b tests: SC-RTE-01 (pump P-101, vessel V-101, routed line) with three tagged valves, and the matching P&ID. */

import { apply } from '../../../helpers/commandAssertions';
import type { CadDocument } from '@core/model/types';
import { routedPumpToVessel } from '../piping/rteFixtures';
import { runSteps, segmentsOfLine, type Step } from './authoringFixtures';

export interface Valve {
  readonly tag: string;
  readonly type: string;
  readonly leg: number;
}
/** Leg 0 is vertical (1500), legs 1 and 2 horizontal (3000): one valve per leg fits. Route order: XV-1, XV-2, XV-3 from the pump. */
const VALVES: readonly Valve[] = [
  { tag: 'XV-1', type: 'valveGate', leg: 0 },
  { tag: 'XV-2', type: 'valveGate', leg: 1 },
  { tag: 'XV-3', type: 'valveGate', leg: 2 },
];
const DEXPI_OF: Readonly<Record<string, string>> = { valveGate: 'GateValve' };

export interface Scene3d {
  readonly doc: CadDocument;
  readonly lineNumber: string;
  readonly runId: string;
}

/** The routed SC-RTE-01 line with `valves` inserted (in the given insertion order; the route order is by leg). */
export function routedWithValves(valves: readonly Valve[] = VALVES): Scene3d {
  const base = routedPumpToVessel();
  let doc = base.doc;
  for (const valve of valves)
    doc = apply(doc, 'insert_inline_component', {
      runId: base.runId,
      type: valve.type,
      tag: valve.tag,
      at: { leg: valve.leg, centreDistance: valve.leg === 0 ? 600 : 1500 },
    });
  return { doc, lineNumber: doc.plant?.piping?.lines[base.line]?.lineNumber ?? '', runId: base.runId };
}

export interface InlineSpec {
  readonly tag: string;
  readonly class: string;
}
export interface PidOptions {
  readonly pipingClass?: string;
  readonly vesselClass?: string;
  /** Sub-tag of the pump nozzle on the P&ID (the 3D port is N2). */
  readonly pumpNozzle?: string;
  /** Inline items in the order they are drawn from the pump (P-101) toward the vessel. */
  readonly inline?: readonly InlineSpec[];
}

/** The P&ID of the scene: V-101 and P-101 with the 3D nozzle marks, the line from the pump to the vessel, inline items spread along its longest leg. */
export function withPid(scene: Scene3d, options: PidOptions = {}): CadDocument {
  const steps: Step[] = [
    { command: 'create_pid_sheet', params: { number: 'PID-001', title: 'Scene', paper: 'A3', convention: 'ISA-5.1' }, as: 'sheet' },
    {
      command: 'add_pid_equipment',
      params: {
        sheet: '$sheet',
        class: options.vesselClass ?? 'PressureVessel',
        tag: 'V-101',
        at: [60, 150],
        nozzles: [{ subTag: 'N1', side: 'bottom', dn: 100 }],
      },
    },
    {
      command: 'add_pid_equipment',
      params: {
        sheet: '$sheet',
        class: 'CentrifugalPump',
        tag: 'P-101',
        at: [200, 80],
        nozzles: [{ subTag: options.pumpNozzle ?? 'N2', side: 'left', dn: 100 }],
      },
    },
    {
      command: 'add_pid_line',
      params: {
        sheet: '$sheet',
        from: { tag: 'P-101', nozzle: options.pumpNozzle ?? 'N2' },
        to: { tag: 'V-101', nozzle: 'N1' },
        lineNumber: scene.lineNumber,
        dn: 100,
        ...(options.pipingClass === undefined ? {} : { pipingClass: options.pipingClass }),
      },
    },
  ];
  const drawn = runSteps(steps, scene.doc);
  const route = segmentsOfLine(drawn.doc, scene.lineNumber)[0]?.route ?? [];
  let best = -1;
  let from = route[0];
  let to = route[1];
  for (let i = 0; i + 1 < route.length; i++) {
    const [a, b] = [route[i], route[i + 1]];
    const length = a === undefined || b === undefined ? 0 : Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > best) [best, from, to] = [length, a, b];
  }
  const inline = options.inline ?? [];
  const points = inline.map((_, k) => {
    const t = (k + 1) / (inline.length + 1);
    return [(from?.[0] ?? 0) + ((to?.[0] ?? 0) - (from?.[0] ?? 0)) * t, (from?.[1] ?? 0) + ((to?.[1] ?? 0) - (from?.[1] ?? 0)) * t];
  });
  const placed = runSteps(
    inline.map(
      (item, k): Step => ({
        command: 'add_pid_inline',
        params: { line: scene.lineNumber, at: points[k], class: item.class, tag: item.tag },
      }),
    ),
    drawn.doc,
  );
  for (const r of [...drawn.results, ...placed.results]) if (r.rejected !== undefined) throw new Error(r.summary);
  return placed.doc;
}

export const CLEAN_INLINE: readonly InlineSpec[] = VALVES.map((v) => ({ tag: v.tag, class: DEXPI_OF[v.type] as string }));
