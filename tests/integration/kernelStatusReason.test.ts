import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '@ui/store';
import { useKernelStatusStore } from '@ui/store/kernelStatus';
import { flushPromises, resetOfflineStore } from '../helpers/storeTestHelpers';

function jsonResponse(body: Record<string, unknown>): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body), text: () => Promise.resolve('') });
}

const result = (provenance?: Record<string, unknown>): Record<string, unknown> => ({
  summary: 'done',
  affected: ['box-1'],
  isError: false,
  canUndo: true,
  canRedo: false,
  ...(provenance === undefined ? {} : { provenance }),
});

const degraded = { kernel: 'manifold', exactRequested: true, fallbackReason: 'llull-kernel binary not found' };
const exact = { kernel: 'occt-native', exactRequested: true };

describe('degraded-kernel reason of the status bar', () => {
  beforeEach(() => {
    resetOfflineStore();
    useKernelStatusStore.setState({ degradedReason: null });
    useStore.setState({ liveStatus: 'connected' });
  });
  afterEach(() => vi.unstubAllGlobals());

  const dispatchWith = async (body: Record<string, unknown>): Promise<void> => {
    vi.stubGlobal('fetch', jsonResponse(body));
    useStore.getState().dispatch('mass_properties', { entityId: 'box-1' });
    await flushPromises();
  };

  it('is set by a degraded result and cleared by a later result the exact kernel answered', async () => {
    await dispatchWith(result(degraded));
    expect(useKernelStatusStore.getState().degradedReason).toBe('llull-kernel binary not found');
    await dispatchWith(result());
    expect(useKernelStatusStore.getState().degradedReason).toBe('llull-kernel binary not found');
    await dispatchWith(result(exact));
    expect(useKernelStatusStore.getState().degradedReason).toBeNull();
  });

  it('is re-read from /health when the live connection comes back', async () => {
    useKernelStatusStore.setState({ degradedReason: 'llull-kernel binary not found' });
    useStore.setState({ liveStatus: 'disconnected', sseEverConnected: true });
    vi.stubGlobal('fetch', jsonResponse({ status: 'ok', kernelStatus: { active: 'occt', requested: 'occt' } }));
    useStore.getState().setLiveStatus('connected');
    await flushPromises();
    expect(useKernelStatusStore.getState().degradedReason).toBeNull();
  });

  it('keeps a degradation the restarted backend still reports', async () => {
    useStore.setState({ liveStatus: 'disconnected', sseEverConnected: true });
    vi.stubGlobal('fetch', jsonResponse({ kernelStatus: { active: 'manifold', requested: 'occt', fallbackReason: 'still missing' } }));
    useStore.getState().setLiveStatus('connected');
    await flushPromises();
    expect(useKernelStatusStore.getState().degradedReason).toBe('still missing');
  });
});
