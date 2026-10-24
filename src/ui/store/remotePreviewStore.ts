// The backend dry run of a drag in flight (UI-only, never in the document): the meshes the command WOULD produce, drawn as a ghost, with the
// live entities they replace faded through the shared ghost store. `clear` ends the preview; the commit is a separate `dispatch`.

import { create } from 'zustand';
import type { PreviewResponseBody } from '@protocol/preview';
import { useGhostStore } from './ghostStore';

/** World-space triangles of one previewed entity (9 numbers per triangle). */
export interface PreviewMesh {
  readonly id: string;
  readonly color: string;
  readonly positions: readonly number[];
}

type RemotePreviewStatus = 'idle' | 'pending' | 'ready' | 'refused' | 'unavailable';

interface RemotePreviewState {
  status: RemotePreviewStatus;
  /** The command's own summary, or the reason it is refused / unavailable. */
  summary: string;
  meshes: readonly PreviewMesh[];
  apply(body: PreviewResponseBody): void;
  setPending(): void;
  setUnavailable(message: string): void;
  clear(): void;
}

const GHOST_SOURCE = 'remote-preview';
const NONE: ReadonlySet<string> = new Set();
const IDLE = { status: 'idle', summary: '', meshes: [] } as const;

export const useRemotePreviewStore = create<RemotePreviewState>()((set, get) => ({
  ...IDLE,
  apply(body): void {
    const ok = body.ok;
    useGhostStore.getState().setGhosted(GHOST_SOURCE, ok ? new Set(body.replacedIds) : NONE);
    set({
      status: ok ? 'ready' : 'refused',
      summary: body.summary,
      meshes: ok
        ? body.entities
            .filter((entity) => !entity.truncated && entity.positions.length > 0)
            .map(({ id, color, positions }) => ({ id, color, positions }))
        : [],
    });
  },
  setPending(): void {
    if (get().status === 'idle') set({ status: 'pending' });
  },
  setUnavailable(message): void {
    useGhostStore.getState().setGhosted(GHOST_SOURCE, NONE);
    set({ status: 'unavailable', summary: message, meshes: [] });
  },
  clear(): void {
    useGhostStore.getState().setGhosted(GHOST_SOURCE, NONE);
    set({ ...IDLE });
  },
}));
