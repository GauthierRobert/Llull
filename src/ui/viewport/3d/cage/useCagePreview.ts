// Runs the in-flight gesture's command as a local dry run once per animation frame and publishes the ghost to the store.
// The document is never touched; the commit (on release) is the only dispatch.

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { useStore } from '@ui/store';
import { useDirectEditStore } from '@ui/store/directEditStore';
import { createFrameScheduler } from './frameScheduler';
import { gestureCommand } from './gestureCommands';
import { runCagePreview } from './previewRunner';

export function useCagePreview(): void {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const frames = createFrameScheduler(
      (cb) => window.requestAnimationFrame(cb),
      (handle) => window.cancelAnimationFrame(handle),
    );
    const unsubscribe = useDirectEditStore.subscribe((state, previous) => {
      if (state.gesture === previous.gesture) return;
      // Loop cuts have no drag: their hover preview is drawn from the topology, and the commit is a click.
      if (state.gesture === null || state.gesture.kind === 'loop_cut' || state.entityId === null) return;
      const { entityId, gesture, selection, falloff } = state;
      frames.schedule(() => {
        if (useDirectEditStore.getState().gesture !== gesture) return;
        const command = gestureCommand(entityId, gesture, selection, falloff);
        useDirectEditStore.getState().setPreview(command === null ? null : runCagePreview(useStore.getState().document, command));
        invalidate();
      });
    });
    return () => {
      unsubscribe();
      frames.cancel();
    };
  }, [invalidate]);
}
