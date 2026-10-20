import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SpaceMouseControl } from '@ui/input/SpaceMouseControl';
import { SPACE_MOUSE_STORAGE_KEY, useSpaceMouseStore } from '@ui/store/spaceMouseStore';
import { DEFAULT_SETTINGS } from '@ui/input/spaceMouseMapping';

const bridge = vi.hoisted(() => ({ placeCamera: vi.fn(), getCameraSnapshot: vi.fn(() => ({ position: [0, -10, 0], target: [0, 0, 0] })) }));
vi.mock('@ui/viewport/3d/cameraBridge', () => bridge);

type Listener = (event: { reportId: number; data: DataView }) => void;

interface FakeDevice {
  vendorId: number;
  productId: number;
  productName: string;
  opened: boolean;
  open: Mock;
  close: Mock;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  emit(reportId: number, ...values: number[]): void;
}

function fakeDevice(): FakeDevice {
  const listeners = new Set<Listener>();
  return {
    vendorId: 0x256f,
    productId: 0xc62e,
    productName: 'SpaceMouse Wireless',
    opened: false,
    open: vi.fn(async function (this: { opened: boolean }) {
      this.opened = true;
    }),
    close: vi.fn(async () => undefined),
    addEventListener: (_type: string, listener: Listener) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => void listeners.delete(listener),
    emit(reportId: number, ...values: number[]) {
      const bytes = new Uint8Array(values.length * 2);
      const view = new DataView(bytes.buffer);
      values.forEach((value, index) => view.setInt16(index * 2, value, true));
      listeners.forEach((listener) => listener({ reportId, data: new DataView(bytes.buffer) }));
    },
  };
}

function installHid(devices: FakeDevice[], requested: FakeDevice[] = []): { getDevices: Mock; requestDevice: Mock } {
  const hid = { getDevices: vi.fn(async () => devices), requestDevice: vi.fn(async () => requested) };
  Object.defineProperty(navigator, 'hid', { value: hid, configurable: true });
  return hid;
}

describe('SpaceMouseControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useSpaceMouseStore.setState({ settings: DEFAULT_SETTINGS, status: 'idle', deviceName: null, message: null });
  });
  afterEach(() => {
    delete (navigator as unknown as { hid?: unknown }).hid;
  });

  it('renders nothing where WebHID does not exist', () => {
    const { container } = render(<SpaceMouseControl />);
    expect(container.firstChild).toBeNull();
  });

  it('persists invert / speed / dominant-axis settings per viewer in localStorage', () => {
    installHid([]);
    render(<SpaceMouseControl />);
    fireEvent.click(screen.getByRole('button', { name: '3D mouse settings' }));
    fireEvent.click(screen.getByLabelText('Pan left / right'));
    fireEvent.click(screen.getByLabelText(/Dominant axis only/));
    fireEvent.change(screen.getByLabelText(/Pan speed/), { target: { value: '2.5' } });
    const stored = JSON.parse(localStorage.getItem(SPACE_MOUSE_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored).toMatchObject({ panSpeed: 2.5, dominantAxis: true, invert: { tx: true, ty: false } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(useSpaceMouseStore.getState().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('reconnects a granted device and moves the camera while the cap is held', async () => {
    const device = fakeDevice();
    installHid([device]);
    render(<SpaceMouseControl />);
    await waitFor(() => expect(useSpaceMouseStore.getState().status).toBe('connected'));
    expect(useSpaceMouseStore.getState().deviceName).toBe('SpaceMouse Wireless');

    act(() => device.emit(1, 350, 0, 0));
    await waitFor(() => expect(bridge.placeCamera).toHaveBeenCalled());
    const [position, target] = bridge.placeCamera.mock.calls[0] as [number[], number[]];
    expect(target[0]).toBeGreaterThan(0);
    expect(position[0]).toBeGreaterThan(0);

    act(() => device.emit(1, 0, 0, 0));
  });

  it('connects through the picker on request and reports a failure without crashing', async () => {
    const device = fakeDevice();
    const hid = installHid([], [device]);
    render(<SpaceMouseControl />);
    fireEvent.click(screen.getByRole('button', { name: '3D mouse settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(useSpaceMouseStore.getState().status).toBe('connected'));

    hid.requestDevice.mockRejectedValueOnce(new Error('NotAllowedError'));
    fireEvent.click(screen.getByRole('button', { name: 'Switch device' }));
    await waitFor(() => expect(useSpaceMouseStore.getState().status).toBe('error'));
    expect(screen.getByRole('alert').textContent).toContain('NotAllowedError');
  });
});
