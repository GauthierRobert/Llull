import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NavigationModeControl } from '@ui/viewport/3d/navigation/NavigationModeControl';
import { RealismControl } from '@ui/viewport/3d/RealismControl';
import { resolveEdgeLines, settingsFor } from '@ui/viewport/3d/useRenderQuality';
import { useNavigationStore } from '@ui/store/navigationStore';
import { EDGES_STORAGE_KEY, REALISM_STORAGE_KEY, sanitizeEdgePreference, sanitizeRealism, useRealismStore } from '@ui/store/realismStore';

beforeEach(() => {
  useNavigationStore.setState({ mode: 'orbit' });
  useRealismStore.setState({ realism: 'standard', edges: 'auto' });
  localStorage.clear();
});

describe('navigation mode toggle', () => {
  it('switches between Orbit, Walk and Fly', () => {
    render(<NavigationModeControl />);
    expect(screen.getByLabelText('Orbit')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByLabelText('Walk'));
    expect(useNavigationStore.getState().mode).toBe('walk');
    expect(screen.getByLabelText('Walk')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByLabelText('Fly'));
    expect(useNavigationStore.getState().mode).toBe('fly');
    fireEvent.click(screen.getByLabelText('Orbit'));
    expect(useNavigationStore.getState().mode).toBe('orbit');
  });
});

describe('realism tiers', () => {
  it('Standard keeps the scene-size quality tier unchanged', () => {
    expect(settingsFor('medium', 'standard')).toMatchObject({
      tier: 'medium',
      shadowMapSize: 1024,
      keyShadows: true,
      plantShadowMaxLod: 1,
    });
    expect(settingsFor('low', 'standard').softShadowSamples).toBe(0);
  });
  it('Draft drops every shadow whatever the scene size', () => {
    for (const tier of ['high', 'medium', 'low'] as const) {
      expect(settingsFor(tier, 'draft')).toMatchObject({
        keyShadows: false,
        contactShadowsEnabled: false,
        softShadowSamples: 0,
        plantShadowMaxLod: -1,
      });
    }
  });
  it('High forces the richest shadows and lets every plant LOD cast', () => {
    for (const tier of ['high', 'medium', 'low'] as const) {
      expect(settingsFor(tier, 'high')).toMatchObject({
        keyShadows: true,
        contactShadowsEnabled: true,
        shadowMapSize: 4096,
        softShadowSamples: 24,
        plantShadowMaxLod: 2,
      });
    }
  });
  it('returns a stable reference per tier pair', () => {
    expect(settingsFor('low', 'high')).toBe(settingsFor('high', 'high'));
    expect(settingsFor('low', 'standard')).toBe(settingsFor('low', 'standard'));
  });
  it('sanitises stored values', () => {
    expect(sanitizeRealism('high')).toBe('high');
    expect(sanitizeRealism('ultra')).toBe('standard');
    expect(sanitizeRealism(undefined)).toBe('standard');
  });
  it('the selector sets the tier and persists it', () => {
    render(<RealismControl />);
    fireEvent.change(screen.getByLabelText('Realism'), { target: { value: 'high' } });
    expect(useRealismStore.getState().realism).toBe('high');
    expect(localStorage.getItem(REALISM_STORAGE_KEY)).toBe('"high"');
  });
});

describe('ambient occlusion', () => {
  it('is on in High only, whatever the scene size', () => {
    for (const tier of ['high', 'medium', 'low'] as const) {
      expect(settingsFor(tier, 'high').ambientOcclusion).toBe(true);
      expect(settingsFor(tier, 'standard').ambientOcclusion).toBe(false);
      expect(settingsFor(tier, 'draft').ambientOcclusion).toBe(false);
    }
  });
});

describe('feature edges', () => {
  it('are on by default in High only', () => {
    for (const tier of ['high', 'medium', 'low'] as const) {
      expect(settingsFor(tier, 'high').edgeLines).toBe(true);
      expect(settingsFor(tier, 'standard').edgeLines).toBe(false);
      expect(settingsFor(tier, 'draft').edgeLines).toBe(false);
    }
  });
  it('the preference overrides the tier default either way', () => {
    expect(resolveEdgeLines(settingsFor('low', 'standard'), 'auto')).toBe(false);
    expect(resolveEdgeLines(settingsFor('low', 'standard'), 'on')).toBe(true);
    expect(resolveEdgeLines(settingsFor('low', 'high'), 'auto')).toBe(true);
    expect(resolveEdgeLines(settingsFor('low', 'high'), 'off')).toBe(false);
  });
  it('sanitises a stored preference', () => {
    expect(sanitizeEdgePreference('off')).toBe('off');
    expect(sanitizeEdgePreference('sometimes')).toBe('auto');
  });
  it('the Edges toggle follows the tier, overrides it and persists the override', () => {
    render(<RealismControl />);
    const toggle = screen.getByLabelText('Edges');
    expect(toggle).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Realism'), { target: { value: 'high' } });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(useRealismStore.getState().edges).toBe('off');
    expect(localStorage.getItem(EDGES_STORAGE_KEY)).toBe('"off"');
    expect(toggle).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Realism'), { target: { value: 'standard' } });
    fireEvent.click(toggle);
    expect(useRealismStore.getState().edges).toBe('on');
    expect(toggle).toBeChecked();
  });
});
