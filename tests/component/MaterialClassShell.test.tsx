/** VIS-M8f: a tinted solid keeps its surface (material or material class metalness / roughness); only the colour is replaced. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { cleanup, render } from '@testing-library/react';
import { ensureBvhSetup } from '@ui/viewport/3d/bvhSetup';
import { SolidMeshShell } from '@ui/viewport/3d/entities/SolidMeshShell';
import { useTintStore } from '@ui/store/tintStore';

ensureBvhSetup();

interface Captured {
  color: string;
  pbrOverride?: { color: string; metalness: number; roughness: number };
}
const captured = vi.hoisted(() => ({ input: undefined as Captured | undefined }));
vi.mock('@ui/viewport/3d/useMaterialProps', () => ({
  useMaterialProps: (input: Captured): Record<string, unknown> => {
    captured.input = input;
    return { color: input.color };
  },
}));

const entity = { id: 'box-1', position: [0, 0, 0], rotation: [0, 0, 0], color: '#111111' } as const;
const surface = { color: '#111111', metalness: 0.9, roughness: 0.3 };

function draw(tint: string | undefined): void {
  useTintStore.setState({ tints: tint === undefined ? new Map() : new Map([['box-1', tint]]) });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(
    <SolidMeshShell
      entity={entity}
      geometry={new THREE.BoxGeometry(1, 1, 1)}
      selected={false}
      onSelect={() => undefined}
      pbrMaterial={surface}
      boundsTree={false}
    />,
  );
}

describe('SolidMeshShell surface under a tint', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTintStore.setState({ tints: new Map() });
  });
  it('keeps the surface and takes the tint colour when a class colour tints the entity', () => {
    draw('#c0c4c8');
    expect(captured.input?.color).toBe('#c0c4c8');
    expect(captured.input?.pbrOverride).toEqual({ color: '#c0c4c8', metalness: 0.9, roughness: 0.3 });
  });
  it('passes the surface unchanged without a tint', () => {
    draw(undefined);
    expect(captured.input?.pbrOverride).toEqual(surface);
  });
});
