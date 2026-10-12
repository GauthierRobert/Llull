/**
 * appUpdates (the single service-worker owner) + UpdateBanner: a waiting build shows the banner,
 * Reload posts SKIP_WAITING, and the resulting controller change reloads the page exactly once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

type AppUpdates = typeof import('@ui/services/appUpdates');
type Banner = typeof import('@ui/components/UpdateBanner');

async function load(): Promise<AppUpdates & Banner> {
  vi.resetModules();
  return {
    ...(await import('@ui/services/appUpdates')),
    ...(await import('@ui/components/UpdateBanner')),
  };
}

class FakeWorker extends EventTarget {
  state = 'installing';
  postMessage = vi.fn();
}

interface FakeRegistration extends EventTarget {
  waiting: FakeWorker | null;
  installing: FakeWorker | null;
  update: ReturnType<typeof vi.fn>;
}

function fakeContainer(
  waiting: FakeWorker | null,
  controlled = true,
): { registration: FakeRegistration; container: ServiceWorkerContainer } {
  const registration: FakeRegistration = Object.assign(new EventTarget(), {
    waiting,
    installing: null,
    update: vi.fn(async () => undefined),
  });
  const container = Object.assign(new EventTarget(), {
    controller: controlled ? {} : null,
    register: vi.fn(async () => registration),
  });
  return { registration, container: container as unknown as ServiceWorkerContainer };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('UpdateBanner + appUpdates', () => {
  it('renders nothing and registers nothing without service-worker support', async () => {
    const { registerAppServiceWorker, UpdateBanner } = await load();
    const stop = await registerAppServiceWorker(undefined);
    stop();
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('shows a waiting build; Reload activates it and the controller change reloads once', async () => {
    const { registerAppServiceWorker, UpdateBanner } = await load();
    const waiting = new FakeWorker();
    const { container } = fakeContainer(waiting);
    const reload = vi.fn();
    render(<UpdateBanner />);
    let stop = (): void => undefined;
    await act(async () => {
      stop = await registerAppServiceWorker(container, reload);
    });
    expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(waiting.postMessage).toHaveBeenCalledWith('SKIP_WAITING');
    container.dispatchEvent(new Event('controllerchange'));
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a build installed later becomes available; the first install does not', async () => {
    const { registerAppServiceWorker, useAppUpdateAvailable } = await load();
    function Probe(): React.ReactElement {
      return <output>{useAppUpdateAvailable() ? 'yes' : 'no'}</output>;
    }
    const { registration, container } = fakeContainer(null);
    render(<Probe />);
    await act(async () => {
      await registerAppServiceWorker(container, vi.fn());
    });
    const worker = new FakeWorker();
    registration.installing = worker;
    registration.dispatchEvent(new Event('updatefound'));
    worker.state = 'installed';
    act(() => {
      worker.dispatchEvent(new Event('statechange'));
    });
    expect(screen.getByRole('status').textContent).toBe('yes');

    const first = await load();
    const fresh = fakeContainer(null, false);
    await first.registerAppServiceWorker(fresh.container, vi.fn());
    const firstWorker = new FakeWorker();
    fresh.registration.installing = firstWorker;
    fresh.registration.dispatchEvent(new Event('updatefound'));
    firstWorker.state = 'installed';
    firstWorker.dispatchEvent(new Event('statechange'));
    first.applyAppUpdate();
    expect(firstWorker.postMessage).not.toHaveBeenCalled();
  });

  it('checks for updates every hour until stopped', async () => {
    vi.useFakeTimers();
    const { registerAppServiceWorker } = await load();
    const { registration, container } = fakeContainer(null);
    const stop = await registerAppServiceWorker(container, vi.fn());
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(registration.update).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(registration.update).toHaveBeenCalledTimes(1);
  });
});
