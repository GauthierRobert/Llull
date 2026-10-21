import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SimulationData } from '@dynamics/sim/simulationReport';
import { SeriesChart } from '@ui/panels/SeriesChart';
import { TimelineDock } from '@ui/components/TimelineDock';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { interpolate } from '@ui/panels/seriesMath';

const times = [0, 1, 2, 3, 4];
const crank = [0, 180, 360, 540, 720];
const series = [{ id: 'crank_joint', values: [0, 10, 20, 30, 40] }];

function runOf(duration: number): SimulationData {
  return { duration } as unknown as SimulationData;
}

beforeEach(() => {
  useDynamicsPlaybackStore.setState({ result: runOf(4), time: 0, cursorTime: 0, axis: 'time', playing: false, speed: 0.1 });
});

describe('SeriesChart', () => {
  it('draws one line per series with units in the legend and the values under the cursor', () => {
    render(<SeriesChart xs={times} series={series} unit="N·m" cursor={2} title="Torque" />);
    expect(screen.getByText('crank_joint (N·m)')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Torque: crank_joint 20 N·m at 2\.0 s/ })).toBeInTheDocument();
  });

  it('renders nothing without series', () => {
    const { container } = render(<SeriesChart xs={times} series={[]} unit="rpm" cursor={0} title="x" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('TimelineDock', () => {
  it('scrubbing moves the shared cursor and the chart cursor follows', () => {
    render(
      <TimelineDock times={times}>
        {(view) => <SeriesChart xs={view.xs} series={series} unit="rpm" cursor={view.cursor} title="Speed" />}
      </TimelineDock>,
    );
    fireEvent.change(screen.getByTestId('timeline-scrub'), { target: { value: '3' } });
    expect(useDynamicsPlaybackStore.getState().cursorTime).toBe(3);
    expect(useDynamicsPlaybackStore.getState().time).toBe(3);
    expect(screen.getByTestId('timeline-readout')).toHaveTextContent('3 s');
    expect(screen.getByRole('img', { name: /crank_joint 30 rpm/ })).toBeInTheDocument();
  });

  it('hides the crank axis switch when no crank-angle series exists', () => {
    render(<TimelineDock times={times}>{() => null}</TimelineDock>);
    expect(screen.queryByTestId('timeline-axis')).toBeNull();
  });

  it('crank axis: charts use degrees and a seek on the chart sets the time', () => {
    render(
      <TimelineDock times={times} crankDegrees={crank}>
        {(view) => (
          <SeriesChart xs={view.xs} xUnit={view.xUnit} series={series} unit="rpm" cursor={view.cursor} onSeek={view.seek} title="Speed" />
        )}
      </TimelineDock>,
    );
    fireEvent.change(screen.getByTestId('timeline-axis'), { target: { value: 'crank' } });
    expect(useDynamicsPlaybackStore.getState().axis).toBe('crank');
    expect(screen.getByText(/^720 ° crank$/)).toBeInTheDocument();
    act(() => useDynamicsPlaybackStore.getState().setTime(1));
    expect(screen.getByRole('img', { name: /at 180 ° crank/ })).toBeInTheDocument();
    expect(interpolate(crank, times, 270)).toBeCloseTo(1.5);
  });

  it('a marker button seeks to its event', () => {
    render(
      <TimelineDock times={times} markers={[{ id: 'm1', time: 2.5, label: 'Piston hits head', kind: 'collision' }]}>
        {() => null}
      </TimelineDock>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Piston hits head/ }));
    expect(useDynamicsPlaybackStore.getState().cursorTime).toBe(2.5);
  });

  it('shows nothing when there is no run', () => {
    useDynamicsPlaybackStore.setState({ result: null });
    const { container } = render(<TimelineDock times={times}>{() => null}</TimelineDock>);
    expect(container).toBeEmptyDOMElement();
  });
});
