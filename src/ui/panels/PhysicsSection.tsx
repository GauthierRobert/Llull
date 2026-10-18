// Mechanisms › Physics: the rigid-body setup (inspect_dynamics), a Simulate button (read-only simulate_motion, MuJoCo loaded on first use),
// the run's numbers, an rpm-vs-time chart with the playback cursor, and playback controls for the viewport replay (DynamicsPlayer).

import React, { useMemo, useState } from 'react';
import { useStore } from '@ui/store';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { runSimulation } from '@ui/services/simulationRun';
import { execute } from '@core/commands/registry';
import type { SimulationData } from '@core/dynamics/simulationReport';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { PanelEmpty, PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { parseNumber } from '@ui/numberText';
import { SeriesChart } from './SeriesChart';
import { TimelineDock } from '@ui/components/TimelineDock';

const RPM_PER_RAD_S = 60 / (2 * Math.PI);
/** Samples per simulated second for playback: ≥ 4 per turn up to 15 000 rpm on short runs; capped by the command's 6001 samples. */
const PLAYBACK_SAMPLES = 6000;

/** Grouped number with at most `digits` decimals; a value that rounds to zero prints "0", never "-0". */
const format = (value: number, digits = 1): string =>
  (Number(value.toFixed(digits)) === 0 ? 0 : value).toLocaleString('en-US', { maximumFractionDigits: digits });

function isSimulationData(value: unknown): value is SimulationData {
  return typeof value === 'object' && value !== null && 'joints' in value && 'engine' in value;
}

interface InspectBody {
  readonly name: string | null;
  readonly massKg: number;
  readonly fixed: boolean;
  readonly inertiaAboutJointAxis: number | null;
}

function isInspectData(value: unknown): value is { bodies: Record<string, InspectBody>; problems: string[] } {
  return typeof value === 'object' && value !== null && 'bodies' in value && 'problems' in value;
}

function ResultTable({ result }: { result: SimulationData }): React.ReactElement {
  return (
    <table className="physics-results" data-testid="physics-results">
      <tbody>
        {Object.entries(result.joints).map(([id, joint]) => (
          <tr key={id}>
            <th scope="row">{id}</th>
            <td>{joint.finalRpm !== undefined ? `${format(joint.finalRpm)} rpm` : `${format(joint.finalVelocity, 3)} m/s`}</td>
            <td className="physics-results__meta">{joint.steady ? `steady ${format(joint.settledAfter ?? 0, 2)} s` : 'still changing'}</td>
          </tr>
        ))}
        {Object.entries(result.motors).map(([id, motor]) => (
          <tr key={id}>
            <th scope="row">{id}</th>
            <td>{format(motor.torque)} N·m</td>
            <td className="physics-results__meta">{format(motor.power / 1000, 2)} kW</td>
          </tr>
        ))}
        {Object.entries(result.propellers).map(([id, prop]) => (
          <tr key={id}>
            <th scope="row">{id}</th>
            <td>{format(prop.thrust)} N thrust</td>
            <td className="physics-results__meta">
              {format(prop.rpm)} rpm · {format(prop.power / 1000, 2)} kW · tip M{format(prop.tipMach, 2)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PhysicsSection(): React.ReactElement {
  const document = useDocumentWithoutSelection();
  const dynamics = document.dynamics;
  const result = useDynamicsPlaybackStore((s) => s.result);
  const setResult = useDynamicsPlaybackStore((s) => s.setResult);
  const speedSeries = useMemo(
    () =>
      result?.series === undefined
        ? []
        : Object.entries(result.series.jointVelocity)
            .filter(([id]) => result.joints[id]?.kind === 'revolute')
            .map(([id, values]) => ({ id, values: values.map((v) => v * RPM_PER_RAD_S) })),
    [result],
  );
  const energySeries = useMemo(() => {
    const energy = result?.series?.energy;
    return energy === undefined
      ? []
      : [
          { id: 'kinetic', values: energy.kinetic },
          { id: 'potential', values: energy.potential },
          { id: 'total', values: energy.total },
          { id: 'dissipated', values: energy.dissipated },
        ];
  }, [result]);
  const priority = useMemo(
    () =>
      result === null ? [] : [...Object.values(result.motors).map((m) => m.joint), ...Object.values(result.propellers).map((p) => p.joint)],
    [result],
  );
  const [duration, setDuration] = useState('5');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  // inspect_dynamics reads the whole document (entities, materials, units): recompute whenever it changes
  const inspect = useMemo(() => (document.dynamics === undefined ? null : execute(document, 'inspect_dynamics', {}).data), [document]);
  const bodyCount = Object.keys(dynamics?.bodies ?? {}).length;

  const simulate = async (): Promise<void> => {
    const seconds = parseNumber(duration) ?? 5;
    setBusy(true);
    setStatus(`Simulating ${format(seconds, 2)} s…`);
    const run = await runSimulation(
      { duration: seconds, detail: 'poses', energy: true, sampleRate: Math.min(1000, PLAYBACK_SAMPLES / seconds) },
      setStatus,
    );
    setBusy(false);
    setStatus(run.summary);
    const source = { dynamics: useStore.getState().document.dynamics, entities: useStore.getState().document.entities };
    setResult(isSimulationData(run.data) ? run.data : null, source);
  };

  if (dynamics === undefined || bodyCount === 0)
    return (
      <PanelSection collapsible title="Physics" testId="mechanisms-section-physics">
        <PanelEmpty
          compact
          icon="mechanism"
          message="No rigid bodies yet."
          hint="Make parts physical with add_rigid_body, connect them with add_body_joint, drive them with add_motor (ask the AI: “make the propeller spin with real physics”)."
        />
      </PanelSection>
    );

  const bodies = isInspectData(inspect) ? inspect.bodies : {};
  const problems = isInspectData(inspect) ? inspect.problems : [];
  return (
    <PanelSection collapsible title="Physics" count={bodyCount} countLabel={`${bodyCount} bodies`} testId="mechanisms-section-physics">
      <ul className="panel__list" aria-label="Rigid bodies">
        {Object.entries(bodies).map(([id, body]) => (
          <li key={id} className="panel__row" data-testid={`physics-body-${id}`}>
            <span className="panel__row-main">{body.name ?? id}</span>
            <span className="panel__row-meta">
              {format(body.massKg, 3)} kg{body.fixed ? ' · fixed' : ''}
              {body.inertiaAboutJointAxis !== null ? ` · I ${body.inertiaAboutJointAxis.toPrecision(3)} kg·m²` : ''}
            </span>
          </li>
        ))}
      </ul>
      {problems.length > 0 && <StatusLine text={problems.join('; ')} testId="physics-problems" />}
      <div className="physics-run">
        <label className="panel__row-meta" htmlFor="physics-duration">
          Duration (s)
        </label>
        <input
          id="physics-duration"
          className="physics-run__duration"
          type="number"
          min={0.1}
          step={0.5}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          data-testid="physics-duration"
        />
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={busy || problems.length > 0}
          onClick={() => void simulate()}
          data-testid="physics-simulate"
        >
          {busy ? 'Simulating…' : 'Simulate'}
        </button>
      </div>
      {status !== '' && result === null && <StatusLine text={status} testId="physics-status" />}
      {result !== null && (
        <>
          <ResultTable result={result} />
          {result.energy !== undefined && (
            <p className="physics-engine-note" data-testid="physics-energy">
              Energy: total {format(result.energy.initialTotalJ, 3)} → {format(result.energy.finalTotalJ, 3)} J · dissipated{' '}
              {format(result.energy.dissipatedJ, 3)} J · {energyCheck(result.energy)}
            </p>
          )}
          {result.warnings.length > 0 && <StatusLine text={`⚠ ${result.warnings.join('; ')}`} testId="physics-warnings" />}
          <TimelineDock times={result.series?.times ?? []} idPrefix="physics">
            {(view) => (
              <>
                {speedSeries.length > 0 && (
                  <SeriesChart
                    xs={view.xs}
                    xUnit={view.xUnit}
                    cursor={view.cursor}
                    onSeek={view.seek}
                    unit="rpm"
                    title="Joint speed over simulated time"
                    testId="physics-chart"
                    priority={priority}
                    series={speedSeries}
                  />
                )}
                {energySeries.length > 0 && (
                  <SeriesChart
                    xs={view.xs}
                    xUnit={view.xUnit}
                    cursor={view.cursor}
                    onSeek={view.seek}
                    unit="J"
                    title="Mechanical energy over simulated time"
                    testId="physics-energy-chart"
                    series={energySeries}
                  />
                )}
              </>
            )}
          </TimelineDock>
          <p className="physics-engine-note" data-testid="physics-engine-note">
            {result.engine} · rigid-body dynamics{Object.keys(result.propellers).length > 0 ? ', static propeller model' : ''}
          </p>
        </>
      )}
    </PanelSection>
  );
}

/** Balance closure when the engine reports input work; otherwise total-energy drift, meaningful only for a lossless run. */
function energyCheck(energy: { maxDeviationFraction: number; dissipatedJ: number; balanceErrorFraction?: number }): string {
  if (energy.balanceErrorFraction !== undefined) return `balance error ${format(energy.balanceErrorFraction * 100, 2)} %`;
  return energy.dissipatedJ > 0 ? 'lossy run (no balance reported)' : `drift ${format(energy.maxDeviationFraction * 100, 2)} % of peak`;
}
