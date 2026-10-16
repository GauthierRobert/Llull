// Shared timeline: one cursor (dynamicsPlaybackStore.cursorTime) drives the 3D replay and every chart placed inside it. Play/pause, scrub,
// speed, a time ⇄ crank-angle axis switch (offered only when a crank-angle series exists) and clickable event markers.

import React from 'react';
import { PLAYBACK_SPEEDS, useDynamicsPlaybackStore, type TimelineAxis } from '@ui/store/dynamicsPlaybackStore';
import { interpolate } from '@ui/panels/seriesMath';

interface TimelineMarker {
  readonly id: string;
  /** Simulated seconds. */
  readonly time: number;
  readonly label: string;
  readonly kind: 'collision' | 'peak';
}

/** What a chart needs to draw on the active axis. */
interface TimelineView {
  readonly axis: TimelineAxis;
  /** x per sample on the active axis. */
  readonly xs: readonly number[];
  readonly xUnit: string;
  /** Cursor on the active axis. */
  readonly cursor: number;
  /** Seek from an x on the active axis. */
  readonly seek: (x: number) => void;
}

interface TimelineDockProps {
  /** Sample times (s) of the run's series. */
  readonly times: readonly number[];
  /** Crank angle (deg, ascending) per sample; the crank axis is offered only when this matches `times`. */
  readonly crankDegrees?: readonly number[];
  readonly markers?: readonly TimelineMarker[];
  /** Test-id prefix of the controls. */
  readonly idPrefix?: string;
  readonly children: (view: TimelineView) => React.ReactNode;
}

const format = (value: number, digits = 3): string => value.toLocaleString('en-US', { maximumFractionDigits: digits });

export function TimelineDock({
  times,
  crankDegrees,
  markers = [],
  idPrefix = 'timeline',
  children,
}: TimelineDockProps): React.ReactElement | null {
  const result = useDynamicsPlaybackStore((s) => s.result);
  const cursorTime = useDynamicsPlaybackStore((s) => s.cursorTime);
  const playing = useDynamicsPlaybackStore((s) => s.playing);
  const speed = useDynamicsPlaybackStore((s) => s.speed);
  const storedAxis = useDynamicsPlaybackStore((s) => s.axis);
  const { setTime, setPlaying, setSpeed, setAxis, setResult } = useDynamicsPlaybackStore.getState();
  if (result === null) return null;
  const crankAvailable = crankDegrees !== undefined && crankDegrees.length === times.length && times.length > 1;
  const axis: TimelineAxis = crankAvailable ? storedAxis : 'time';
  const onCrank = axis === 'crank' && crankDegrees !== undefined;
  const view: TimelineView = onCrank
    ? {
        axis,
        xs: crankDegrees,
        xUnit: '° crank',
        cursor: interpolate(times, crankDegrees, cursorTime),
        seek: (x) => setTime(interpolate(crankDegrees, times, x)),
      }
    : { axis: 'time', xs: times, xUnit: 's', cursor: cursorTime, seek: setTime };
  return (
    <div className="timeline-dock" data-testid={`${idPrefix}-dock`}>
      {children(view)}
      <div className="timeline-dock__row">
        <button type="button" className="btn btn--sm" onClick={() => setPlaying(!playing)} data-testid={`${idPrefix}-play`}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          className="timeline-dock__scrub"
          min={0}
          max={result.duration}
          step={result.duration / 1000}
          value={cursorTime}
          onChange={(e) => setTime(parseFloat(e.target.value))}
          aria-label="Simulation time"
          data-testid={`${idPrefix}-scrub`}
        />
        <span className="panel__row-meta" data-testid={`${idPrefix}-readout`}>
          {format(cursorTime)} s
        </span>
      </div>
      {markers.length > 0 && (
        <ul className="timeline-dock__markers" aria-label="Timeline events" data-testid={`${idPrefix}-markers`}>
          {markers.map((marker) => (
            <li key={marker.id}>
              <button
                type="button"
                className={`timeline-dock__marker timeline-dock__marker--${marker.kind}`}
                onClick={() => setTime(marker.time)}
                title={`${marker.label} at ${format(marker.time)} s`}
              >
                <span aria-hidden="true">{marker.kind === 'collision' ? '✖' : '▲'}</span> {marker.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="timeline-dock__row">
        <label className="panel__row-meta" htmlFor={`${idPrefix}-speed`}>
          Speed
        </label>
        <select
          id={`${idPrefix}-speed`}
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))}
          data-testid={`${idPrefix}-speed`}
        >
          {PLAYBACK_SPEEDS.map((factor) => (
            <option key={factor} value={factor}>
              {factor === 1 ? 'real time' : `${factor}× (slow motion)`}
            </option>
          ))}
        </select>
        {crankAvailable && (
          <select
            value={axis}
            onChange={(e) => setAxis(e.target.value === 'crank' ? 'crank' : 'time')}
            aria-label="Chart x axis"
            data-testid={`${idPrefix}-axis`}
          >
            <option value="time">Time (s)</option>
            <option value="crank">Crank angle (°)</option>
          </select>
        )}
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setResult(null)} data-testid={`${idPrefix}-clear`}>
          Back to design pose
        </button>
      </div>
    </div>
  );
}
