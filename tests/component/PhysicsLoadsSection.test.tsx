import { resetStore } from '../helpers/componentEntities';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PhysicsLoadsSection } from '@ui/panels/PhysicsLoadsSection';
import { MechanismsPanel } from '@ui/panels/MechanismsPanel';
import { useLoadOverlayStore } from '@ui/store/loadOverlayStore';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { localDispatch } from '../helpers/storeTestHelpers';

/** Light-aircraft powerplant: a fixed crankcase, a two-blade 1.88 m propeller on the crankshaft, an O-360-class torque curve. */
function buildPowerplant(): { propBody: string; crankJoint: string } {
  const crankcase = localDispatch('add_box', { size: [800, 600, 600], position: [0, -300, 0] }).affected[0]!;
  localDispatch('add_rigid_body', { entityIds: [crankcase], name: 'crankcase', fixed: true });
  const blades = localDispatch('add_box', { size: [1880, 30, 120], position: [0, 200, 0] }).affected[0]!;
  const propBody = localDispatch('add_rigid_body', { entityIds: [blades], name: 'propeller', density: 2700 }).affected[0]!;
  const crankJoint = localDispatch('add_body_joint', {
    kind: 'revolute',
    child: propBody,
    anchor: [0, 200, 0],
    axis: [0, 1, 0],
    friction: 2,
  }).affected[0]!;
  localDispatch('add_motor', {
    joint: crankJoint,
    kind: 'torque_curve',
    curve: [
      [1000, 400],
      [2000, 460],
      [2700, 475],
    ],
    id: 'engine',
  });
  localDispatch('add_propeller', {
    joint: crankJoint,
    diameter: 1.88,
    thrustCoefficient: 0.09,
    powerCoefficient: 0.04,
    thrustDirection: [0, 1, 0],
    id: 'prop',
  });
  return { propBody, crankJoint };
}

describe('PhysicsLoadsSection', () => {
  beforeEach(() => {
    resetStore();
    useDynamicsPlaybackStore.setState({ result: null, time: 0, playing: false });
    useLoadOverlayStore.setState({ shown: true, labels: true, hiddenLayers: [], hiddenIds: [], focusedId: null });
  });

  it('renders nothing without rigid bodies', () => {
    const { container } = render(<PhysicsLoadsSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists every load the model carries with the setup behind it', () => {
    const { propBody, crankJoint } = buildPowerplant();
    render(<PhysicsLoadsSection />);
    expect(screen.getByTestId('loads-gravity')).toHaveTextContent('Gravity 9.81 m/s² along (0, 0, -1).');
    // 1.88 × 0.03 × 0.12 m³ aluminium = 18.3 kg
    expect(screen.getByTestId(`load-weight:${propBody}`)).toHaveTextContent(/propeller\s*W 179 N.*18\.3 kg · 2,700 kg\/m³/);
    expect(screen.getByTestId(`load-${crankJoint}`)).toHaveTextContent(/propeller ⟳ ground.*friction 2 N·m/);
    expect(screen.getByTestId('load-engine')).toHaveTextContent(/≤ 475 N·m.*peak 475 N·m @ 2,700 rpm · throttle 100 %/);
    expect(screen.getByTestId('load-prop')).toHaveTextContent(/T after a run.*Ø 1\.88 m · Ct 0\.09 · Cp 0\.04/);
    expect(screen.getByText(/moving 179 N/)).toBeInTheDocument();
  });

  it('shows and hides the overlay, a kind of load, and a single load', () => {
    buildPowerplant();
    render(<PhysicsLoadsSection />);
    fireEvent.click(screen.getByTestId('loads-layer-thrust'));
    expect(useLoadOverlayStore.getState().hiddenLayers).toEqual(['thrust']);
    expect(screen.getByTestId('loads-layer-thrust')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(within(screen.getByTestId('load-engine')).getByRole('button', { name: /Hide engine on propeller/ }));
    expect(useLoadOverlayStore.getState().hiddenIds).toEqual(['engine']);
    expect(within(screen.getByTestId('load-engine')).getByRole('button', { name: /Show engine on propeller/ })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('loads-shown'));
    expect(useLoadOverlayStore.getState().shown).toBe(false);
    expect(screen.getByTestId('loads-layer-gravity')).toBeDisabled();
  });

  it('emphasises a picked load and releases it on a second pick', () => {
    buildPowerplant();
    render(<PhysicsLoadsSection />);
    const row = within(screen.getByTestId('load-prop')).getAllByRole('button')[0]!;
    fireEvent.click(row);
    expect(useLoadOverlayStore.getState().focusedId).toBe('prop');
    expect(row).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(row);
    expect(useLoadOverlayStore.getState().focusedId).toBeNull();
  });

  it('puts the physics review first in the Mechanisms panel once the model has rigid bodies', () => {
    buildPowerplant();
    render(<MechanismsPanel />);
    const sections = screen.getAllByTestId(/^mechanisms-section-/).map((section) => section.dataset.testid);
    expect(sections.slice(0, 2)).toEqual(['mechanisms-section-loads', 'mechanisms-section-physics']);
  });
});
