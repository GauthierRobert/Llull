// Turns every document change (any command, any caller) into a live-effects plan: subscribed outside React, so a burst
// of /live events costs one diff each and never re-renders the shell.

import { useEffect } from 'react';
import { useStore } from '@ui/store';
import { useLiveFxStore } from '@ui/store/liveFxStore';
import { consumeLiveOrigin } from '@ui/store/liveOrigin';
import { planLiveFx } from '@ui/viewport/liveFx/planLiveFx';

export function useLiveFx(): void {
  useEffect(() => {
    let seq = 0;
    return useStore.subscribe((state, previous) => {
      if (state.document.entities === previous.document.entities) return;
      seq += 1;
      useLiveFxStore.getState().apply(planLiveFx(previous.document, state.document, consumeLiveOrigin(), performance.now(), seq));
    });
  }, []);
}
