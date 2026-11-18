import { vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { useStore } from '@ui/store';

/** Marks the store connected and answers `POST /command` by running the command in-process (the engine installed with setPhysicsEngine). Returns the restore function. */
export function connectFakeBackend(): () => void {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    const { name, params } = JSON.parse(String(init?.body)) as { name: string; params: Record<string, unknown> };
    const run = execute(useStore.getState().document, name, params);
    return Promise.resolve(
      new Response(JSON.stringify({ summary: run.summary, affected: [], isError: false, data: run.data, canUndo: true, canRedo: false })),
    );
  });
  useStore.setState({ liveStatus: 'connected' });
  return () => {
    fetchSpy.mockRestore();
    useStore.setState({ liveStatus: 'disconnected' });
  };
}
