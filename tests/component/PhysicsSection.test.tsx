import { resetStore } from '../helpers/componentEntities';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PhysicsSection } from '@ui/panels/PhysicsSection';
import { useStore } from '@ui/store';
import { useAnimationExportStore } from '@ui/store/animationExportStore';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { execute } from '@core/commands/registry';
import { getPhysicsEngine, setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import type { PhysicsJobRequest } from '@app/physicsJob';
import { setPhysicsWorkerFactory } from '@ui/services/physicsRun';
import { connectFakeBackend } from '../helpers/fakeBackend';
import { inProcessPhysicsWorker } from '../helpers/inProcessPhysicsWorker';
import { localDispatch } from '../helpers/storeTestHelpers';

beforeAll(async () => {
  // the engine the fake backend (connectFakeBackend) runs simulate_motion with; the renderer itself loads none.
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

/** A steel flywheel on a shaft, driven by a constant torque and loaded by a propeller. */
function buildRotor(): { bodyId: string; jointId: string } {
  const disc = localDispatch('add_cylinder', { radius: 100, height: 20, axis: [0, 1, 0] }).affected[0]!;
  const bodyId = localDispatch('add_rigid_body', { entityIds: [disc], name: 'flywheel' }).affected[0]!;
  const jointId = localDispatch('add_body_joint', { kind: 'revolute', child: bodyId, anchor: [0, 0, 0], axis: [0, 1, 0] }).affected[0]!;
  localDispatch('add_motor', { joint: jointId, kind: 'torque_curve', torque: 20 });
  localDispatch('add_propeller', { joint: jointId, diameter: 1, thrustCoefficient: 0.1, powerCoefficient: 0.05 });
  return { bodyId, jointId };
}

describe('PhysicsSection', () => {
  let disconnect: (() => void) | null = null;
  beforeEach(() => {
    resetStore();
    useDynamicsPlaybackStore.setState({ result: null, time: 0, playing: false });
  });
  afterEach(() => {
    disconnect?.();
    disconnect = null;
  });

  it('explains how to start when the document has no rigid bodies', () => {
    render(<PhysicsSection />);
    expect(screen.getByText('No rigid bodies yet.')).toBeInTheDocument();
  });

  it('offers Export animation before any run and opens the dialog flag', () => {
    buildRotor();
    render(<PhysicsSection />);
    fireEvent.click(screen.getByTestId('physics-export'));
    expect(useAnimationExportStore.getState().open).toBe(true);
  });

  it('lists bodies with their computed mass', () => {
    const { bodyId } = buildRotor();
    render(<PhysicsSection />);
    expect(screen.getByTestId(`physics-body-${bodyId}`)).toHaveTextContent(/flywheel.*4\.93\d* kg/);
  });

  it('simulates, shows the operating point and a speed chart, and starts playback', async () => {
    const { jointId } = buildRotor();
    disconnect = connectFakeBackend();
    render(<PhysicsSection />);
    fireEvent.change(screen.getByTestId('physics-duration'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('physics-simulate'));
    await waitFor(() => expect(screen.getByTestId('physics-results')).toBeInTheDocument(), { timeout: 20_000 });
    expect(screen.getByTestId('physics-results')).toHaveTextContent(new RegExp(`${jointId}.*rpm`));
    expect(screen.getByTestId('physics-chart')).toBeInTheDocument();
    expect(screen.getByTestId('physics-energy-chart')).toBeInTheDocument();
    expect(screen.getByTestId('physics-energy')).toHaveTextContent(/dissipated .* J · (balance error|drift|lossy)/);
    const { result, playing } = useDynamicsPlaybackStore.getState();
    expect(result?.poses?.times.length).toBeGreaterThan(100);
    expect(playing).toBe(true);
    fireEvent.click(screen.getByTestId('physics-play'));
    expect(useDynamicsPlaybackStore.getState().playing).toBe(false);
    fireEvent.change(screen.getByTestId('physics-scrub'), { target: { value: '1.5' } });
    expect(useDynamicsPlaybackStore.getState().time).toBeCloseTo(1.5, 9);
    fireEvent.change(screen.getByTestId('physics-speed'), { target: { value: '0.01' } });
    expect(useDynamicsPlaybackStore.getState().speed).toBe(0.01);
    fireEvent.click(screen.getByTestId('physics-clear'));
    expect(useDynamicsPlaybackStore.getState().result).toBeNull();
  });

  it('mentions the static propeller model only when the model has a propeller', async () => {
    const arm = localDispatch('add_box', { size: [300, 20, 20] }).affected[0]!;
    const bodyId = localDispatch('add_rigid_body', { entityIds: [arm], name: 'pendulum' }).affected[0]!;
    localDispatch('add_body_joint', { kind: 'revolute', child: bodyId, anchor: [0, 10, 10], axis: [0, 1, 0] });
    disconnect = connectFakeBackend();
    render(<PhysicsSection />);
    fireEvent.change(screen.getByTestId('physics-duration'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('physics-simulate'));
    await waitFor(() => expect(screen.getByTestId('physics-engine-note')).toBeInTheDocument(), { timeout: 20_000 });
    expect(screen.getByTestId('physics-engine-note')).not.toHaveTextContent(/propeller/);
    expect(screen.getByTestId('physics-energy')).not.toHaveTextContent(/-0(?![.\d])/);
  });

  it('online, runs simulate_motion on the server and plays its result', async () => {
    const { jointId } = buildRotor();
    const serverRun = execute(useStore.getState().document, 'simulate_motion', { duration: 1, detail: 'poses' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ summary: 'server run', affected: [], isError: false, data: serverRun.data, canUndo: true, canRedo: false }),
        ),
      );
    setPhysicsEngine(null);
    useStore.setState({ liveStatus: 'connected' });
    try {
      render(<PhysicsSection />);
      fireEvent.click(screen.getByTestId('physics-simulate'));
      await waitFor(() => expect(screen.getByTestId('physics-results')).toHaveTextContent(new RegExp(`${jointId}.*rpm`)));
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toMatch(/\/command$/);
      expect(JSON.parse(String(init?.body))).toMatchObject({ name: 'simulate_motion', params: { detail: 'poses' } });
      expect(getPhysicsEngine()).toBeNull();
      expect(useDynamicsPlaybackStore.getState().result?.poses?.times.length).toBeGreaterThan(10);
    } finally {
      fetchSpy.mockRestore();
      useStore.setState({ liveStatus: 'disconnected' });
      setPhysicsEngine(await createMujocoPhysics());
    }
  });

  it('opening the panel warms the physics worker once (the engine is then in memory if the backend goes away)', () => {
    buildRotor();
    const warmUps = { count: 0 };
    setPhysicsWorkerFactory(() => inProcessPhysicsWorker([], warmUps));
    try {
      const first = render(<PhysicsSection />);
      first.unmount();
      render(<PhysicsSection />);
      expect(warmUps.count).toBe(1);
    } finally {
      setPhysicsWorkerFactory(null);
    }
  });

  it('disconnected, simulates in the in-page physics worker and plays its result, without calling the backend', async () => {
    const { jointId } = buildRotor();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const jobs: PhysicsJobRequest[] = [];
    setPhysicsWorkerFactory(() => inProcessPhysicsWorker(jobs));
    try {
      render(<PhysicsSection />);
      fireEvent.click(screen.getByTestId('physics-simulate'));
      await waitFor(() => expect(screen.getByTestId('physics-results')).toHaveTextContent(new RegExp(`${jointId}.*rpm`)));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(jobs.map((job) => [job.command, job.params['detail']])).toEqual([['simulate_motion', 'poses']]);
      expect(useDynamicsPlaybackStore.getState().result?.poses?.times.length).toBeGreaterThan(10);
    } finally {
      fetchSpy.mockRestore();
      setPhysicsWorkerFactory(null);
    }
  });

  it('disconnected and without workers (this jsdom has none), says what is missing and loads no engine in the page', async () => {
    buildRotor();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    setPhysicsEngine(null);
    try {
      render(<PhysicsSection />);
      fireEvent.click(screen.getByTestId('physics-simulate'));
      await waitFor(() => expect(screen.getByText(/simulate_motion needs the llull backend/)).toBeInTheDocument());
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(getPhysicsEngine()).toBeNull();
      expect(useDynamicsPlaybackStore.getState().result).toBeNull();
    } finally {
      fetchSpy.mockRestore();
      setPhysicsEngine(await createMujocoPhysics());
    }
  });

  it('online, reports a server failure instead of a result', async () => {
    buildRotor();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    useStore.setState({ liveStatus: 'connected' });
    try {
      render(<PhysicsSection />);
      fireEvent.click(screen.getByTestId('physics-simulate'));
      await waitFor(() => expect(screen.getByText(/simulate_motion failed on the server: .*HTTP 500/)).toBeInTheDocument());
      expect(useDynamicsPlaybackStore.getState().result).toBeNull();
    } finally {
      fetchSpy.mockRestore();
      useStore.setState({ liveStatus: 'disconnected' });
    }
  });

  it('disables Simulate and shows the problem when the model cannot run', () => {
    const disc = localDispatch('add_cylinder', { radius: 100, height: 20 }).affected[0]!;
    const bodyId = localDispatch('add_rigid_body', { entityIds: [disc] }).affected[0]!;
    localDispatch('delete_entities', { ids: [disc] });
    render(<PhysicsSection />);
    expect(screen.getByTestId('physics-problems')).toHaveTextContent(`body '${bodyId}' references missing entity`);
    expect(screen.getByTestId('physics-simulate')).toBeDisabled();
  });
});
