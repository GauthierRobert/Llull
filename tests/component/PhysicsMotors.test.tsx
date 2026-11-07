import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PhysicsSection } from '@ui/panels/PhysicsSection';
import { useStore } from '@ui/store';
import { useFocusStore } from '@ui/store/focusStore';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { resetStore } from '../helpers/componentEntities';
import { answerDispatch, localDispatch, spyDispatch } from '../helpers/storeTestHelpers';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const SHEET = {
  nominalVoltageV: 48,
  terminalResistanceOhm: 1.13,
  terminalInductanceH: 0.00033,
  torqueConstantNmPerA: 0.0603,
  rotorInertiaKgM2: 0.0000137,
  noLoadCurrentA: 0.0686,
  stallTorqueNm: 2.56,
  noLoadSpeedRpm: 7590,
  speedConstantRpmPerV: 158,
};
const SOURCE = { name: 'maxon RE 40 catalogue', grade: 'A' };

/** A flywheel on a revolute shaft, no gravity. */
function buildShaft(): string {
  const disc = localDispatch('add_cylinder', { radius: 20, height: 10, axis: [0, 1, 0] }).affected[0]!;
  const bodyId = localDispatch('add_rigid_body', { entityIds: [disc], name: 'rotor' }).affected[0]!;
  const jointId = localDispatch('add_body_joint', { kind: 'revolute', child: bodyId, anchor: [0, 0, 0], axis: [0, 1, 0] }).affected[0]!;
  localDispatch('set_gravity', { gravity: [0, 0, 0] });
  return jointId;
}

function addDcMotor(joint: string, extra: Record<string, unknown> = {}): string {
  return localDispatch('add_motor', { joint, kind: 'dc', datasheet: SHEET, source: SOURCE, ...extra }).affected[0]!;
}

const originalDispatch = useStore.getState().dispatch;

