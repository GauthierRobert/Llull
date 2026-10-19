// Binds a preview controller to the store: dry runs read the live document, outcomes land in the preview store, commit dispatches.

import { useEffect, useMemo } from 'react';
import { useStore } from '@ui/store';
import { usePreviewStore, type PreviewTone } from '@ui/store/previewStore';
import { type PreviewController, createPreviewController } from './previewController';
import { runPreview } from './runPreview';

export function usePreviewController(tone: PreviewTone = 'add'): PreviewController {
  const controller = useMemo(
    () =>
      createPreviewController({
        getDocument: () => useStore.getState().document,
        run: runPreview,
        dispatch: (name, params, options) => useStore.getState().dispatch(name, params, options),
        onOutcome: (outcome) => usePreviewStore.getState().setOutcome(outcome, tone),
      }),
    [tone],
  );
  useEffect(() => () => controller.cancel(), [controller]);
  return controller;
}
