import { resetStore } from '../helpers/componentEntities';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PhysicsSection } from '@ui/panels/PhysicsSection';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { localDispatch } from '../helpers/storeTestHelpers';

beforeAll(async () => {
  // ensurePhysicsEngine() finds the engine already installed and skips the browser download.
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
  beforeEach(() => {
    resetStore();
    useDynamicsPlaybackStore.setState({ result: null, time: 0, playing: false });
  });

  it('explains how to start when the document has no rigid bodies', () => {
    render(<PhysicsSection />);
    expect(screen.getByText('No rigid bodies yet.')).toBeInTheDocument();
  });

  it('lists bodies with their computed mass', () => {
    const { bodyId } = buildRotor();
    render(<PhysicsSection />);
    expect(screen.getByTestId(`physics-body-${bodyId}`)).toHaveTextContent(/flywheel.*4\.93\d* kg/);
  });

  it('simulates, shows the operating point and a speed chart, and starts playback', async () => {
    const { jointId } = buildRotor();
    render(<PhysicsSection />);
    fireEvent.change(screen.getByTestId('physics-duration'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('physics-simulate'));
    await waitFor(() => expect(screen.getByTestId('physics-results')).toBeInTheDocument(), { timeout: 20_000 });
    expect(screen.getByTestId('physics-results')).toHaveTextContent(new RegExp(`${jointId}.*rpm`));
    expect(screen.getByTestId('physics-chart')).toBeInTheDocument();
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

  it('disables Simulate and shows the problem when the model cannot run', () => {
    const disc = localDispatch('add_cylinder', { radius: 100, height: 20 }).affected[0]!;
    const bodyId = localDispatch('add_rigid_body', { entityIds: [disc] }).affected[0]!;
    localDispatch('delete_entities', { ids: [disc] });
    render(<PhysicsSection />);
    expect(screen.getByTestId('physics-problems')).toHaveTextContent(`body '${bodyId}' references missing entity`);
    expect(screen.getByTestId('physics-simulate')).toBeDisabled();
  });
});