describe('Physics panel: motors, drives and profiles', () => {
  beforeEach(() => {
    resetStore();
    useDynamicsPlaybackStore.setState({ result: null, time: 0, playing: false });
    useFocusStore.setState({ focus: null });
  });
  afterEach(() => useStore.setState({ dispatch: originalDispatch }));

  it('shows the stored datasheet of a dc motor, never as a torque curve', () => {
    const motor = addDcMotor(buildShaft(), { gearhead: { ratio: 10, efficiency: 0.9 } });
    render(<PhysicsSection />);
    expect(screen.getByTestId(`physics-motor-row-${motor}`)).toHaveTextContent(/DC · 48 V · 10:1/);
    expect(screen.getByTestId(`physics-motor-row-${motor}`)).not.toHaveTextContent(/curve/);
    const facts = screen.getByTestId(`motor-facts-${motor}`);
    expect(facts).toHaveTextContent('Kinddatasheet DC motor');
    expect(facts).toHaveTextContent('Rated voltage48 V');
    expect(facts).toHaveTextContent('Terminal resistance1.13 Ω');
    expect(facts).toHaveTextContent('Torque constant kt0.0603 N·m/A');
    expect(facts).toHaveTextContent('Speed constant kv158 rpm/V');
    expect(facts).toHaveTextContent('Stall torque2.56 N·m');
    expect(facts).toHaveTextContent('No-load speed7,590 rpm');
    expect(facts).toHaveTextContent('Gearhead10:1, efficiency 0.9');
    expect(facts).toHaveTextContent('maxon RE 40 catalogue (grade A)');
  });

  it('says an undriven dc motor is an open circuit', () => {
    const motor = addDcMotor(buildShaft());
    render(<PhysicsSection />);
    expect(screen.getByTestId(`motor-open-${motor}`)).toHaveTextContent(/terminals are open/);
    expect(screen.queryByTestId(`drive-facts-${motor}`)).toBeNull();
  });

  it('shows the drive (mode, limit) and its motion profile with segment start times', () => {
    const motor = addDcMotor(buildShaft());
    localDispatch('add_motion_profile', {
      id: 'ramp',
      quantity: 'voltage',
      unit: 'V',
      segments: [
        { kind: 'move', law: 'linear', to: 24, duration: 0.5 },
        { kind: 'dwell', duration: 1 },
      ],
    });
    localDispatch('set_motor_drive', { motor, mode: 'voltage', profile: 'ramp', currentLimitA: 20 });
    render(<PhysicsSection />);
    const drive = screen.getByTestId(`drive-facts-${motor}`);
    expect(drive).toHaveTextContent('Modevoltage');
    expect(drive).toHaveTextContent('Profileramp');
    expect(drive).toHaveTextContent('Current limit20 A');
    const profile = screen.getByTestId('profile-ramp');
    expect(profile).toHaveTextContent('voltage in V');
    expect(profile).toHaveTextContent('t 0 s · move to 24 V (linear, 0.5 s)');
    expect(profile).toHaveTextContent('t 0.5 s · dwell 1 s');
  });

  it('lists a profile no drive uses, and labels the speed governor by its own parameters', () => {
    const joint = buildShaft();
    localDispatch('add_motion_profile', { id: 'idle', quantity: 'torque', unit: 'N*m', segments: [{ kind: 'dwell', duration: 2 }] });
    const governor = localDispatch('add_motor', { joint, kind: 'speed', rpm: 600, maxTorque: 3 }).affected[0]!;
    render(<PhysicsSection />);
    expect(screen.getByTestId(`motor-facts-${governor}`)).toHaveTextContent('Held speed600 rpm');
    expect(screen.getByTestId(`motor-facts-${governor}`)).toHaveTextContent('none: the bound is a guess');
    expect(screen.getByTestId('physics-profiles')).toHaveTextContent('idle');
  });

  it('a torque-curve motor keeps its curve summary', () => {
    const motor = localDispatch('add_motor', { joint: buildShaft(), kind: 'torque_curve', torque: 20 }).affected[0]!;
    render(<PhysicsSection />);
    expect(screen.getByTestId(`motor-facts-${motor}`)).toHaveTextContent('Peak torque20 N·m');
  });

  it('picking a motor row focuses the model on the bodies of its joint', () => {
    const motor = addDcMotor(buildShaft());
    render(<PhysicsSection />);
    fireEvent.click(screen.getByTestId(`physics-motor-focus-${motor}`));
    const focus = useFocusStore.getState().focus;
    expect(focus?.key).toBe(`mechanisms:motor:${motor}`);
    expect(focus?.entityIds.length).toBe(1);
    expect(focus?.label).toMatch(/DC · 48 V/);
  });

  it('Set drive sends set_motor_drive with the typed voltage and keeps the current limit', () => {
    const motor = addDcMotor(buildShaft());
    localDispatch('set_motor_drive', { motor, mode: 'voltage', volts: 12, currentLimitA: 8 });
    const spy = spyDispatch();
    render(<PhysicsSection />);
    fireEvent.change(screen.getByTestId(`motor-volts-${motor}`), { target: { value: '24' } });
    fireEvent.click(screen.getByTestId(`motor-volts-apply-${motor}`));
    expect(spy).toHaveBeenCalledWith(
      'set_motor_drive',
      { motor, mode: 'voltage', volts: 24, currentLimitA: 8 },
      expect.objectContaining({ onResult: expect.any(Function) }),
    );
  });

  it('Set drive on the real store replaces the drive of the document', async () => {
    const motor = addDcMotor(buildShaft());
    render(<PhysicsSection />);
    fireEvent.change(screen.getByTestId(`motor-volts-${motor}`), { target: { value: '36' } });
    fireEvent.click(screen.getByTestId(`motor-volts-apply-${motor}`));
    await waitFor(() => expect(useStore.getState().document.dynamics?.drives?.[motor]).toMatchObject({ mode: 'voltage', volts: 36 }));
  });

  it('blank or non-numeric voltage dispatches nothing and says why', () => {
    const motor = addDcMotor(buildShaft());
    const spy = spyDispatch();
    render(<PhysicsSection />);
    fireEvent.click(screen.getByTestId(`motor-volts-apply-${motor}`));
    fireEvent.change(screen.getByTestId(`motor-volts-${motor}`), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId(`motor-volts-apply-${motor}`));
    expect(spy).not.toHaveBeenCalled();
    expect(within(screen.getByTestId(`motor-voltage-${motor}`)).getByRole('alert')).toHaveTextContent(
      'Enter the terminal voltage in volts.',
    );
  });

  it('a command refusal is shown, not swallowed', () => {
    const motor = addDcMotor(buildShaft());
    render(<PhysicsSection />);
    answerDispatch({ summary: 'set_motor_drive rejected: boom', changed: false });
    fireEvent.change(screen.getByTestId(`motor-volts-${motor}`), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId(`motor-volts-apply-${motor}`));
    expect(screen.getByRole('alert')).toHaveTextContent('set_motor_drive rejected: boom');
  });

  it('a velocity-loop drive is not replaced silently: a note names it and Replace asks first', () => {
    const motor = addDcMotor(buildShaft());
    localDispatch('add_motion_profile', {
      id: 'spin',
      quantity: 'velocity',
      unit: 'rpm',
      start: 100,
      segments: [{ kind: 'dwell', duration: 1 }],
    });
    localDispatch('set_motor_drive', {
      motor,
      mode: 'velocity',
      profile: 'spin',
      tune: { bandwidthHz: 5, dampingRatio: 1 },
      sampleHz: 1000,
    });
    const spy = spyDispatch();
    render(<PhysicsSection />);
    expect(screen.getByTestId(`motor-replace-note-${motor}`)).toHaveTextContent('velocity loop drive (profile spin)');
    expect(screen.queryByTestId(`motor-volts-${motor}`)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(`motor-replace-${motor}`));
    fireEvent.change(screen.getByTestId(`motor-volts-${motor}`), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId(`motor-volts-apply-${motor}`));
    expect(spy).toHaveBeenCalledWith('set_motor_drive', { motor, mode: 'voltage', volts: 12 }, expect.anything());
  });

  it('a voltage-profile drive also asks before it is replaced, and a plain voltage drive does not', () => {
    const motor = addDcMotor(buildShaft());
    localDispatch('add_motion_profile', {
      id: 'ramp',
      quantity: 'voltage',
      unit: 'V',
      segments: [{ kind: 'move', law: 'linear', to: 24, duration: 0.5 }],
    });
    localDispatch('set_motor_drive', { motor, mode: 'voltage', profile: 'ramp' });
    render(<PhysicsSection />);
    expect(screen.getByTestId(`motor-replace-note-${motor}`)).toHaveTextContent('voltage drive (profile ramp)');
    act(() => void localDispatch('set_motor_drive', { motor, mode: 'voltage', volts: 9 }));
    expect(screen.queryByTestId(`motor-replace-note-${motor}`)).toBeNull();
  });

  it('the voltage input follows the drive when it changes elsewhere (undo, live sync, CLI)', () => {
    const motor = addDcMotor(buildShaft());
    localDispatch('set_motor_drive', { motor, mode: 'voltage', volts: 12 });
    render(<PhysicsSection />);
    expect(screen.getByTestId(`motor-volts-${motor}`)).toHaveValue(12);
    act(() => void localDispatch('set_motor_drive', { motor, mode: 'voltage', volts: 30 }));
    expect(screen.getByTestId(`motor-volts-${motor}`)).toHaveValue(30);
  });

  it('a loaded geared motor reports a real torque at the end of the run', async () => {
    const disc = localDispatch('add_cylinder', { radius: 20, height: 10, axis: [0, 1, 0] }).affected[0]!;
    const body = localDispatch('add_rigid_body', { entityIds: [disc], name: 'rotor' }).affected[0]!;
    const joint = localDispatch('add_body_joint', { kind: 'revolute', child: body, anchor: [0, 0, 0], axis: [0, 1, 0], damping: 0.05 })
      .affected[0]!;
    localDispatch('set_gravity', { gravity: [0, 0, 0] });
    const motor = addDcMotor(joint, { gearhead: { ratio: 4, efficiency: 0.9 } });
    localDispatch('set_motor_drive', { motor, mode: 'voltage', volts: 24 });
    render(<PhysicsSection />);
    fireEvent.change(screen.getByTestId('physics-duration'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByTestId('physics-simulate'));
    await waitFor(() => expect(screen.getByTestId('physics-results')).toHaveTextContent(new RegExp(`${motor}`)), { timeout: 30_000 });
    expect(screen.getByTestId('physics-results')).toHaveTextContent(new RegExp(motor + '[ ]*[1-9][0-9.]* N·m at end'));
  }, 40_000);

  it('a simulated run with a voltage-driven dc motor shows its torque row and the read-only energy ledger', async () => {
    const motor = addDcMotor(buildShaft());
    localDispatch('set_motor_drive', { motor, mode: 'voltage', volts: 48 });
    render(<PhysicsSection />);
    fireEvent.change(screen.getByTestId('physics-duration'), { target: { value: '0.2' } });
    fireEvent.click(screen.getByTestId('physics-simulate'));
    await waitFor(() => expect(screen.getByTestId('physics-ledger')).toBeInTheDocument(), { timeout: 30_000 });
    const ledger = screen.getByTestId('physics-ledger');
    expect(ledger).toHaveTextContent(/copper/);
    expect(ledger).toHaveTextContent(/input/);
    const run = useDynamicsPlaybackStore.getState().result as { ledger?: { closure: string } } | null;
    expect(run?.ledger?.closure).toMatch(/^(pass|warn|fail)$/);
    expect(screen.getByTestId('physics-ledger-closure')).toHaveAttribute('data-closure', run?.ledger?.closure);
    expect(screen.getByTestId('physics-results')).toHaveTextContent(new RegExp(`${motor}.*N·m`));
  }, 40_000);

  it('without datasheet motors a run shows no ledger', async () => {
    const joint = buildShaft();
    localDispatch('add_motor', { joint, kind: 'torque_curve', torque: 1 });
    render(<PhysicsSection />);
    fireEvent.change(screen.getByTestId('physics-duration'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByTestId('physics-simulate'));
    await waitFor(() => expect(screen.getByTestId('physics-results')).toBeInTheDocument(), { timeout: 30_000 });
    expect(screen.queryByTestId('physics-ledger')).toBeNull();
  }, 40_000);
});
