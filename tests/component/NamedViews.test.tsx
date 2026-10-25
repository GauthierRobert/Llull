import { resetOfflineStore } from '../helpers/storeTestHelpers';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { NamedViewsOverlay } from '@ui/viewport/3d/NamedViews';
import { viewpointCameraParams } from '@ui/viewport/3d/viewpointParams';
import type { CameraSnapshot } from '@ui/viewport/3d/cameraBridge';
import { execute } from '@core/commands/registry';

const MOCK_CAMERA_A: CameraSnapshot = { position: [5, 10, 15], target: [0, 0, 0] };

const mocks = vi.hoisted(() => ({ snapshot: null as CameraSnapshot | null }));
vi.mock('@ui/viewport/3d/cameraBridge', () => ({ getCameraSnapshot: () => mocks.snapshot }));

function withViewpoints(...names: string[]): void {
  let document = useStore.getState().document;
  for (const name of names)
    document = execute(document, 'save_viewpoint', {
      name,
      camera: { projection: 'perspective', eye: [0, -50, 10], direction: [0, 1, 0] },
    }).document;
  useStore.setState({ document });
}

const viewNames = (): string[] => {
  const review = useStore.getState().document.review;
  return (review?.viewpointOrder ?? []).map((id) => review?.viewpoints[id]?.name ?? '');
};

describe('viewpointCameraParams', () => {
  it('looks from the camera position at the orbit target, with +Z up', () => {
    expect(viewpointCameraParams(MOCK_CAMERA_A)).toEqual({
      projection: 'perspective',
      eye: [5, 10, 15],
      direction: [-5, -10, -15],
      up: [0, 0, 1],
    });
  });
  it('uses +Y up when looking straight along Z', () => {
    expect(viewpointCameraParams({ position: [1, 2, 9], target: [1, 2, 0] })?.up).toEqual([0, 1, 0]);
  });
  it('returns null when the eye is on the target', () => {
    expect(viewpointCameraParams({ position: [1, 2, 3], target: [1, 2, 3] })).toBeNull();
  });
});

describe('NamedViewsOverlay — toggle button', () => {
  beforeEach(() => {
    resetOfflineStore();
    mocks.snapshot = null;
  });
  it('renders a "Views" toggle button', () => {
    render(<NamedViewsOverlay />);
    expect(screen.getByRole('button', { name: /views/i })).toBeDefined();
  });
  it('panel is hidden on initial render', () => {
    render(<NamedViewsOverlay />);
    expect(screen.queryByRole('region', { name: /named views panel/i })).toBeNull();
  });
  it('clicking the toggle shows the panel', () => {
    render(<NamedViewsOverlay />);
    fireEvent.click(screen.getByRole('button', { name: /views/i }));
    expect(screen.getByRole('region', { name: /named views panel/i })).toBeDefined();
  });
  it('toggle button has aria-expanded=false initially and true when expanded', () => {
    render(<NamedViewsOverlay />);
    const btn = screen.getByRole('button', { name: /views/i });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('NamedViewsOverlay — save row (save_viewpoint)', () => {
  beforeEach(() => {
    resetOfflineStore();
    mocks.snapshot = MOCK_CAMERA_A;
  });
  function open(): HTMLInputElement {
    render(<NamedViewsOverlay />);
    fireEvent.click(screen.getByRole('button', { name: /views/i }));
    return screen.getByRole('textbox', { name: /new view name/i }) as HTMLInputElement;
  }
  it('shows an input and a Save button when expanded', () => {
    open();
    expect(screen.getByRole('button', { name: /save current camera/i })).toBeDefined();
  });
  it('Save dispatches save_viewpoint with the live camera and clears the input', () => {
    const input = open();
    fireEvent.change(input, { target: { value: '  Front Close ' } });
    fireEvent.click(screen.getByRole('button', { name: /save current camera/i }));
    const viewpoint = useStore.getState().document.review?.viewpoints['vp-1'];
    expect(viewpoint?.name).toBe('Front Close');
    expect(viewpoint?.camera).toMatchObject({ projection: 'perspective', eye: [5, 10, 15] });
    expect(viewpoint?.camera.direction[0]).toBeCloseTo(-5 / Math.hypot(5, 10, 15), 12);
    expect(input.value).toBe('');
  });
  it('Enter saves; an empty name or a camera that is not ready saves nothing', () => {
    const input = open();
    fireEvent.click(screen.getByRole('button', { name: /save current camera/i }));
    expect(viewNames()).toEqual([]);
    fireEvent.change(input, { target: { value: 'A' } });
    mocks.snapshot = null;
    fireEvent.click(screen.getByRole('button', { name: /save current camera/i }));
    expect(viewNames()).toEqual([]);
    mocks.snapshot = MOCK_CAMERA_A;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(viewNames()).toEqual(['A']);
  });
  it('saves in creation order', () => {
    const input = open();
    for (const name of ['A', 'B']) {
      fireEvent.change(input, { target: { value: name } });
      fireEvent.click(screen.getByRole('button', { name: /save current camera/i }));
    }
    expect(viewNames()).toEqual(['A', 'B']);
  });
});

describe('NamedViewsOverlay — saved views list', () => {
  beforeEach(() => {
    resetOfflineStore();
    mocks.snapshot = MOCK_CAMERA_A;
  });
  it('shows "No saved views yet." when the document has no viewpoint', () => {
    render(<NamedViewsOverlay />);
    fireEvent.click(screen.getByRole('button', { name: /views/i }));
    expect(screen.getByText(/no saved views yet/i)).toBeDefined();
  });
  it('lists the document viewpoints and their count', () => {
    withViewpoints('Iso', 'Top Close');
    render(<NamedViewsOverlay />);
    fireEvent.click(screen.getByRole('button', { name: /views \(2\)/i }));
    expect(screen.getByRole('button', { name: /restore view iso/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /restore view top close/i })).toBeDefined();
  });
  it('restoring dispatches apply_viewpoint: the document camera looks the way the viewpoint does', () => {
    withViewpoints('Iso');
    const before = useStore.getState().document.camera;
    render(<NamedViewsOverlay />);
    fireEvent.click(screen.getByRole('button', { name: /views \(1\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /restore view iso/i }));
    const camera = useStore.getState().document.camera;
    expect(camera).not.toBe(before);
    expect(camera.polar).toBeCloseTo(Math.PI / 2, 9);
    expect(camera.azimuth).toBeCloseTo(Math.PI, 9);
  });
  it('clicking × dispatches delete_viewpoint', () => {
    withViewpoints('Side', 'Keep');
    render(<NamedViewsOverlay />);
    fireEvent.click(screen.getByRole('button', { name: /views \(2\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /delete view side/i }));
    expect(viewNames()).toEqual(['Keep']);
  });
  it('a viewpoint used by an issue stays when deleted (the command refuses)', () => {
    withViewpoints('Side');
    useStore.setState({
      document: execute(useStore.getState().document, 'create_review_issue', { title: 't', viewpointIds: ['vp-1'] }).document,
    });
    render(<NamedViewsOverlay />);
    fireEvent.click(screen.getByRole('button', { name: /views \(1\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /delete view side/i }));
    expect(viewNames()).toEqual(['Side']);
  });
});
