// The one backend preview session of the viewport, wired to the transport and the preview store. Drags call `request` while they move and
// `cancel` when they end (the commit is the drag's own `dispatch`). A drag that is cancelled or committed also clears the ghost.

import { postPreview } from '@ui/services/previewApi';
import { useRemotePreviewStore } from '@ui/store/remotePreviewStore';
import { createRemotePreview } from './remotePreview';

const preview = createRemotePreview({
  post: postPreview,
  onResult: (body) => useRemotePreviewStore.getState().apply(body),
  onError: (message) => useRemotePreviewStore.getState().setUnavailable(message),
  onPending: () => useRemotePreviewStore.getState().setPending(),
});

export const requestRemotePreview = preview.request;

/** Stop previewing: aborts the request in flight and removes the ghost. */
export function endRemotePreview(): void {
  preview.cancel();
  useRemotePreviewStore.getState().clear();
}
