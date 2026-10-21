// Review timeline (FR-FPR-53 / 54): one run of the mechanism (read-only simulate_motion with reaction series and poses) on the shared timeline —
// the 3D replay, the crank speed and the reaction force of a chosen joint follow one cursor; the x axis switches to the crank angle with
// the TDC-firing marks of cylinder 1; collisions from the findings and reaction peaks are clickable events.

import React, { useMemo, useState } from 'react';
import { type SimulationData, reactionsOf } from '@dynamics/index';
import { useStore } from '@ui/store';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { runSimulation } from '@ui/services/simulationRun';
import { TimelineDock } from '@ui/components/TimelineDock';
import { SeriesChart } from '@ui/panels/SeriesChart';
import { StatusLine } from '@ui/panels/PanelParts';
import { crankDegrees, crankJointOf, reactionMagnitude, tdcMarks, timelineEvents } from './reviewTimelineModel';
import type { CheckResult } from './reviewTypes';

const RPM_PER_RAD_S = 60 / (2 * Math.PI);
const SAMPLES = 2000;

const isSimulation = (value: unknown): value is SimulationData =>
  typeof value === 'object' && value !== null && 'joints' in value && 'engine' in value;

interface ReviewTimelineProps {
  readonly checks: readonly CheckResult[];
  /** Simulated seconds of the review run (check_prototype durationS), else 1 s. */
  readonly durationS: number | null;
}

export function ReviewTimeline({ checks, durationS }: ReviewTimelineProps): React.ReactElement | null {
  const document = useDocumentWithoutSelection();
  const result = useDynamicsPlaybackStore((s) => s.result);
  const setResult = useDynamicsPlaybackStore((s) => s.setResult);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const crank = crankJointOf(document.dynamics);
  const reactions = useMemo(() => reactionsOf(result), [result]);
  const joints = Object.keys(reactions?.forces ?? {});
  const [chosen, setChosen] = useState<string>('');
  const joint = joints.includes(chosen) ? chosen : (joints[0] ?? '');
  if (document.dynamics === undefined || Object.keys(document.dynamics.bodies).length === 0) return null;

  const simulate = async (): Promise<void> => {
    const duration = durationS ?? 1;
    setBusy(true);
    const run = await runSimulation(
      { duration, detail: 'poses', reactions: 'series', sampleRate: SAMPLES / duration, ...(crank === null ? {} : { crankAxis: crank }) },
      setStatus,
    );
    setBusy(false);
    setStatus(isSimulation(run.data) ? '' : run.summary);
    const current = useStore.getState().document;
    setResult(isSimulation(run.data) ? run.data : null, { dynamics: current.dynamics, entities: current.entities });
  };

  const times = result?.series?.times ?? [];
  const degrees = result === null ? null : crankDegrees(result, crank);
  const speed = crank === null ? undefined : result?.series?.jointVelocity[crank];
  const force = reactionMagnitude(reactions, joint);
  const aligned = force !== null && reactions !== null && reactions.times.length === times.length;
  return (
    <div className="review-timeline" data-testid="review-timeline">
      <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void simulate()} data-testid="review-simulate">
        {busy ? 'Simulating…' : result === null ? 'Play the motion' : 'Re-run the motion'}
      </button>
      <StatusLine text={status} testId="review-timeline-status" />
      {result !== null && (
        <TimelineDock
          times={times}
          {...(degrees === null ? {} : { crankDegrees: degrees })}
          markers={timelineEvents(checks, reactions)}
          idPrefix="review-timeline"
        >
          {(view) => (
            <>
              {speed !== undefined && crank !== null && (
                <SeriesChart
                  xs={view.xs}
                  xUnit={view.xUnit}
                  cursor={view.cursor}
                  onSeek={view.seek}
                  unit="rpm"
                  title="Crank speed"
                  testId="review-speed-chart"
                  series={[{ id: crank, values: speed.map((v) => v * RPM_PER_RAD_S) }]}
                  marks={view.axis === 'crank' && degrees !== null ? tdcMarks(document.dynamics, degrees) : []}
                />
              )}
              {joints.length > 0 && (
                <label className="findings__filter">
                  <span className="panel__row-meta">Reaction at</span>
                  <select value={joint} onChange={(e) => setChosen(e.target.value)} data-testid="review-reaction-joint">
                    {joints.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {aligned && (
                <SeriesChart
                  xs={view.xs}
                  xUnit={view.xUnit}
                  cursor={view.cursor}
                  onSeek={view.seek}
                  unit="N"
                  title={`Reaction force at ${joint}`}
                  testId="review-reaction-chart"
                  series={[{ id: joint, label: `|F| ${joint}`, values: force }]}
                />
              )}
            </>
          )}
        </TimelineDock>
      )}
    </div>
  );
}
