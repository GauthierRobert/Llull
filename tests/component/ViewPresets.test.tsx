/**
 * View preset buttons frame the scene (not a fixed origin / distance 10), so Front/Top/Right/Iso
 * work for mm-scale models. The r3f camera is faked through a mocked useThree.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import * as THREE from 'three';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { localDispatch } from '../helpers/storeTestHelpers';

const fake = vi.hoisted(() => ({
  camera: null as unknown,
  controls: null as unknown,
  invalidate: (): void => undefined,
}));

vi.mock('@react-three/fiber', () => ({
  useThree: () => fake,
}));

import { ViewPresetsInner, ViewPresetsOverlay } from '@ui/viewport/3d/ViewPresets';

describe('view presets', () => {
  const camera = new THREE.PerspectiveCamera();
  const orbit = { target: new THREE.Vector3(), update: (): void => undefined };

  beforeEach(() => {
    fake.camera = camera;
    fake.controls = orbit;
    camera.position.set(0, 0, 0);
    orbit.target.set(0, 0, 0);
    useStore.setState({ document: createEmptyDocument(), renderOrigin: [0, 0, 0] });
  });

  function mount(): void {
    render(
      <>
        <ViewPresetsInner />
        <ViewPresetsOverlay />
      </>,
    );
  }

  it('keeps origin / distance 10 for an empty scene', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Top view' }));
    expect(camera.position.distanceTo(orbit.target)).toBeCloseTo(10);
  });

  it('frames a large model: target at its centre, distance scaled to its size', () => {
    localDispatch('add_box', { size: [4000, 4000, 4000], position: [10000, 0, 0] });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Front view' }));
    expect(orbit.target.x).toBeCloseTo(10000);
    expect(camera.position.distanceTo(orbit.target)).toBeGreaterThan(4000);
  });
});
