import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { CAMERA_FOV_DEGREES, computeFitFraming } from '@ui/viewport/3d/fitBounds';
import { localDispatch } from '../helpers/storeTestHelpers';

describe('computeFitFraming', () => {
  beforeEach(() => {
    useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  });

  it('returns null when no id exists', () => {
    expect(computeFitFraming(useStore.getState().document, ['nope'])).toBeNull();
  });

  it('scales the camera distance with the real entity size', () => {
    const small = localDispatch('add_box', { size: [2, 2, 2] }).affected[0]!;
    const big = localDispatch('add_box', { size: [4000, 4000, 4000] }).affected[0]!;
    const doc = useStore.getState().document;
    const smallFit = computeFitFraming(doc, [small])!;
    const bigFit = computeFitFraming(doc, [big])!;
    expect(bigFit.distance).toBeGreaterThan(smallFit.distance * 100);
  });

  it('centres on the merged extent of several entities', () => {
    const a = localDispatch('add_box', { size: [2, 2, 2], position: [0, 0, 0] }).affected[0]!;
    const b = localDispatch('add_box', { size: [2, 2, 2], position: [10, 0, 0] }).affected[0]!;
    const fit = computeFitFraming(useStore.getState().document, [a, b])!;
    // boxes are centred on `position`: extent x spans -1..11
    expect(fit.center[0]).toBeCloseTo(5);
  });

  it('fits the bounding sphere inside the real camera FOV, more distant for portrait viewports', () => {
    const id = localDispatch('add_box', { size: [10, 10, 10] }).affected[0]!;
    const doc = useStore.getState().document;
    const radius = Math.hypot(10, 10, 10) / 2;
    const half = (CAMERA_FOV_DEGREES / 2) * (Math.PI / 180);
    const landscape = computeFitFraming(doc, [id], 1.6)!;
    // the sphere subtends less than the half-angle => it is fully visible
    expect(Math.asin(radius / landscape.distance)).toBeLessThan(half);
    const portrait = computeFitFraming(doc, [id], 0.5)!;
    expect(portrait.distance).toBeGreaterThan(landscape.distance);
  });

  it('frames a tiny part at its real size instead of a fixed minimum radius', () => {
    const id = localDispatch('add_box', { size: [0.02, 0.02, 0.02] }).affected[0]!;
    const fit = computeFitFraming(useStore.getState().document, [id])!;
    expect(fit.distance).toBeLessThan(0.2);
  });
});
